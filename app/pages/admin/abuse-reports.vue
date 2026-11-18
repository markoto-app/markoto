<script setup lang="ts">
// Admin queue for incoming abuse reports (DSA Art.16 notices). The
// endpoints are admin-only; `useAdminGate` keeps others off the page.
//
//   - Status filter (active queue = open + acknowledged, or one status)
//   - Per report: status, category, reporter, reported URL / document,
//     body, decision, the notices sent, and the actions.
//   - The decision explanation is SENT (to the reporter, and to the owner
//     as the statement of reasons); notes stay internal (audit trail).
//
// Backwards transitions (closed to open) are not supported: see the
// endpoint comment.

import type { ApiResponse } from '~/utils/api/client'
import { MODERATION_RULES, isModerationAction, isModerationRule, isReportCategory, type ModerationRule } from '~~/shared/config/moderation'

type AbuseReport = ApiResponse<'/api/admin/abuse-reports', 'get'>[number]

definePageMeta({ layout: 'admin' })

const { t, locale } = useI18n()
const { isAdmin } = useAdminGate()
const toast = useToast()
const { extractError } = useErrorHandler()

useHead({ title: () => `${t('admin.abuse.title')} · ${t('admin.title')}` })

type StatusFilter = 'open' | 'acknowledged' | 'actioned' | 'dismissed' | 'open+acknowledged' | 'all'
const filter = ref<StatusFilter>('open+acknowledged')
const reports = ref<AbuseReport[]>([])
const loading = ref(false)
const loaded = ref(false)
const noteDrafts = ref<Record<string, string>>({})
// Decision drafts per report. The explanation and rule are SENT (to the
// reporter, and to the owner as the statement of reasons), unlike notes.
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
function ruleLabel(rule: string): string {
  return isModerationRule(rule) ? t(`admin.abuse.rule.${rule}`) : rule
}
function actionLabel(action: string): string {
  return isModerationAction(action) ? t(`admin.abuse.decisionAction.${action}`) : action
}
function categoryLabel(category: string): string {
  return isReportCategory(category) ? t(`legal.abuse.category.${category}`) : category
}
const ruleOptions = computed(() => MODERATION_RULES.map(value => ({ value, label: t(`admin.abuse.rule.${value}`) })))
const actionOptions = computed(() => (['content_removed', 'access_restricted'] as const).map(value => ({ value, label: t(`admin.abuse.actionOption.${value}`) })))
const acting = ref<Record<string, boolean>>({})

async function refresh(): Promise<void> {
  if (!isAdmin.value) return
  loading.value = true
  try {
    // The server treats a missing `status=` as the active queue.
    const statusParam = filter.value === 'open+acknowledged' ? '' : filter.value
    reports.value = await apiFetch('/api/admin/abuse-reports', {
      query: statusParam ? { status: statusParam } : {}
    })
    loaded.value = true
  } catch (e) {
    toast.add({
      title: t('admin.abuse.loadFailed'),
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
  watch(isAdmin, (admin) => {
    if (admin && !loaded.value && !loading.value) void refresh()
  }, { immediate: true })
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
      title: t(`admin.abuse.done.${status}`),
      icon: 'i-lucide-check',
      color: 'neutral'
    })
    noteDrafts.value[reportId] = ''
    await refresh()
  } catch (e) {
    toast.add({
      title: t('admin.abuse.updateFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    acting.value[reportId] = false
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString(locale.value, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function mailHref(email: string, reportId: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(t('admin.abuse.mailSubject', { id: reportId }))}`
}

const STATUS_TONE: Record<AbuseReport['status'], string> = {
  open: 'text-error',
  acknowledged: 'text-default',
  actioned: 'text-muted',
  dismissed: 'text-muted'
}

const filterOptions = computed(() => ([
  { value: 'open+acknowledged', label: t('admin.abuse.filter.active') },
  { value: 'open', label: t('admin.abuse.status.open') },
  { value: 'acknowledged', label: t('admin.abuse.status.acknowledged') },
  { value: 'actioned', label: t('admin.abuse.status.actioned') },
  { value: 'dismissed', label: t('admin.abuse.status.dismissed') },
  { value: 'all', label: t('admin.abuse.filter.all') }
] satisfies Array<{ value: StatusFilter, label: string }>))
</script>

<template>
  <div data-testid="admin-abuse-page">
    <AdminPageHeader
      :title="t('admin.abuse.title')"
      :intro="t('admin.abuse.intro')"
    >
      <template #actions>
        <USelect
          v-model="filter"
          :items="filterOptions"
          value-key="value"
          size="sm"
          class="w-44"
          :aria-label="t('admin.abuse.filter.label')"
          data-testid="admin-abuse-filter"
        />
        <UButton
          size="sm"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          @click="refresh"
        >
          {{ t('admin.abuse.refresh') }}
        </UButton>
      </template>
    </AdminPageHeader>

    <div
      v-if="loading && reports.length === 0"
      class="text-sm text-muted py-12 text-center"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="size-5 animate-spin mb-3 mx-auto"
      />
      {{ t('admin.abuse.loading') }}
    </div>

    <div
      v-else-if="reports.length === 0"
      class="rounded-md bg-default px-6 py-12 text-center text-sm text-muted"
      data-testid="admin-abuse-empty"
    >
      {{ t('admin.abuse.empty') }}
    </div>

    <ul
      v-else
      class="space-y-4"
    >
      <li
        v-for="report in reports"
        :key="report.reportId"
        class="rounded-md bg-default overflow-hidden"
        :data-testid="`admin-report-${report.reportId}`"
      >
        <header class="border-b border-default px-4 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            class="font-mono uppercase tracking-wider text-xs"
            :class="STATUS_TONE[report.status]"
          >
            {{ t(`admin.abuse.status.${report.status}`) }}
          </span>
          <span class="text-sm text-default">
            {{ categoryLabel(report.category) }}
          </span>
          <span class="font-mono text-xs text-muted">
            {{ fmtDate(report.createdAt) }}
          </span>
          <span class="font-mono text-xs text-muted sm:ml-auto break-all">
            {{ report.reportId }}
          </span>
        </header>

        <div class="px-4 py-4 space-y-3">
          <!-- Reporter: name + email for follow-up. The name is struck
               through once the account is deleted; the email snapshot
               still works as a follow-up channel. -->
          <div
            v-if="report.reporter"
            class="text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1"
            data-testid="admin-report-reporter"
          >
            <span class="font-mono text-[11px] uppercase tracking-wider text-muted">{{ t('admin.abuse.reporter') }}</span>
            <span
              v-if="report.reporter.name"
              :class="{ 'line-through text-muted': !report.reporter.stillExists }"
            >
              {{ report.reporter.name }}
            </span>
            <span
              v-else
              class="text-muted"
            >
              {{ t('admin.abuse.accountDeleted') }}
            </span>
            <a
              v-if="report.reporter.email"
              :href="mailHref(report.reporter.email, report.reportId)"
              class="font-mono text-xs text-muted hover:text-default underline break-all"
            >
              {{ report.reporter.email }}
            </a>
            <span
              v-if="!report.reporter.stillExists"
              class="font-mono text-[11px] text-muted"
            >
              {{ t('admin.abuse.emailSnapshot') }}
            </span>
          </div>
          <div
            v-if="report.contentUrl"
            class="text-sm break-all"
          >
            <span class="font-mono text-[11px] uppercase tracking-wider text-muted mr-2">{{ t('admin.abuse.reported') }}</span>
            <span class="font-mono">{{ report.contentUrl }}</span>
          </div>
          <div
            v-if="report.docId"
            class="text-sm"
          >
            <span class="font-mono text-[11px] uppercase tracking-wider text-muted mr-2">{{ t('admin.abuse.document') }}</span>
            <NuxtLink
              :to="`/d/${report.docId}`"
              target="_blank"
              rel="noopener"
              class="font-mono underline break-all"
            >
              {{ report.docId }}
            </NuxtLink>
          </div>
          <div class="text-sm whitespace-pre-wrap break-words">
            {{ report.body }}
          </div>

          <div
            v-if="report.notes"
            class="text-xs border-t border-default pt-2 mt-2"
          >
            <p class="font-mono uppercase tracking-wider text-muted mb-1">
              {{ t('admin.abuse.notes') }}
            </p>
            <p class="text-muted whitespace-pre-wrap">
              {{ report.notes }}
            </p>
          </div>

          <p class="text-xs text-muted">
            {{ report.reporter?.signedIn ? t('admin.abuse.signedIn') : t('admin.abuse.notSignedIn') }}
            · {{ report.goodFaithConfirmedAt ? t('admin.abuse.goodFaith') : t('admin.abuse.goodFaithLegacy') }}
          </p>

          <div
            v-if="report.decision"
            class="text-xs border-t border-default pt-2 mt-2 space-y-1"
            data-testid="admin-report-decision"
          >
            <p class="font-mono uppercase tracking-wider text-muted">
              {{ t('admin.abuse.decision') }}
            </p>
            <p>
              {{ actionLabel(report.decision.action) }}<template v-if="report.decision.rule">
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
            <summary class="font-mono uppercase tracking-wider text-muted">
              {{ t('admin.abuse.notices', { n: report.notices.length }) }}
            </summary>
            <ul class="mt-2 space-y-2">
              <li
                v-for="(notice, i) in report.notices"
                :key="i"
                :data-testid="`admin-notice-${notice.kind}`"
              >
                <p class="font-mono text-muted">
                  {{ t(`admin.abuse.noticeKind.${notice.kind}`) }} · {{ t(`admin.abuse.noticeStatus.${notice.status}`) }} · {{ fmtDate(notice.createdAt) }}
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
            class="text-xs text-muted"
          >
            {{ t('admin.abuse.handledBy', { status: t(`admin.abuse.status.${report.status}`), name: report.actionedBy.name, date: fmtDate(report.actionedAt ?? report.acknowledgedAt) }) }}
          </div>

          <!-- Actions: only for open and acknowledged reports. The PATCH
               endpoint refuses backwards transitions too. -->
          <div
            v-if="report.status === 'open' || report.status === 'acknowledged'"
            class="border-t border-default pt-3 space-y-2"
          >
            <div class="grid gap-2 sm:grid-cols-2">
              <USelect
                v-model="draftFor(report.reportId).action"
                :items="actionOptions"
                value-key="value"
                class="w-full"
                :aria-label="t('admin.abuse.actionLabel')"
                data-testid="admin-decision-action"
              />
              <USelect
                v-model="draftFor(report.reportId).rule"
                :items="ruleOptions"
                value-key="value"
                class="w-full"
                :aria-label="t('admin.abuse.ruleLabel')"
                data-testid="admin-decision-rule"
              />
            </div>
            <UTextarea
              v-model="draftFor(report.reportId).explanation"
              :placeholder="t('admin.abuse.explanationPlaceholder')"
              :rows="3"
              class="w-full"
              :ui="{ base: 'w-full' }"
              data-testid="admin-decision-explanation"
            />
            <UTextarea
              v-model="noteDrafts[report.reportId]"
              :placeholder="t('admin.abuse.notesPlaceholder')"
              :rows="2"
              class="w-full"
              :ui="{ base: 'w-full' }"
            />
            <div class="flex flex-wrap gap-2 justify-end">
              <UButton
                v-if="report.status === 'open'"
                size="sm"
                variant="outline"
                :loading="acting[report.reportId]"
                data-testid="admin-acknowledge"
                @click="transition(report.reportId, 'acknowledged')"
              >
                {{ t('admin.abuse.acknowledge') }}
              </UButton>
              <UButton
                size="sm"
                variant="ghost"
                :loading="acting[report.reportId]"
                data-testid="admin-dismiss"
                @click="transition(report.reportId, 'dismissed')"
              >
                {{ t('admin.abuse.dismiss') }}
              </UButton>
              <UButton
                size="sm"
                color="error"
                :loading="acting[report.reportId]"
                data-testid="admin-action"
                @click="transition(report.reportId, 'actioned')"
              >
                {{ t('admin.abuse.takeAction') }}
              </UButton>
            </div>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
