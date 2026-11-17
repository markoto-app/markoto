# Analytics and ad conversions

How markoto counts visits to its public pages and measures Google Ads conversions without cookies, without a consent banner and without loading any Google script. Everything here is off unless configured; self-hosted instances send no analytics request at all.

## Shape

| Part | What it does | Where |
|---|---|---|
| Umami 3.5 (self-hosted) | Stores page views and events in the `umami` database on the same Postgres | `umami` service, compose profile `analytics` (`deploy/compose/compose.prod.yml`) |
| Collect endpoint | `POST /a/api/send` on the main domain, routed by Traefik to Umami (`/a` stripped). The only Umami path on the main domain | router `umami-collect` |
| Dashboard | Umami's UI on its own host (`UMAMI_HOST`, e.g. `stats.markoto.app`) behind an edge login plus Umami's own login | router `umami` |
| Browser side | `app/plugins/analytics.client.ts` + `app/utils/analytics/analyticsClient.ts`: sends page views and events with `fetch`, keeps the ad click id in memory | no tracker script is loaded |
| Event catalogue | `shared/analytics/events.ts` (names, data, click targets, funnels), `shared/analytics/pages.ts` (what is counted, payload) | one place, unit-tested |
| Click-id conversions | `ad_click_conversions` table, `server/utils/analytics/adConversions.ts`, hourly `ad-conversion-sweep` (retention, waitlist confirmations, Google Ads upload as dry run) | |
| Retention | `analytics-retention-sweep` deletes Umami events and sessions after 13 months (Umami itself keeps everything) | `server/repos/umamiRetention.ts` |

Configuration: `UMAMI_APP_SECRET` (runs Umami), `UMAMI_HOST`, `UMAMI_BASIC_AUTH_USERS`, `POSTGRES_UMAMI_USER` / `_PASSWORD` (its own database role, created by `deploy/config/postgres/db-init.sh`), `NUXT_PUBLIC_ANALYTICS_WEBSITE_ID` (switches the browser side on), `NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS` (keeps click ids of conversions). Reference: [configuration](reference/configuration.md#analytics-and-ad-conversions).

What is never counted: documents (`/d/…`), published pages (`/p/…`, they carry no script; the server counts their views as one aggregate number without slug or visitor data), workspaces, settings, admin, sign-in and token links. A URL sent to Umami is only the path plus the five `utm_*` parameters; an event fired inside the editor uses the placeholder path `/app` and no title. The referrer is reduced to its origin. Event data are short enums, never content, ids or emails.

## Events

| Event | Data | Fired when |
|---|---|---|
| page view | path, `utm_*` | a counted page is shown (client navigation included) |
| `ad_landing` | `network: google`, `id_type` | the landing URL carried `gclid` / `gbraid` / `wbraid` (the id is not sent to Umami) |
| `tour_scrolled` | `depth`: 25 / 50 / 75 / 100 | product tour on `/` scrolled past the mark (once per page view) |
| `start_writing_clicked` | `placement`: header, tour_hero, tour_final, content, try_it | a "Start writing" / "Open as a document" button |
| `pricing_cta_clicked` | `plan`, `action`: start, sign_in, waitlist, self_host | a call to action on `/pricing` |
| `checkout_started` | `plan` | a paid plan's checkout button (billing on) |
| `waitlist_submitted` | none | the waitlist form was accepted |
| `waitlist_confirmed` | none | the confirmation link's button was pressed and accepted |
| `signup_started` | `provider` | a sign-in link (GitHub, Google, OIDC) |
| `signup_completed` | `provider` | back from the provider with a new account (`/?signed_up=<provider>`, removed again) |
| `doc_created` | `anonymous`, `source`: dialog, try_it | a document was created (anonymous or signed in) |
| `ai_first_use` | none | first AI prompt of a tab |
| `github_clicked` | `placement` | a GitHub link in the header or footer |
| `selfhost_clicked` | `placement` | a self-hosting link (header, footer, tour) |
| `published_page_view` | none | server side, per view of a published page (aggregate only) |

Click events come from one delegated listener keyed on the e2e test ids (`data-testid`), so components need no analytics code; adding a button means adding its test id to `CLICK_TARGETS`.

## Funnels

Set these up in Umami (Reports, Funnel); `FUNNELS` in `shared/analytics/events.ts` is the source.

| Funnel | Steps |
|---|---|
| Ad click to first document | `ad_landing` → `start_writing_clicked` → `doc_created` |
| Landing to paid-plan interest | `/` → `/pricing` → `pricing_cta_clicked` → `waitlist_submitted` (with billing on: `checkout_started`) |
| Landing to activated account | `/` → `signup_started` → `signup_completed` → `doc_created` → `ai_first_use` |

Umami counts funnel steps per session, and a session lasts one day at most (daily salt, below). A step on a later day (a waitlist confirmation the next morning) shows in the server-side conversion record instead. Use the UTM report for campaign / source / medium / term / content breakdowns; name ad final URLs with `utm_source=google&utm_medium=cpc&utm_campaign=<campaign>` (Google adds `gclid` itself with auto-tagging).

## Google Ads conversions without a Google script

The Google tag (gtag.js) would set cookies on our domain, send every visitor's data to Google in the US and needs consent in the EU and Switzerland. Instead:

1. Google appends `gclid` (or `gbraid` / `wbraid` on iOS) to the landing URL. The client reads it into memory, removes it from the address bar and stores it nowhere (no cookie, no web storage).
2. Only a request that is itself a conversion carries it: the body of `POST /api/docs` and `POST /api/waitlist`, or the query of the sign-in link (`/auth/google?gclid=…`). For OAuth the server parks the id in Valkey for 15 minutes under a hash of the OAuth `state` and turns it into a `signup` conversion when the callback creates a new account.
3. The server keeps one row per click and kind (`signup`, `waitlist_signup`, `waitlist_confirmed`, `first_document`) in `ad_click_conversions`: click id, kind, time, the account (for the data export and so the first document of an ad-acquired account counts), no email, IP or user agent. A request with `Sec-GPC: 1` or `DNT: 1` is never recorded. Rows are deleted 90 days after the conversion and with the account (FK cascade) or the waitlist entry.
4. `ad-conversion-sweep` builds the Google Ads `uploadClickConversions` rows (`server/utils/analytics/googleAdsUpload.ts`: click id, conversion action, time, `consent.adUserData`). **The upload is a dry run** (it logs what it would send): it needs Google Ads API access that this repository does not have yet (open item below).

Enhanced conversions for leads (hashed email) is not used: it would send personal data of every sign-up to Google and needs consent.

## Legal assessment

Summary: **no consent banner** for the design as built. Not legal advice; have counsel confirm the two open points before switching ad conversions on.

**Umami statistics (legitimate interest, Art. 6(1)(f) GDPR; Swiss FADP: processing with information).**
- Nothing is stored on or read from the device for analytics: no cookie, no local or session storage, no fingerprinting script; the client sends the page path, language, screen size and the request's IP and user agent like any page request. Umami (verified in the v3.5.0 source: src/lib/collection-session.ts and src/lib/crypto.ts of umami-software/umami) derives a session id as a UUIDv5 of `website id + IP + user agent + salt`, with `SALT_ROTATION=day` the salt changes daily, plus the app secret; the IP is used for the GeoLite lookup (country, region, city) and never stored. Visits within an hour share a visit id.
- ePrivacy Art. 5(3) / Swiss FMG Art. 45c: no storage of information on the device. Reading the screen size and language that the browser exposes is the residual "access" point; it is the same data every page request or CSS media query uses, the purpose is first-party audience measurement in the CNIL exemption's sense (first party, aggregate, no cross-site, retention 13 months). Germany's TDDDG has no explicit analytics exemption; the risk there is low but not zero. Under Swiss law information in the privacy policy is enough (Art. 45c FMG).
- Global Privacy Control and Do Not Track switch it off in the browser.
- Retention 13 months, enforced by the app (`analytics-retention-sweep`). Umami runs inside our stack, so it is not a sub-processor; the data stays in OVHcloud's managed Postgres (already listed).

**Ad click conversions (legitimate interest; Google Ads as recipient).**
- The click id is in the URL Google sends the visitor to; we read it in memory and send it only with the conversion request the visitor makes. No storage on the device, so no consent requirement under ePrivacy Art. 5(3) from storage; the EDPB's Guidelines 2/2023 treat tracking parameters in URLs as within Art. 5(3) when the controller causes them to be sent for tracking: **open point 1** for counsel. GPC / DNT are honoured; the privacy policy (§9b) explains it, with an Art. 21 objection address.
- Uploading to Google Ads transfers the click id and conversion time to Google (Google Ireland / Google LLC, DPF). Google is listed as a recipient (`google_ads` in `server/legal/subProcessors.ts`), visible only where `NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS` is on.
- Google's EU User Consent Policy (EEA, UK, Switzerland) expects advertisers to obtain consent for ad measurement data and to send `consent.adUserData` with uploads; without it conversions may not be attributed. Since we ask nobody, the builder sends `DENIED`. **Open point 2**: either accept that Google uses these conversions only in limited / modelled form, or add a narrowly scoped consent question at the conversion step (an unticked checkbox on sign-up for visitors who came from an ad), never a site-wide banner.

**Registries.** `PROCESSING_PURPOSES`: `web_analytics` (395 days) and `ad_conversion_measurement` (90 days), both legitimate interest, each shown only when its feature is on (`server/legal/registryView.ts`). Privacy policy v14 (en authoritative, de / fr / es translated): summary, §2, §4 (Google Ads row), §5 (retention), §9 (no storage for statistics or ads), new §9b, change log. Data export: `ad_conversions.ndjson`. Account deletion: FK cascade. Umami data is not linked to accounts and cannot be exported per person.

## Operating it

- First start: render with `UMAMI_APP_SECRET`, `UMAMI_HOST`, `UMAMI_BASIC_AUTH_USERS` and (recommended) `POSTGRES_UMAMI_USER` / `_PASSWORD`; deploy; create the DNS record for `UMAMI_HOST`; log in through the edge login with Umami's default account (`admin` / `umami`) and **change its password at once**; add the website (domain = `DOMAIN`), copy its id into `NUXT_PUBLIC_ANALYTICS_WEBSITE_ID`; deploy again.
- Turn ad conversions on with `NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS=true` only after the open points above are settled.
- Retention changes: `NUXT_ANALYTICS_RETENTION_DAYS`, `NUXT_ADS_CONVERSION_RETENTION_DAYS` (a longer retention is a privacy-policy change).
- Upgrading Umami: pin the new tag and digest; check its release notes for schema changes that touch the tables in `server/repos/umamiRetention.ts`.

## Open items

- Google Ads API upload: needs a developer token, an OAuth client with refresh token, the customer id and one `UPLOAD_CLICKS` conversion action per kind; then replace the dry run in `adConversionSweep.ts` with the `uploadClickConversions` call and set `uploaded_at` on the accepted rows.
- Counsel review of open points 1 and 2.
- Self-host: Umami is wired for the hosted stack only. A self-hoster can point the variables at their own Umami (same-origin path routed by their proxy).
