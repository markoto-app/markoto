import { bool, email as emailAddress, nonNegativeInt, oneOf, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

function entity(name: string, doc: string, fallback?: string) {
  return v({
    name,
    type: string,
    doc: fallback === undefined ? doc : `${doc} Default: ${fallback}.`,
    services: ['app'],
    scope: 'hosted'
  })
}

export const legal = defineNamespace({
  name: 'legal',
  title: 'Legal surfaces and retention',
  intro: 'Onboarding gate, DPA step, /legal/* pages and the operator identity rendered into them. The bundled texts describe the hosted markoto.app service: off by default.',
  vars: {
    surfacesEnabled: v({
      name: 'NUXT_LEGAL_SURFACES_ENABLED',
      type: bool,
      default: false,
      doc: 'Onboarding gate (age + Privacy + ToS), DPA step, /legal/* pages and footer links. Hosted: true.',
      services: ['app'],
      scope: 'both'
    }),
    controllerName: entity('NUXT_LEGAL_CONTROLLER_NAME', 'Legal entity operating the instance (also the footer\'s operator name).', 'LatentSpace Labs GmbH (legal surfaces on)'),
    controllerAddress: v({
      name: 'NUXT_LEGAL_CONTROLLER_ADDRESS',
      type: string,
      doc: 'Postal address of the operator. No default.',
      services: ['app'],
      scope: 'hosted',
      required: { when: 'NUXT_LEGAL_SURFACES_ENABLED=true' }
    }),
    privacyContactEmail: entity('NUXT_LEGAL_PRIVACY_CONTACT_EMAIL', 'Inbox for data-subject requests.', 'privacy@markoto.app'),
    abuseContactEmail: entity('NUXT_LEGAL_ABUSE_CONTACT_EMAIL', 'Inbox for DSA abuse reports; also receives abuse-report notifications on any instance.', 'abuse@markoto.app (legal surfaces on)'),
    governingLaw: entity('NUXT_LEGAL_GOVERNING_LAW', 'Choice of law of the Terms.', 'Swiss law'),
    legalForm: entity('NUXT_LEGAL_LEGAL_FORM', 'Legal form, for the imprint.', 'Gesellschaft mit beschränkter Haftung (GmbH)'),
    registeredOffice: entity('NUXT_LEGAL_REGISTERED_OFFICE', 'Registered office, for the imprint.', 'Zürich, Switzerland'),
    representedBy: v({
      name: 'NUXT_LEGAL_REPRESENTED_BY',
      type: string,
      doc: 'Person(s) authorised to represent the operator (imprint). No default.',
      services: ['app'],
      scope: 'hosted',
      required: { when: 'NUXT_LEGAL_SURFACES_ENABLED=true' }
    }),
    uid: entity('NUXT_LEGAL_UID', 'Swiss business identification number.', 'CHE-170.986.632'),
    chId: entity('NUXT_LEGAL_CH_ID', 'Commercial-register id.', 'CH-020-4092420-2'),
    ehraId: entity('NUXT_LEGAL_EHRA_ID', 'EHRA id.', '1753104'),
    auditLogRetentionDays: v({
      name: 'NUXT_AUDIT_LOG_RETENTION_DAYS',
      type: nonNegativeInt,
      default: 730,
      doc: 'Audit-log rows older than this are deleted (0 = keep forever).',
      services: ['app'],
      scope: 'both'
    }),
    abuseReportRetentionDays: v({
      name: 'NUXT_ABUSE_REPORT_RETENTION_DAYS',
      type: nonNegativeInt,
      default: 365,
      doc: 'Closed abuse reports are deleted this many days after closing (0 = keep forever).',
      services: ['app'],
      scope: 'both'
    }),
    inactiveDocTtlDays: v({
      name: 'NUXT_INACTIVE_DOC_TTL_DAYS',
      type: nonNegativeInt,
      default: 30,
      doc: 'Anonymous documents (no owner, no workspace) are deleted after this many days without activity (0 = never).',
      services: ['app'],
      scope: 'both'
    }),
    anonGateEnabled: v({
      name: 'NUXT_ANON_GATE_ENABLED',
      type: bool,
      defaultDoc: 'NUXT_LEGAL_SURFACES_ENABLED',
      doc: 'Anonymous visitors accept the Terms (age ≥ 16) and pass an ALTCHA bot check before their first document / an anonymous report.',
      services: ['app'],
      scope: 'both'
    }),
    altchaHmacKey: v({
      name: 'NUXT_ALTCHA_HMAC_KEY',
      example: '',
      type: secret(32),
      secret: true,
      doc: 'HMAC key of the ALTCHA challenge and the remembered-terms cookie.',
      services: ['app'],
      scope: 'both',
      required: { when: 'the anonymous gate is on' }
    })
  }
})

export const email = defineNamespace({
  name: 'email',
  title: 'Transactional email',
  intro: 'Resend. Without RESEND_API_KEY every email is logged instead of sent.',
  vars: {
    resendApiKey: v({
      name: 'RESEND_API_KEY',
      type: string,
      secret: true,
      doc: 'Resend API key; set = real delivery.',
      services: ['app'],
      scope: 'both'
    }),
    from: v({
      name: 'NUXT_EMAIL_FROM',
      type: string,
      doc: 'Sender, e.g. `markoto <noreply@example.org>` (verified domain). Empty = Resend\'s sandbox sender.',
      services: ['app'],
      scope: 'both'
    }),
    provider: v({
      name: 'NUXT_EMAIL_PROVIDER',
      type: oneOf(['resend', 'stub']),
      doc: '`stub` logs instead of sending even with a key (staging, tests).',
      services: ['app'],
      scope: 'both'
    })
  }
})

export const brand = defineNamespace({
  name: 'brand',
  title: 'Instance co-branding',
  intro: 'Managed private instance: the customer\'s name, logo and support contact beside the markoto wordmark (docs/operations/MANAGED-INSTANCE.md). All empty = nothing changes.',
  vars: {
    name: v({
      name: 'NUXT_INSTANCE_BRAND_NAME',
      type: string,
      default: '',
      doc: 'Customer name shown beside the wordmark (max 60 chars).',
      services: ['app'],
      scope: 'self-host'
    }),
    logo: v({
      name: 'NUXT_INSTANCE_BRAND_LOGO',
      type: string,
      default: '',
      doc: 'Path of the logo file inside the app container (svg, png, webp, jpg).',
      services: ['app'],
      scope: 'self-host',
      notPassed: 'deploy/compose/compose.selfhost.brand.yml mounts the file and sets it'
    }),
    supportUrl: v({
      name: 'NUXT_INSTANCE_SUPPORT_URL',
      type: url(),
      doc: 'Help / service-desk page of this instance.',
      services: ['app'],
      scope: 'self-host'
    }),
    supportEmail: v({
      name: 'NUXT_INSTANCE_SUPPORT_EMAIL',
      type: emailAddress,
      doc: 'Support email address of this instance.',
      services: ['app'],
      scope: 'self-host'
    })
  }
})
