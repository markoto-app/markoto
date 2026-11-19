import { bool, hostname, pattern, positiveInt, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

// Cookieless page analytics (a self-hosted Umami next to the app) and the
// server-side record of Google Ads click conversions. Both are off unless
// configured: self-hosted instances never send an analytics request.
// Design, events and the legal assessment: docs/SELF-HOSTING.md#analytics-optional.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAME_ORIGIN_PATH = /^\/[A-Za-z0-9/_.-]*$/

export const analytics = defineNamespace({
  name: 'analytics',
  title: 'Analytics and ad conversions',
  intro: 'Cookieless page analytics through a self-hosted Umami on the same origin, and the click-ID conversion record for Google Ads. Off by default; docs/SELF-HOSTING.md#analytics-optional.',
  vars: {
    websiteId: v({
      name: 'NUXT_PUBLIC_ANALYTICS_WEBSITE_ID',
      type: pattern(UUID, 'a UUID (the Umami website id)'),
      doc: 'Umami website id. Set = the public pages send cookieless page views and conversion events to NUXT_PUBLIC_ANALYTICS_ENDPOINT; empty = no analytics request at all.',
      services: ['app'],
      scope: 'hosted'
    }),
    endpoint: v({
      name: 'NUXT_PUBLIC_ANALYTICS_ENDPOINT',
      type: pattern(SAME_ORIGIN_PATH, 'a same-origin path starting with /'),
      default: '/a/api/send',
      doc: 'Same-origin path the browser posts analytics events to (Traefik routes it to Umami\'s /api/send).',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the hosted stack uses the default, which its Traefik router matches'
    }),
    adsConversions: v({
      name: 'NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS',
      type: bool,
      default: false,
      doc: 'Keep the Google Ads click id (gclid / gbraid / wbraid) of a visit that converts (sign-up, waitlist, first document) for the offline conversion upload. No Google script is loaded either way.',
      services: ['app'],
      scope: 'hosted'
    }),
    adsConversionRetentionDays: v({
      name: 'NUXT_ADS_CONVERSION_RETENTION_DAYS',
      type: positiveInt,
      default: 90,
      doc: 'Stored click-id conversions are deleted this many days after the conversion (Google Ads accepts uploads for 90 days after the click).',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the hosted stack uses the default'
    }),
    internalUrl: v({
      name: 'NUXT_ANALYTICS_INTERNAL_URL',
      type: url(),
      doc: 'Umami\'s in-network URL for the server-side count of published-page views (aggregate only: no visitor data, no page slug). Empty = not counted.',
      services: ['app'],
      scope: 'hosted'
    }),
    retentionDays: v({
      name: 'NUXT_ANALYTICS_RETENTION_DAYS',
      type: positiveInt,
      default: 395,
      doc: 'Umami events and sessions older than this are deleted by the app (13 months).',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the hosted stack uses the default'
    }),
    dbUser: v({
      name: 'NUXT_ANALYTICS_DB_USER',
      type: string,
      doc: 'Role the app deletes expired Umami data as; empty = POSTGRES_USER (and POSTGRES_PASSWORD).',
      services: ['app'],
      scope: 'hosted'
    }),
    dbPassword: v({
      name: 'NUXT_ANALYTICS_DB_PASSWORD',
      type: string,
      secret: true,
      doc: 'Password of NUXT_ANALYTICS_DB_USER.',
      services: ['app'],
      scope: 'hosted'
    }),
    dbName: v({
      name: 'NUXT_ANALYTICS_DB_NAME',
      type: string,
      default: 'umami',
      doc: 'Umami\'s database name.',
      services: ['app'],
      scope: 'hosted',
      notPassed: 'the hosted stack uses the default'
    }),
    umamiAppSecret: v({
      name: 'UMAMI_APP_SECRET',
      type: secret(32),
      secret: true,
      doc: 'Umami\'s APP_SECRET (signs its login tokens, salts its visitor hashes). Set = the `analytics` compose profile runs Umami.',
      services: ['compose'],
      scope: 'hosted'
    }),
    umamiHost: v({
      name: 'UMAMI_HOST',
      type: hostname,
      doc: 'Host name of the Umami dashboard (e.g. stats.markoto.app); needs a DNS record.',
      services: ['compose'],
      scope: 'hosted'
    }),
    umamiBasicAuthUsers: v({
      name: 'UMAMI_BASIC_AUTH_USERS',
      type: string,
      secret: true,
      doc: 'htpasswd line(s) (`user:<bcrypt>`) of the edge login in front of the Umami dashboard, on top of Umami\'s own login.',
      services: ['compose'],
      scope: 'hosted'
    })
  }
})
