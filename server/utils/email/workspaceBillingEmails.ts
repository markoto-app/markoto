import { and, eq, isNotNull } from 'drizzle-orm'
import { users, workspaceMembers, workspaces } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { useValkey } from '../platform/valkey'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { safeSendTransactionalEmail } from './sendEmail'
import { normaliseInviteLocale, type InviteEmailLocale } from '../workspaces/workspaceInvites'

// Billing emails to a Team / Business workspace's admins (WP3):
//   budget_80 / budget_100 — the workspace's AI budget is 80 % / fully used
//   payment_failed         — Stripe couldn't charge (first failure only)
//   seat_added             — another admin added a seat (to the billing admin)
//   ending / ended         — the subscription won't renew / has ended
// Plain text, localised per recipient (`users.locale`), link to the
// workspace's billing tab. Members never get billing emails.
//
// `onceKey` (Valkey SET NX, 45 days) makes an email at-most-once per
// period / subscription, so a retried webhook or a sweep that runs
// every 15 minutes doesn't repeat it. Fire-and-forget: a failure never
// fails the caller.

export type WorkspaceBillingEmail = 'budget_80' | 'budget_100' | 'payment_failed' | 'seat_added' | 'ending' | 'ended'

interface Vars {
  workspace: string
  date?: string
  seats?: number
  actor?: string
}

type Copy = Record<WorkspaceBillingEmail, { subject: (v: Vars) => string, body: (v: Vars) => string }> & { link: string, footer: string }

const COPY: Record<InviteEmailLocale, Copy> = {
  en: {
    budget_80: { subject: v => `"${v.workspace}" has used 80% of this month's AI budget`, body: v => `The workspace "${v.workspace}" has used 80% of its AI budget for this month. When it's used up, AI stops for everyone in the workspace until the budget resets. You can add seats to raise it.` },
    budget_100: { subject: v => `"${v.workspace}" has used its AI budget for this month`, body: v => `The workspace "${v.workspace}" has used its whole AI budget for this month. AI is paused for its members until the budget resets${v.date ? ` on ${v.date}` : ''}. Adding seats raises it right away.` },
    payment_failed: { subject: v => `Payment for "${v.workspace}" failed`, body: v => `Stripe couldn't take the payment for the workspace "${v.workspace}". It will try again over the next days. Please update the payment method so the workspace keeps its plan.` },
    seat_added: { subject: v => `A seat was added to "${v.workspace}"`, body: v => `${v.actor ?? 'An admin'} added a seat to the workspace "${v.workspace}" to invite someone. It now has ${v.seats} seats; the extra seat is charged pro rata on the next invoice.` },
    ending: { subject: v => `The plan of "${v.workspace}" will end`, body: v => `The subscription of the workspace "${v.workspace}" won't renew${v.date ? ` and ends on ${v.date}` : ''}. After that the workspace goes back to the free plan; nothing is deleted.` },
    ended: { subject: v => `The plan of "${v.workspace}" has ended`, body: v => `The subscription of the workspace "${v.workspace}" has ended. The workspace is back on the free plan; nothing was deleted. You can buy Team or Business again on the billing tab.` },
    link: 'Billing:',
    footer: 'You get this email because you are an admin of this workspace on markoto.'
  },
  de: {
    budget_80: { subject: v => `«${v.workspace}» hat 80 % des KI-Budgets dieses Monats verbraucht`, body: v => `Der Arbeitsbereich «${v.workspace}» hat 80 % seines KI-Budgets für diesen Monat verbraucht. Ist es aufgebraucht, pausiert die KI für alle im Arbeitsbereich bis zur Zurücksetzung. Mit zusätzlichen Plätzen erhöhen Sie es.` },
    budget_100: { subject: v => `«${v.workspace}» hat sein KI-Budget für diesen Monat verbraucht`, body: v => `Der Arbeitsbereich «${v.workspace}» hat sein ganzes KI-Budget für diesen Monat verbraucht. Die KI pausiert für seine Mitglieder bis zur Zurücksetzung${v.date ? ` am ${v.date}` : ''}. Zusätzliche Plätze erhöhen es sofort.` },
    payment_failed: { subject: v => `Zahlung für «${v.workspace}» fehlgeschlagen`, body: v => `Stripe konnte die Zahlung für den Arbeitsbereich «${v.workspace}» nicht einziehen und versucht es in den nächsten Tagen erneut. Bitte aktualisieren Sie die Zahlungsmethode, damit der Arbeitsbereich seinen Plan behält.` },
    seat_added: { subject: v => `Ein Platz wurde zu «${v.workspace}» hinzugefügt`, body: v => `${v.actor ?? 'Ein Admin'} hat dem Arbeitsbereich «${v.workspace}» einen Platz hinzugefügt, um jemanden einzuladen. Er hat jetzt ${v.seats} Plätze; der zusätzliche Platz wird anteilig auf der nächsten Rechnung berechnet.` },
    ending: { subject: v => `Der Plan von «${v.workspace}» endet`, body: v => `Das Abonnement des Arbeitsbereichs «${v.workspace}» verlängert sich nicht${v.date ? ` und endet am ${v.date}` : ''}. Danach gilt wieder der kostenlose Plan; es wird nichts gelöscht.` },
    ended: { subject: v => `Der Plan von «${v.workspace}» ist beendet`, body: v => `Das Abonnement des Arbeitsbereichs «${v.workspace}» ist beendet. Es gilt wieder der kostenlose Plan; es wurde nichts gelöscht. Team oder Business können Sie im Tab «Abrechnung» wieder kaufen.` },
    link: 'Abrechnung:',
    footer: 'Sie erhalten diese E-Mail, weil Sie Admin dieses Arbeitsbereichs auf markoto sind.'
  },
  fr: {
    budget_80: { subject: v => `« ${v.workspace} » a utilisé 80 % du budget IA du mois`, body: v => `L’espace de travail « ${v.workspace} » a utilisé 80 % de son budget IA pour ce mois. Une fois épuisé, l’IA s’arrête pour tout l’espace jusqu’à la remise à zéro. Ajouter des places l’augmente.` },
    budget_100: { subject: v => `« ${v.workspace} » a épuisé son budget IA du mois`, body: v => `L’espace de travail « ${v.workspace} » a utilisé tout son budget IA pour ce mois. L’IA est en pause pour ses membres jusqu’à la remise à zéro${v.date ? ` le ${v.date}` : ''}. Ajouter des places l’augmente immédiatement.` },
    payment_failed: { subject: v => `Échec du paiement pour « ${v.workspace} »`, body: v => `Stripe n’a pas pu encaisser le paiement de l’espace « ${v.workspace} » et réessaiera dans les prochains jours. Mettez à jour le moyen de paiement pour que l’espace conserve son plan.` },
    seat_added: { subject: v => `Une place a été ajoutée à « ${v.workspace} »`, body: v => `${v.actor ?? 'Un admin'} a ajouté une place à l’espace « ${v.workspace} » pour inviter quelqu’un. Il compte maintenant ${v.seats} places ; la place supplémentaire est facturée au prorata sur la prochaine facture.` },
    ending: { subject: v => `Le plan de « ${v.workspace} » va se terminer`, body: v => `L’abonnement de l’espace « ${v.workspace} » ne sera pas renouvelé${v.date ? ` et se termine le ${v.date}` : ''}. L’espace repassera ensuite au plan gratuit ; rien n’est supprimé.` },
    ended: { subject: v => `Le plan de « ${v.workspace} » est terminé`, body: v => `L’abonnement de l’espace « ${v.workspace} » est terminé. L’espace est revenu au plan gratuit ; rien n’a été supprimé. Vous pouvez reprendre Team ou Business dans l’onglet Facturation.` },
    link: 'Facturation :',
    footer: 'Vous recevez cet e-mail parce que vous êtes admin de cet espace de travail sur markoto.'
  },
  es: {
    budget_80: { subject: v => `«${v.workspace}» ha usado el 80 % del presupuesto de IA del mes`, body: v => `El espacio de trabajo «${v.workspace}» ha usado el 80 % de su presupuesto de IA de este mes. Cuando se agote, la IA se detiene para todo el espacio hasta que se reinicie. Añadir puestos lo aumenta.` },
    budget_100: { subject: v => `«${v.workspace}» ha agotado su presupuesto de IA del mes`, body: v => `El espacio de trabajo «${v.workspace}» ha usado todo su presupuesto de IA de este mes. La IA queda en pausa para sus miembros hasta que se reinicie${v.date ? ` el ${v.date}` : ''}. Añadir puestos lo aumenta al momento.` },
    payment_failed: { subject: v => `Falló el pago de «${v.workspace}»`, body: v => `Stripe no pudo cobrar el pago del espacio «${v.workspace}» y lo volverá a intentar en los próximos días. Actualiza el método de pago para que el espacio conserve su plan.` },
    seat_added: { subject: v => `Se añadió un puesto a «${v.workspace}»`, body: v => `${v.actor ?? 'Un admin'} añadió un puesto al espacio «${v.workspace}» para invitar a alguien. Ahora tiene ${v.seats} puestos; el puesto adicional se cobra de forma proporcional en la próxima factura.` },
    ending: { subject: v => `El plan de «${v.workspace}» va a terminar`, body: v => `La suscripción del espacio «${v.workspace}» no se renovará${v.date ? ` y termina el ${v.date}` : ''}. Después el espacio vuelve al plan gratuito; no se borra nada.` },
    ended: { subject: v => `El plan de «${v.workspace}» ha terminado`, body: v => `La suscripción del espacio «${v.workspace}» ha terminado. El espacio ha vuelto al plan gratuito; no se ha borrado nada. Puedes volver a comprar Team o Business en la pestaña Facturación.` },
    link: 'Facturación:',
    footer: 'Recibes este correo porque eres admin de este espacio de trabajo en markoto.'
  },
  ja: {
    budget_80: { subject: v => `「${v.workspace}」が今月の AI 予算の 80% を使用しました`, body: v => `ワークスペース「${v.workspace}」は今月の AI 予算の 80% を使用しました。使い切ると、リセットまでワークスペースの全員の AI が止まります。席数を増やすと予算が増えます。` },
    budget_100: { subject: v => `「${v.workspace}」が今月の AI 予算を使い切りました`, body: v => `ワークスペース「${v.workspace}」は今月の AI 予算をすべて使用しました。${v.date ? `${v.date} の` : ''}リセットまでメンバーの AI は一時停止します。席数を増やすとすぐに予算が増えます。` },
    payment_failed: { subject: v => `「${v.workspace}」の支払いに失敗しました`, body: v => `Stripe はワークスペース「${v.workspace}」の支払いを受け取れませんでした。数日のうちに再試行します。ワークスペースのプランを維持するため、支払い方法を更新してください。` },
    seat_added: { subject: v => `「${v.workspace}」に席が追加されました`, body: v => `${v.actor ?? '管理者'}が招待のためにワークスペース「${v.workspace}」に席を追加しました。現在の席数は ${v.seats} です。追加分は次回の請求で日割り計算されます。` },
    ending: { subject: v => `「${v.workspace}」のプランが終了します`, body: v => `ワークスペース「${v.workspace}」のサブスクリプションは更新されません${v.date ? `（${v.date} に終了）` : ''}。その後は無料プランに戻ります。何も削除されません。` },
    ended: { subject: v => `「${v.workspace}」のプランが終了しました`, body: v => `ワークスペース「${v.workspace}」のサブスクリプションが終了し、無料プランに戻りました。何も削除されていません。請求タブから Team または Business を再度購入できます。` },
    link: '請求：',
    footer: 'このメールは、あなたが markoto のこのワークスペースの管理者であるため送信されています。'
  },
  zh: {
    budget_80: { subject: v => `“${v.workspace}”已使用本月 AI 预算的 80%`, body: v => `工作区“${v.workspace}”已使用本月 AI 预算的 80%。预算用完后，工作区内所有人的 AI 都会暂停，直到重置。增加席位可以提高预算。` },
    budget_100: { subject: v => `“${v.workspace}”已用完本月 AI 预算`, body: v => `工作区“${v.workspace}”已用完本月全部 AI 预算。成员的 AI 将暂停，直到${v.date ? ` ${v.date} ` : ''}重置。增加席位可立即提高预算。` },
    payment_failed: { subject: v => `“${v.workspace}”付款失败`, body: v => `Stripe 未能收取工作区“${v.workspace}”的款项，将在接下来几天重试。请更新付款方式，以保留工作区的方案。` },
    seat_added: { subject: v => `已为“${v.workspace}”增加一个席位`, body: v => `${v.actor ?? '一位管理员'}为邀请他人在工作区“${v.workspace}”增加了一个席位，现在共有 ${v.seats} 个席位；新增席位将按比例计入下一张账单。` },
    ending: { subject: v => `“${v.workspace}”的方案即将结束`, body: v => `工作区“${v.workspace}”的订阅不会续订${v.date ? `，将于 ${v.date} 结束` : ''}。之后工作区将恢复为免费方案，不会删除任何内容。` },
    ended: { subject: v => `“${v.workspace}”的方案已结束`, body: v => `工作区“${v.workspace}”的订阅已结束，已恢复为免费方案，未删除任何内容。你可以在账单标签页重新购买 Team 或 Business。` },
    link: '账单：',
    footer: '你收到此邮件是因为你是 markoto 上该工作区的管理员。'
  }
}

/** Pure: subject + body of one billing email. */
export function buildWorkspaceBillingEmail(kind: WorkspaceBillingEmail, locale: InviteEmailLocale, vars: Vars, billingUrl: string | null): { subject: string, body: string } {
  const copy = COPY[locale]
  const workspace = vars.workspace.length > 80 ? `${vars.workspace.slice(0, 79)}…` : vars.workspace
  const v = { ...vars, workspace }
  const lines = [copy[kind].body(v)]
  if (billingUrl) lines.push('', copy.link, billingUrl)
  lines.push('', copy.footer)
  return { subject: copy[kind].subject(v), body: lines.join('\n') }
}

const ONCE_TTL_SECONDS = 45 * 24 * 3600

/**
 * Email the workspace's admins (or only `onlyUserIds`). With `onceKey`
 * the email goes out at most once for that key. Never throws.
 */
export async function notifyWorkspaceAdmins(args: {
  workspaceId: string
  kind: WorkspaceBillingEmail
  vars?: Omit<Vars, 'workspace'>
  onlyUserIds?: number[]
  excludeUserIds?: number[]
  onceKey?: string
  /** Date to render (localised per recipient). */
  date?: Date | null
}): Promise<number> {
  try {
    if (args.onceKey) {
      const claimed = await useValkey().set(`ws-billing-email:${args.onceKey}`, '1', 'EX', ONCE_TTL_SECONDS, 'NX')
      if (claimed !== 'OK') return 0
    }
    const db = useDatabase()
    const ws = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.workspaceId, args.workspaceId)).limit(1))[0]
    if (!ws) return 0
    const admins = await db
      .select({ id: users.id, email: users.email, locale: users.locale })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, args.workspaceId), eq(workspaceMembers.role, 'admin'), isNotNull(users.email)))
    const base = emailLinkBaseUrl(useRuntimeConfig().siteUrl)
    const billingUrl = base ? `${base}/w/${encodeURIComponent(args.workspaceId)}?tab=billing` : null
    let sent = 0
    for (const admin of admins) {
      if (args.onlyUserIds && !args.onlyUserIds.includes(admin.id)) continue
      if (args.excludeUserIds?.includes(admin.id)) continue
      const locale = normaliseInviteLocale(admin.locale)
      const date = args.date ? args.date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }) : undefined
      const content = buildWorkspaceBillingEmail(args.kind, locale, { workspace: ws.name, ...args.vars, date }, billingUrl)
      void safeSendTransactionalEmail({
        kind: 'workspace.billing',
        to: admin.email,
        locale,
        subject: content.subject,
        body: content.body,
        metadata: { event: args.kind }
      })
      sent++
    }
    return sent
  } catch (e) {
    console.warn(`[workspaceBillingEmails] ${args.kind} for ${args.workspaceId} failed: ${e instanceof Error ? e.message : e}`)
    return 0
  }
}
