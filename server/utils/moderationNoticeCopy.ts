import type { ModerationAction, ModerationRule } from '~~/shared/config/moderation'

// Localised plain-text copy of the three notice emails of the abuse
// pipeline. Server-side (outside the Vue i18n runtime), like the waitlist
// email. Rendered by server/utils/moderationNotices.ts.
//
//   receipt              → reporter, on submission      (DSA Art.16(4))
//   decision             → reporter, when decided        (DSA Art.16(5))
//   statement of reasons → document owner, when content
//                          is removed or restricted      (DSA Art.17)

export const NOTICE_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type NoticeLocale = typeof NOTICE_LOCALES[number]

export function normaliseNoticeLocale(raw: unknown): NoticeLocale {
  const short = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 2) : ''
  return NOTICE_LOCALES.find(l => l === short) ?? 'en'
}

interface NoticeCopy {
  rules: Record<ModerationRule, string>
  actions: Record<ModerationAction, string>
  receiptSubject: (reportId: string) => string
  receiptBody: string
  decisionSubject: (reportId: string) => string
  decisionIntro: string
  statementSubject: string
  statementIntro: string
  labels: {
    reference: string
    reported: string
    document: string
    decision: string
    rule: string
    reasons: string
    decidedAt: string
    basis: string
    automation: string
    scope: string
    objection: string
  }
  basisText: string
  automationText: string
  scopeText: string
  objectionText: (contact: string) => string
  objectionNoContact: string
  closing: string
}

const EN: NoticeCopy = {
  rules: {
    illegal_content: 'Illegal content',
    csam: 'Child sexual abuse material',
    phishing_or_fraud: 'Phishing, scams or fraud',
    malware: 'Malware or harmful downloads',
    spam_or_seo: 'Spam or search-engine manipulation',
    copyright: 'Copyright or other intellectual-property infringement',
    harassment_or_hate: 'Harassment, threats or hate speech',
    privacy_violation: 'Publishing other people\'s personal data',
    other_terms: 'Other breach of the Terms of Service'
  },
  actions: {
    content_removed: 'The document was removed.',
    access_restricted: 'Access to the document was restricted: it is no longer reachable by link.',
    no_action: 'We reviewed the document and took no action.'
  },
  receiptSubject: id => `We received your report (${id})`,
  receiptBody: 'Thank you. We received your report and will review it. We will email you our decision at this address.',
  decisionSubject: id => `Decision on your report (${id})`,
  decisionIntro: 'We reviewed the content you reported. This is our decision.',
  statementSubject: 'We removed or restricted one of your markoto documents',
  statementIntro: 'We received a report about one of your documents on markoto and reviewed it. This is our statement of reasons.',
  labels: {
    reference: 'Reference',
    reported: 'Reported content',
    document: 'Document',
    decision: 'Decision',
    rule: 'Rule',
    reasons: 'Reasons',
    decidedAt: 'Decided on',
    basis: 'Basis',
    automation: 'Automated means',
    scope: 'Scope',
    objection: 'How to object'
  },
  basisText: 'The decision is based on a report we received (a notice under Art. 16 of the EU Digital Services Act). It applies our Terms of Service and Acceptable Use rules; where the rule is "illegal content", we also consider the content illegal.',
  automationText: 'None. A person reviewed the report and made this decision.',
  scopeText: 'The document on markoto everywhere (worldwide).',
  objectionText: contact => `If you think this decision is wrong, reply to ${contact} within 6 months and quote the reference above. You may also use an out-of-court dispute settlement body or go to court.`,
  objectionNoContact: 'If you think this decision is wrong, contact the operator of this service within 6 months and quote the reference above. You may also use an out-of-court dispute settlement body or go to court.',
  closing: 'markoto'
}

const DE: NoticeCopy = {
  rules: {
    illegal_content: 'Rechtswidrige Inhalte',
    csam: 'Darstellungen sexuellen Kindesmissbrauchs',
    phishing_or_fraud: 'Phishing, Betrug oder Täuschung',
    malware: 'Schadsoftware oder schädliche Downloads',
    spam_or_seo: 'Spam oder Suchmaschinen-Manipulation',
    copyright: 'Verletzung von Urheber- oder anderen Schutzrechten',
    harassment_or_hate: 'Belästigung, Drohungen oder Hassrede',
    privacy_violation: 'Veröffentlichung personenbezogener Daten anderer',
    other_terms: 'Anderer Verstoss gegen die Nutzungsbedingungen'
  },
  actions: {
    content_removed: 'Das Dokument wurde entfernt.',
    access_restricted: 'Der Zugang zum Dokument wurde eingeschränkt: Es ist über den Link nicht mehr erreichbar.',
    no_action: 'Wir haben das Dokument geprüft und nichts unternommen.'
  },
  receiptSubject: id => `Wir haben Ihre Meldung erhalten (${id})`,
  receiptBody: 'Danke. Wir haben Ihre Meldung erhalten und prüfen sie. Unsere Entscheidung senden wir an diese Adresse.',
  decisionSubject: id => `Entscheidung zu Ihrer Meldung (${id})`,
  decisionIntro: 'Wir haben den gemeldeten Inhalt geprüft. Das ist unsere Entscheidung.',
  statementSubject: 'Wir haben eines Ihrer markoto-Dokumente entfernt oder eingeschränkt',
  statementIntro: 'Wir haben eine Meldung zu einem Ihrer Dokumente auf markoto erhalten und geprüft. Hier ist unsere Begründung.',
  labels: {
    reference: 'Referenz',
    reported: 'Gemeldeter Inhalt',
    document: 'Dokument',
    decision: 'Entscheidung',
    rule: 'Regel',
    reasons: 'Begründung',
    decidedAt: 'Entschieden am',
    basis: 'Grundlage',
    automation: 'Automatisierte Mittel',
    scope: 'Geltungsbereich',
    objection: 'Widerspruch'
  },
  basisText: 'Die Entscheidung beruht auf einer Meldung, die wir erhalten haben (Meldung nach Art. 16 des EU-Gesetzes über digitale Dienste). Sie wendet unsere Nutzungsbedingungen und Regeln zur zulässigen Nutzung an; lautet die Regel «Rechtswidrige Inhalte», halten wir den Inhalt zudem für rechtswidrig.',
  automationText: 'Keine. Eine Person hat die Meldung geprüft und entschieden.',
  scopeText: 'Das Dokument auf markoto, überall (weltweit).',
  objectionText: contact => `Wenn Sie die Entscheidung für falsch halten, schreiben Sie innert 6 Monaten an ${contact} und nennen Sie die Referenz oben. Sie können auch eine aussergerichtliche Streitbeilegungsstelle anrufen oder vor Gericht gehen.`,
  objectionNoContact: 'Wenn Sie die Entscheidung für falsch halten, wenden Sie sich innert 6 Monaten an den Betreiber dieses Dienstes und nennen Sie die Referenz oben. Sie können auch eine aussergerichtliche Streitbeilegungsstelle anrufen oder vor Gericht gehen.',
  closing: 'markoto'
}

const FR: NoticeCopy = {
  rules: {
    illegal_content: 'Contenu illicite',
    csam: 'Matériel pédopornographique',
    phishing_or_fraud: 'Hameçonnage, arnaque ou fraude',
    malware: 'Logiciel malveillant ou téléchargement dangereux',
    spam_or_seo: 'Spam ou manipulation des moteurs de recherche',
    copyright: 'Atteinte au droit d\'auteur ou à d\'autres droits de propriété intellectuelle',
    harassment_or_hate: 'Harcèlement, menaces ou discours haineux',
    privacy_violation: 'Publication de données personnelles d\'autrui',
    other_terms: 'Autre violation des conditions d\'utilisation'
  },
  actions: {
    content_removed: 'Le document a été supprimé.',
    access_restricted: 'L\'accès au document a été restreint : il n\'est plus accessible par lien.',
    no_action: 'Nous avons examiné le document et n\'avons pris aucune mesure.'
  },
  receiptSubject: id => `Nous avons reçu votre signalement (${id})`,
  receiptBody: 'Merci. Nous avons reçu votre signalement et allons l\'examiner. Nous vous enverrons notre décision à cette adresse.',
  decisionSubject: id => `Décision concernant votre signalement (${id})`,
  decisionIntro: 'Nous avons examiné le contenu que vous avez signalé. Voici notre décision.',
  statementSubject: 'Nous avons supprimé ou restreint l\'un de vos documents markoto',
  statementIntro: 'Nous avons reçu un signalement concernant l\'un de vos documents sur markoto et l\'avons examiné. Voici l\'exposé de nos motifs.',
  labels: {
    reference: 'Référence',
    reported: 'Contenu signalé',
    document: 'Document',
    decision: 'Décision',
    rule: 'Règle',
    reasons: 'Motifs',
    decidedAt: 'Décidé le',
    basis: 'Fondement',
    automation: 'Moyens automatisés',
    scope: 'Portée',
    objection: 'Comment contester'
  },
  basisText: 'La décision repose sur un signalement reçu (notification au sens de l\'art. 16 du règlement européen sur les services numériques). Elle applique nos conditions d\'utilisation et nos règles d\'utilisation acceptable ; lorsque la règle est « Contenu illicite », nous considérons en outre le contenu comme illicite.',
  automationText: 'Aucun. Une personne a examiné le signalement et pris cette décision.',
  scopeText: 'Le document sur markoto, partout (monde entier).',
  objectionText: contact => `Si vous estimez que cette décision est erronée, écrivez à ${contact} dans un délai de 6 mois en indiquant la référence ci-dessus. Vous pouvez aussi saisir un organisme de règlement extrajudiciaire des litiges ou un tribunal.`,
  objectionNoContact: 'Si vous estimez que cette décision est erronée, contactez l\'exploitant de ce service dans un délai de 6 mois en indiquant la référence ci-dessus. Vous pouvez aussi saisir un organisme de règlement extrajudiciaire des litiges ou un tribunal.',
  closing: 'markoto'
}

const ES: NoticeCopy = {
  rules: {
    illegal_content: 'Contenido ilícito',
    csam: 'Material de abuso sexual infantil',
    phishing_or_fraud: 'Phishing, estafa o fraude',
    malware: 'Malware o descargas dañinas',
    spam_or_seo: 'Spam o manipulación de buscadores',
    copyright: 'Infracción de derechos de autor u otros derechos de propiedad intelectual',
    harassment_or_hate: 'Acoso, amenazas o discurso de odio',
    privacy_violation: 'Publicación de datos personales de otras personas',
    other_terms: 'Otro incumplimiento de las condiciones de uso'
  },
  actions: {
    content_removed: 'El documento se ha eliminado.',
    access_restricted: 'Se ha restringido el acceso al documento: ya no se puede abrir mediante el enlace.',
    no_action: 'Hemos revisado el documento y no hemos tomado ninguna medida.'
  },
  receiptSubject: id => `Hemos recibido tu denuncia (${id})`,
  receiptBody: 'Gracias. Hemos recibido tu denuncia y la revisaremos. Te enviaremos nuestra decisión a esta dirección.',
  decisionSubject: id => `Decisión sobre tu denuncia (${id})`,
  decisionIntro: 'Hemos revisado el contenido que denunciaste. Esta es nuestra decisión.',
  statementSubject: 'Hemos eliminado o restringido uno de tus documentos de markoto',
  statementIntro: 'Recibimos una denuncia sobre uno de tus documentos en markoto y la revisamos. Esta es la exposición de nuestros motivos.',
  labels: {
    reference: 'Referencia',
    reported: 'Contenido denunciado',
    document: 'Documento',
    decision: 'Decisión',
    rule: 'Norma',
    reasons: 'Motivos',
    decidedAt: 'Fecha de la decisión',
    basis: 'Fundamento',
    automation: 'Medios automatizados',
    scope: 'Alcance',
    objection: 'Cómo reclamar'
  },
  basisText: 'La decisión se basa en una denuncia que recibimos (notificación según el art. 16 del Reglamento de Servicios Digitales de la UE). Aplica nuestras condiciones de uso y normas de uso aceptable; cuando la norma es «Contenido ilícito», además consideramos ilícito el contenido.',
  automationText: 'Ninguno. Una persona revisó la denuncia y tomó esta decisión.',
  scopeText: 'El documento en markoto, en todas partes (todo el mundo).',
  objectionText: contact => `Si crees que esta decisión es errónea, escribe a ${contact} en un plazo de 6 meses indicando la referencia de arriba. También puedes acudir a un órgano de resolución extrajudicial de litigios o a los tribunales.`,
  objectionNoContact: 'Si crees que esta decisión es errónea, ponte en contacto con el operador de este servicio en un plazo de 6 meses indicando la referencia de arriba. También puedes acudir a un órgano de resolución extrajudicial de litigios o a los tribunales.',
  closing: 'markoto'
}

const JA: NoticeCopy = {
  rules: {
    illegal_content: '違法なコンテンツ',
    csam: '児童の性的虐待コンテンツ',
    phishing_or_fraud: 'フィッシング・詐欺',
    malware: 'マルウェア・有害なダウンロード',
    spam_or_seo: 'スパム・検索エンジンの操作',
    copyright: '著作権その他の知的財産権の侵害',
    harassment_or_hate: '嫌がらせ・脅迫・ヘイトスピーチ',
    privacy_violation: '他人の個人情報の公開',
    other_terms: 'その他の利用規約違反'
  },
  actions: {
    content_removed: 'ドキュメントを削除しました。',
    access_restricted: 'ドキュメントへのアクセスを制限しました。リンクから開くことはできなくなりました。',
    no_action: 'ドキュメントを確認しましたが、措置は取りませんでした。'
  },
  receiptSubject: id => `通報を受け付けました（${id}）`,
  receiptBody: 'ご連絡ありがとうございます。通報を受け付けました。内容を確認し、結果をこのアドレスにお知らせします。',
  decisionSubject: id => `通報への対応結果（${id}）`,
  decisionIntro: '通報いただいたコンテンツを確認しました。対応結果は次のとおりです。',
  statementSubject: 'markoto のドキュメントを削除または制限しました',
  statementIntro: 'markoto 上のあなたのドキュメントについて通報を受け、確認しました。理由は次のとおりです。',
  labels: {
    reference: '参照番号',
    reported: '通報されたコンテンツ',
    document: 'ドキュメント',
    decision: '対応',
    rule: '該当する規則',
    reasons: '理由',
    decidedAt: '決定日',
    basis: '根拠',
    automation: '自動化された手段',
    scope: '範囲',
    objection: '異議の申し立て'
  },
  basisText: 'この決定は、受け付けた通報（EU デジタルサービス法第 16 条に基づく通知）に基づくものです。利用規約と許容される利用に関する規則を適用しています。規則が「違法なコンテンツ」の場合は、そのコンテンツを違法と判断しています。',
  automationText: 'ありません。担当者が通報を確認し、判断しました。',
  scopeText: 'markoto 上のドキュメント全体（全世界）。',
  objectionText: contact => `この決定が誤りだとお考えの場合は、6 か月以内に上記の参照番号を添えて ${contact} までご連絡ください。裁判外紛争解決機関や裁判所を利用することもできます。`,
  objectionNoContact: 'この決定が誤りだとお考えの場合は、6 か月以内に上記の参照番号を添えて本サービスの運営者にご連絡ください。裁判外紛争解決機関や裁判所を利用することもできます。',
  closing: 'markoto'
}

const ZH: NoticeCopy = {
  rules: {
    illegal_content: '违法内容',
    csam: '儿童性虐待材料',
    phishing_or_fraud: '网络钓鱼、诈骗或欺诈',
    malware: '恶意软件或有害下载',
    spam_or_seo: '垃圾信息或操纵搜索引擎',
    copyright: '侵犯著作权或其他知识产权',
    harassment_or_hate: '骚扰、威胁或仇恨言论',
    privacy_violation: '公开他人的个人信息',
    other_terms: '其他违反服务条款的行为'
  },
  actions: {
    content_removed: '该文档已被删除。',
    access_restricted: '该文档的访问已受限：无法再通过链接打开。',
    no_action: '我们已审核该文档，未采取任何措施。'
  },
  receiptSubject: id => `我们已收到你的举报（${id}）`,
  receiptBody: '谢谢。我们已收到你的举报，会进行审核，并将处理结果发送到此邮箱。',
  decisionSubject: id => `你的举报的处理结果（${id}）`,
  decisionIntro: '我们已审核你举报的内容。处理结果如下。',
  statementSubject: '我们删除或限制了你的一个 markoto 文档',
  statementIntro: '我们收到了关于你在 markoto 上某个文档的举报并进行了审核。以下是我们的理由说明。',
  labels: {
    reference: '编号',
    reported: '被举报的内容',
    document: '文档',
    decision: '处理结果',
    rule: '依据的规则',
    reasons: '理由',
    decidedAt: '决定日期',
    basis: '依据',
    automation: '自动化手段',
    scope: '范围',
    objection: '如何申诉'
  },
  basisText: '该决定基于我们收到的举报（依据欧盟《数字服务法》第 16 条提交的通知），适用我们的服务条款和可接受使用规则；若规则为“违法内容”，我们还认定该内容违法。',
  automationText: '无。由工作人员审核举报并作出决定。',
  scopeText: 'markoto 上的该文档，适用于所有地区（全球）。',
  objectionText: contact => `如果你认为该决定有误，请在 6 个月内发送邮件至 ${contact}，并注明上方编号。你也可以通过庭外争议解决机构或法院寻求救济。`,
  objectionNoContact: '如果你认为该决定有误，请在 6 个月内联系本服务的运营方，并注明上方编号。你也可以通过庭外争议解决机构或法院寻求救济。',
  closing: 'markoto'
}

export const NOTICE_COPY: Record<NoticeLocale, NoticeCopy> = { en: EN, de: DE, fr: FR, es: ES, ja: JA, zh: ZH }
