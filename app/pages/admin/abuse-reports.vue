<script setup lang="ts">
// Admin queue for incoming abuse reports. Login + admin-allowlist
// gated server-side; the page itself does a defensive client-side
// check via account-status so non-admin users land on a clean
// 403-ish empty state rather than the queue UI.
//
// Surfaces:
//   - Status filter (open / acknowledged / actioned / dismissed / all)
//   - Per-report card with category pill, reporter id, doc id link,
//     full body, action buttons (Acknowledge / Action / Dismiss).
//   - Notes input attached to action submission for the audit row.
//
// Backwards transitions (closed → open) are intentionally NOT
// supported — see the endpoint comment.

import type { ApiResponse } from '~/utils/api/client'
import { MODERATION_RULES, isModerationRule, type ModerationRule } from '~~/shared/config/moderation'

type AbuseReport = ApiResponse<'/api/admin/abuse-reports', 'get'>[number]
type ModerationNotice = AbuseReport['notices'][number]

const router = useRouter()
const { t } = useI18n()
const { loggedIn } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()
const { status: accountStatus } = useAccountStatus()
const toast = useToast()
const { extractError } = useErrorHandler()

useHead({ title: 'Abuse reports · Admin' })

// Anonymous → home. Non-admin → home. The endpoint guards
// regardless, but the redirect saves a wasted page-mount.
if (import.meta.client) {
  watchEffect(() => {
    if (!loggedIn.value) {
      globalThis.location.href = primaryLoginPath.value ?? '/'
    } else if (accountStatus.value && !accountStatus.value.isAdmin) {
      void router.push('/')
    }
  })
}

type StatusFilter = 'open' | 'acknowledged' | 'actioned' | 'dismissed' | 'open+acknowledged' | 'all'
const filter = ref<StatusFilter>('open+acknowledged')
const reports = ref<AbuseReport[]>([])
const loading = ref(false)
const noteDrafts = ref<Record<string, string>>({})
// Decision drafts per report. The explanation and rule are SENT (to the
// reporter, and to the owner as the statement of reasons) — unlike notes.
interface DecisionDraft {
  action: 'content_removed' | 'access_restricted'
  rule: ModerationRule
  explanation: string
}
const decisionDrafts = ref<Record<string, DecisionDraft>>({})
function draftFor(reportId: string): DecisionDraft {
  decisionDrafts.value[reportId] ??= { action: 'content_removed', rule: 'illegal_content', explanation: '' }
  return decisionDrafts.value[reportId]
}
const RULE_LABEL: Record<ModerationRule, string> = {
  illegal_content: 'Illegal content',
  csam: 'Child sexual abuse material',
  phishing_or_fraud: 'Phishing, scams or fraud',
  malware: 'Malware or harmful downloads',
  spam_or_seo: 'Spam or search-engine manipulation',
  copyright: 'Copyright / IP infringement',
  harassment_or_hate: 'Harassment, threats or hate speech',
  privacy_violation: 'Other people\'s personal data',
  other_terms: 'Other breach of the Terms'
}
function ruleLabel(rule: string): string {
  return isModerationRule(rule) ? RULE_LABEL[rule] : rule
}
const RULE_OPTIONS = MODERATION_RULES.map(value => ({ value, label: RULE_LABEL[value] }))
const ACTION_OPTIONS = [
  { value: 'content_removed', label: 'Remove the document' },
  { value: 'access_restricted', label: 'Restrict (set private)' }
] as const
const NOTICE_LABEL: Record<ModerationNotice['kind'], string> = {
  receipt: 'Receipt → reporter',
  decision: 'Decision → reporter',
  statement_of_reasons: 'Statement of reasons → owner'
}
const NOTICE_STATUS_LABEL: Record<ModerationNotice['status'], string> = {
  sent: 'sent',
  not_delivered_no_contact: 'not delivered — no contact',
  failed: 'failed'
}
const acting = ref<Record<string, boolean>>({})

async function refresh(): Promise<void> {
  if (!accountStatus.value?.isAdmin) return
  loading.value = true
  try {
    // Map our two-status default to a server query — server treats
    // 'open+acknowledged' as the default when no `status=` is given.
    const statusParam = filter.value === 'open+acknowledged' ? '' : filter.value
    reports.value = await apiFetch('/api/admin/abuse-reports', {
      query: statusParam ? { status: statusParam } : {}
    })
  } catch (e) {
    toast.add({
      title: 'Could not load reports',
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

watch(filter, () => {
  void refresh()
})
onMounted(() => {
  void refresh()
})
watchEffect(() => {
  if (accountStatus.value?.isAdmin && reports.value.length === 0 && !loading.value) {
    void refresh()
  }
})

async function transition(reportId: string, status: 'acknowledged' | 'actioned' | 'dismissed'): Promise<void> {
  if (acting.value[reportId]) return
  acting.value[reportId] = true
  try {
    const draft = draftFor(reportId)
    await apiFetch('/api/admin/abuse-reports/:reportId', {
      method: 'patch',
      path: { reportId },
      body: {
        status,
        notes: (noteDrafts.value[reportId] ?? '').trim() || undefined,
        ...(status === 'acknowledged'
          ? {}
          : {
              decision: {
                action: status === 'actioned' ? draft.action : 'no_action',
                rule: draft.rule,
                explanation: draft.explanation.trim()
              }
            })
      }
    })
    toast.add({
      title: `Report ${status}`,
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
    noteDrafts.value[reportId] = ''
    await refresh()
  } catch (e) {
    toast.add({
      title: `Could not ${status} report`,
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    acting.value[reportId] = false
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function onClose(): void {
  void router.push('/')
}

const STATUS_TONE: Record<AbuseReport['status'], string> = {
  open: 'text-rose-700 dark:text-rose-300',
  acknowledged: 'text-default',
  actioned: 'text-muted',
  dismissed: 'text-muted'
}
const CATEGORY_LABEL: Record<string, string> = {
  illegal_content: 'Illegal content',
  copyright: 'Copyright',
  csam: 'CSAM',
  harassment: 'Harassment',
  spam: 'Spam',
  other: 'Other'
}

const FILTER_OPTIONS: { value: StatusFilter, label: string }[] = [
  { value: 'open+acknowledged', label: 'Active queue' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'actioned', label: 'Actioned' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' }
]
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      :aria-label="t('pricing.close')"
      @click="onClose"
    />

    <main class="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-6">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /admin · abuse-reports
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          Abuse reports
        </h1>
        <p class="mt-3 text-sm text-muted">
          Reports submitted via the in-product form at /legal/abuse.
          Email reports go to the abuse contact inbox separately
          and aren't shown here.
        </p>
      </header>

      <div class="flex items-center gap-3 mb-6">
        <USelect
          v-model="filter"
          :items="FILTER_OPTIONS"
          value-key="value"
          class="w-48"
          data-testid="admin-abuse-filter"
        />
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          @click="refresh"
        >
          Refresh
        </UButton>
      </div>

      <div
        v-if="loading"
        class="text-sm text-muted py-12 text-center"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="size-5 animate-spin mb-3 mx-auto"
        />
        Loading…
      </div>

      <div
        v-else-if="reports.length === 0"
        class="border border-default rounded-lg px-6 py-12 text-center text-sm text-muted"
      >
        No reports in this view.
      </div>

      <ul
        v-else
        class="space-y-4"
      >
        <li
          v-for="report in reports"
          :key="report.reportId"
          class="border border-default rounded-lg overflow-hidden"
          :data-testid="`admin-report-${report.reportId}`"
        >
          <header class="bg-muted px-4 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              class="font-mono uppercase tracking-wider text-xs"
              :class="STATUS_TONE[report.status]"
            >
              {{ report.status }}
            </span>
            <span class="font-mono text-xs text-muted">
              {{ CATEGORY_LABEL[report.category] ?? report.category }}
            </span>
            <span class="font-mono text-xs text-muted">
              {{ fmtDate(report.createdAt) }}
            </span>
            <span class="font-mono text-xs text-muted ml-auto">
              {{ report.reportId }}
            </span>
          </header>

          <div class="px-4 py-4 space-y-3">
            <!-- Reporter — name + email + mailto: link for follow-
                 up. Strikethrough name when the user has deleted
                 their account; the email snapshot still works as
                 a follow-up channel. -->
            <div
              v-if="report.reporter"
              class="text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1"
              data-testid="admin-report-reporter"
            >
              <span class="font-mono text-[11px] uppercase tracking-wider text-muted">Reporter:</span>
              <span
                v-if="report.reporter.name"
                :class="{ 'line-through text-muted': !report.reporter.stillExists }"
              >
                {{ report.reporter.name }}
              </span>
              <span
                v-else
                class="text-muted italic"
              >
                (account deleted)
              </span>
              <a
                v-if="report.reporter.email"
                :href="`mailto:${report.reporter.email}?subject=Re: abuse report ${report.reportId}`"
                class="font-mono text-xs text-muted hover:text-default underline"
              >
                {{ report.reporter.email }}
              </a>
              <span
                v-if="!report.reporter.stillExists"
                class="font-mono text-[11px] text-muted"
              >
                (account deleted — email snapshot)
              </span>
            </div>
            <div
              v-if="report.contentUrl"
              class="text-sm break-all"
            >
              <span class="font-mono text-[11px] uppercase tracking-wider text-muted mr-2">Reported:</span>
              <span class="font-mono">{{ report.contentUrl }}</span>
            </div>
            <div
              v-if="report.docId"
              class="text-sm"
            >
              <span class="font-mono text-[11px] uppercase tracking-wider text-muted mr-2">Doc:</span>
              <NuxtLink
                :to="`/d/${report.docId}`"
                target="_blank"
                rel="noopener"
                class="font-mono underline"
              >
                {{ report.docId }}
              </NuxtLink>
            </div>
            <div class="text-sm whitespace-pre-wrap">
              {{ report.body }}
            </div>

            <div
              v-if="report.notes"
              class="text-xs border-t border-default pt-2 mt-2"
            >
              <p class="font-mono uppercase tracking-wider text-muted mb-1">
                Notes
              </p>
              <p class="text-muted whitespace-pre-wrap">
                {{ report.notes }}
              </p>
            </div>

            <p
              class="text-xs text-muted font-mono"
            >
              {{ report.reporter?.signedIn ? 'signed-in reporter' : 'reporter not signed in' }}
              · good-faith statement {{ report.goodFaithConfirmedAt ? 'confirmed' : '— (legacy report)' }}
            </p>

            <div
              v-if="report.decision"
              class="text-xs border-t border-default pt-2 mt-2 space-y-1"
              data-testid="admin-report-decision"
            >
              <p class="font-mono uppercase tracking-wider text-muted">
                Decision
              </p>
              <p>
                {{ report.decision.action }}<template v-if="report.decision.rule">
                  · {{ ruleLabel(report.decision.rule) }}
                </template>
              </p>
              <p class="text-muted whitespace-pre-wrap">
                {{ report.decision.explanation }}
              </p>
            </div>

            <details
              v-if="report.notices.length > 0"
              class="text-xs border-t border-default pt-2 mt-2"
              data-testid="admin-report-notices"
            >
              <summary class="font-mono uppercase tracking-wider text-muted cursor-pointer">
                Notices ({{ report.notices.length }})
              </summary>
              <ul class="mt-2 space-y-2">
                <li
                  v-for="(notice, i) in report.notices"
                  :key="i"
                  :data-testid="`admin-notice-${notice.kind}`"
                >
                  <p class="font-mono text-muted">
                    {{ NOTICE_LABEL[notice.kind] }} · {{ NOTICE_STATUS_LABEL[notice.status] }} · {{ fmtDate(notice.createdAt) }}
                  </p>
                  <p class="font-medium">
                    {{ notice.subject }}
                  </p>
                  <pre class="whitespace-pre-wrap font-sans text-muted">{{ notice.body }}</pre>
                </li>
              </ul>
            </details>

            <div
              v-if="report.actionedBy"
              class="text-xs text-muted font-mono"
            >
              {{ report.status }} by {{ report.actionedBy.name }} ·
              {{ fmtDate(report.actionedAt ?? report.acknowledgedAt) }}
            </div>

            <!-- Action panel — visible only for open + acknowledged
                 reports. The PATCH endpoint enforces backwards-
                 transition refusal but we hide the buttons too. -->
            <div
              v-if="report.status === 'open' || report.status === 'acknowledged'"
              class="border-t border-default pt-3 space-y-2"
            >
              <div class="grid gap-2 sm:grid-cols-2">
                <USelect
                  v-model="draftFor(report.reportId).action"
                  :items="[...ACTION_OPTIONS]"
                  value-key="value"
                  class="w-full"
                  data-testid="admin-decision-action"
                />
                <USelect
                  v-model="draftFor(report.reportId).rule"
                  :items="RULE_OPTIONS"
                  value-key="value"
                  class="w-full"
                  data-testid="admin-decision-rule"
                />
              </div>
              <UTextarea
                v-model="draftFor(report.reportId).explanation"
                placeholder="Explanation (SENT to the reporter, and to the owner as the statement of reasons when you remove or restrict)"
                :rows="3"
                class="w-full"
                :ui="{ base: 'w-full' }"
                data-testid="admin-decision-explanation"
              />
              <UTextarea
                v-model="noteDrafts[report.reportId]"
                placeholder="Notes (optional, internal — added to the audit trail)"
                :rows="2"
                class="w-full"
                :ui="{ base: 'w-full' }"
              />
              <div class="flex flex-wrap gap-2 justify-end">
                <UButton
                  v-if="report.status === 'open'"
                  size="sm"
                  variant="outline"
                  color="neutral"
                  :loading="acting[report.reportId]"
                  data-testid="admin-acknowledge"
                  @click="transition(report.reportId, 'acknowledged')"
                >
                  Acknowledge
                </UButton>
                <UButton
                  size="sm"
                  variant="ghost"
                  color="neutral"
                  :loading="acting[report.reportId]"
                  data-testid="admin-dismiss"
                  @click="transition(report.reportId, 'dismissed')"
                >
                  Dismiss
                </UButton>
                <UButton
                  size="sm"
                  color="error"
                  :loading="acting[report.reportId]"
                  data-testid="admin-action"
                  @click="transition(report.reportId, 'actioned')"
                >
                  Action
                </UButton>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </main>

    <CommonLegalFooter />
  </div>
</template>
