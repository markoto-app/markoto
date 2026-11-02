import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'

// Pin the i18n keys our privacy / settings / admin surfaces
// reference. A typo in a `t('legal.consent.banner.title')` shows
// the literal key string in the UI rather than the translation;
// hard to spot in a code review, easy to spot in this list.
//
// Adding a new key referenced by a component? Add it here. The
// test passes when every key resolves to a non-empty string.

const EXPECTED_KEYS: string[] = [
  // Consent banner
  'legal.consent.banner.title',
  'legal.consent.banner.intro',
  'legal.consent.banner.essentialNotice',
  'legal.consent.banner.acceptAll',
  'legal.consent.banner.rejectAll',
  'legal.consent.banner.customize',
  'legal.consent.banner.save',
  'legal.consent.banner.learnMore',
  'legal.consent.banner.footerLink',
  'legal.consent.purpose.essential.label',
  'legal.consent.purpose.essential.description',
  'legal.consent.purpose.analytics.label',
  'legal.consent.purpose.analytics.description',
  'legal.consent.purpose.session_replay.label',
  'legal.consent.purpose.session_replay.description',

  // Age gate
  'legal.ageGate.title',
  'legal.ageGate.body',
  'legal.ageGate.checkbox',

  // Policy acceptance
  'legal.policyAcceptance.documents.privacy',
  'legal.policyAcceptance.documents.tos',
  'legal.policyAcceptance.documents.dpa',
  'legal.policyAcceptance.newVersionTitle',
  'legal.policyAcceptance.newVersionBody',

  // Delete flow (cross-component: modal + banner + settings)
  'legal.delete.confirmTitle',
  'legal.delete.confirmBody',
  'legal.delete.confirmTypeIn',
  'legal.delete.confirmCta',
  'legal.delete.confirmCancel',
  'legal.delete.graceBannerTitle',
  'legal.delete.graceBannerCancel',
  'legal.delete.cancelledToast',
  'legal.policyAcceptance.documentNames.privacy',
  'legal.policyAcceptance.documentNames.tos',
  'legal.policyAcceptance.documentNames.dpa',
  'legal.delete.consequences.workspaces.cascadeDelete.docCount',
  'legal.delete.consequences.workspaces.cascadeDelete.fileCount',
  'legal.delete.consequences.workspaces.promote.rowAlreadyAdmin',
  'legal.delete.consequences.title',
  'legal.delete.consequences.intro',
  'legal.delete.consequences.deleted.heading',
  'legal.delete.consequences.deleted.ownedDocs',
  'legal.delete.consequences.deleted.themes',
  'legal.delete.consequences.deleted.ai',
  'legal.delete.consequences.deleted.exports',
  'legal.delete.consequences.deleted.stripe',
  'legal.delete.consequences.anonymised.heading',
  'legal.delete.consequences.anonymised.comments',
  'legal.delete.consequences.anonymised.activity',
  'legal.delete.consequences.anonymised.audit',
  'legal.delete.consequences.anonymised.consent',
  'legal.delete.consequences.workspaces.heading',
  'legal.delete.consequences.workspaces.cascadeDelete.title',
  'legal.delete.consequences.workspaces.cascadeDelete.body',
  'legal.delete.consequences.workspaces.cascadeDelete.row',
  'legal.delete.consequences.workspaces.promote.title',
  'legal.delete.consequences.workspaces.promote.body',
  'legal.delete.consequences.workspaces.promote.row',
  'legal.delete.consequences.workspaces.removeMember.title',
  'legal.delete.consequences.workspaces.removeMember.body',
  'legal.delete.consequences.workspaces.removeMember.row',
  'legal.delete.consequences.manualSteps.heading',
  'legal.delete.consequences.manualSteps.exportFirst',
  'legal.delete.consequences.manualSteps.transferDocs',
  'legal.delete.consequences.manualSteps.inviteWorkspaceMember',
  'legal.delete.consequences.manualSteps.downloadKnowledge',
  'legal.delete.consequences.timing',
  'legal.delete.consequences.noRecovery',

  // Abuse form / policy
  'legal.abuse.title',
  'legal.abuse.intro',
  'legal.abuse.docIdLabel',
  'legal.abuse.categoryLabel',
  'legal.abuse.category.illegal_content',
  'legal.abuse.category.copyright',
  'legal.abuse.category.csam',
  'legal.abuse.category.harassment',
  'legal.abuse.category.spam',
  'legal.abuse.category.other',
  'legal.abuse.bodyLabel',
  'legal.abuse.bodyPlaceholder',
  'legal.abuse.submit',
  'legal.abuse.submittedTitle',
  'legal.abuse.submittedBody',

  // AI transparency
  'legal.aiTransparency.badge',
  'legal.aiTransparency.publicDocFooter',
  'legal.aiTransparency.assistantLabel',

  // Footer
  'legal.footer.privacy',
  'legal.footer.terms',
  'legal.footer.dpa',
  'legal.footer.subProcessors',
  'legal.footer.abuse',

  // Document page chrome
  'legal.documentPage.translationNoticeTitle',
  'legal.documentPage.translationNoticeBody',
  'legal.documentPage.viewAuthoritative',
  'legal.documentPage.lastUpdated',
  'legal.documentPage.version',
  'legal.documentPage.missingLocale',

  // Settings → profile (top level)
  'settings.profile.title',
  'settings.profile.intro',
  'settings.profile.account.heading',
  'settings.profile.account.email',
  'settings.profile.account.locale',
  'settings.profile.account.ageConfirmed',
  'settings.profile.account.ageNotConfirmed',
  'settings.profile.spending.heading',
  'settings.profile.spending.comingSoon',
  'settings.profile.spending.viewPricing',
  'settings.profile.data.heading',
  'settings.profile.data.exportTitle',
  'settings.profile.data.exportDescription',
  'settings.profile.data.exportButton',
  'settings.profile.data.exportInProgress',
  'settings.profile.data.exportHistoryHeading',
  'settings.profile.data.exportHistoryEmpty',
  'settings.profile.data.exportExpiresAt',
  'settings.profile.data.exportDownload',
  'settings.profile.delete.heading',
  'settings.profile.delete.description',
  'settings.profile.delete.button',
  'settings.profile.delete.scheduled',
  'settings.profile.delete.cancel',
  'settings.profile.legal.heading',
  'settings.profile.legal.subheading',
  'settings.profile.legal.notAccepted',
  'settings.profile.legal.needsReacceptance',
  'settings.profile.legal.dpaNotApplicable',
  'settings.profile.consent.heading',
  'settings.profile.consent.subheading',
  'settings.profile.consent.purposeAlwaysOn',
  'settings.profile.consent.granted',
  'settings.profile.consent.refused',
  'settings.profile.consent.notSet',
  'settings.profile.consent.change'
]

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[seg]
    }
    return undefined
  }, obj)
}

describe('en.json key presence', () => {
  for (const key of EXPECTED_KEYS) {
    it(`has key "${key}"`, () => {
      const value = resolve(en, key)
      expect(value, `missing or empty: ${key}`).toBeTruthy()
      expect(typeof value, `${key} should be a string`).toBe('string')
    })
  }
})
