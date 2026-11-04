---
slug: dpa
locale: en
version: 3
effectiveDate: 2026-11-03
translationStatus: authoritative
---

# Data Processing Addendum

This Data Processing Addendum ("**DPA**") forms part of the Terms of Service between **{{controllerName}}** ("**Processor**" or "**markoto**") and you, the workspace owner ("**Controller**"). It governs markoto's processing of personal data on the Controller's behalf in connection with markoto.app and its features (the "**Service**").

This DPA is required only for workspace customers. If you use markoto only on personal documents, this DPA does not apply to you.

## 1. Definitions and applicable law

Capitalised terms not defined here have the meanings given in the EU General Data Protection Regulation (Regulation (EU) 2016/679, "**GDPR**") or, where Swiss law applies, the Swiss Federal Act on Data Protection ("**FADP**"). This DPA is intended to meet Art. 28 GDPR and Art. 9 FADP. References to the GDPR include the corresponding FADP provisions where the FADP applies.

## 2. Roles

- The **Controller** determines the purposes and means of processing personal data placed into its workspace by its members.
- The **Processor** processes that personal data on the Controller's documented instructions, namely to operate the Service.

## 3. Subject matter, duration, nature and purpose of processing

The Processor processes personal data placed into the Controller's workspace (document content, comments, knowledge-base files, member metadata, AI prompts and outputs) for as long as the Terms of Service apply between the parties and for the purpose of delivering the Service: storage, real-time collaboration, rendering, export, search, AI assistance and backup.

## 4. Categories of data subjects and personal data

- **Data subjects:** the Controller's workspace members, and third parties named in the Controller's documents.
- **Categories of data:** identification (name, email, sign-in identifier), content (any personal data placed into documents, comments or knowledge files), usage (AI prompts, activity and audit metadata).
- **Special categories:** the Service is not designed for special categories of personal data. The Controller decides whether to place such data in its workspace and is responsible for having a lawful basis for it.

## 5. Obligations of the Processor

The Processor will:

(a) process personal data only on the Controller's documented instructions, including with regard to transfers to third countries, unless required to do otherwise by applicable law, in which case it informs the Controller unless the law prohibits this;
(b) ensure that persons authorised to process the personal data are bound by confidentiality;
(c) take appropriate technical and organisational measures (Art. 32 GDPR, Art. 8 FADP), including those listed in Annex I;
(d) engage sub-processors only as set out in §6;
(e) assist the Controller in responding to data-subject requests, by providing self-service tooling (export, deletion) and, where that is insufficient, prompt manual support;
(f) assist the Controller in meeting its obligations on security, breach notification, data protection impact assessments and prior consultation (Art. 32–36 GDPR, Art. 22–24 FADP);
(g) notify the Controller without undue delay after becoming aware of a personal data breach affecting the Controller's data, with the information the Controller needs for its own notifications;
(h) at the Controller's choice, delete or return all personal data at the end of the Service, and delete existing copies unless the law requires retention (see §7 for backups);
(i) make available all information necessary to demonstrate compliance and allow audits as set out in §9.

## 6. Sub-processors

The Controller gives the Processor general authorisation to engage the sub-processors listed at [/legal/sub-processors](/legal/sub-processors). The Processor will notify the Controller at least 30 days in advance of any new sub-processor. If the Controller objects on reasonable data-protection grounds, the parties will work in good faith to resolve the objection; if no resolution is reached, the Controller may terminate the Service. The Processor imposes data-protection obligations on each sub-processor that are no less protective than this DPA and remains responsible for their performance.

**Providers connected by members (bring your own key).** A workspace member may connect their own AI provider account in their personal settings. When that member uses the AI features, content they send (including workspace content in the document they are working on) is transmitted to that provider on the member's instruction. Such a provider is not engaged by the Processor, is not a sub-processor under this DPA, and is not listed at [/legal/sub-processors](/legal/sub-processors). The Controller is responsible for deciding whether, and with what content, its members may use their own AI providers, and for instructing its members accordingly.

## 7. Deletion and backups

When content is deleted in the Service, or the Service ends, the Processor deletes it from the live systems. Copies remain in the Processor's encrypted database backups until these are overwritten: daily backups are kept for about 30 days, and the database provider keeps its own automatic backups for a limited period. Backups are used only to restore the Service after a failure and are not otherwise accessed.

## 8. International transfers

The Processor is established in **Switzerland**. The European Commission has recognised Switzerland as providing an adequate level of data protection, so the Controller may transfer personal data to the Processor without additional safeguards.

For onward transfers, the Processor complies with Art. 16 FADP and Chapter V GDPR:

- The Processor's main infrastructure (database, file storage, backups) is located in the EU (France). Its AI sub-processors process data in the EU and, for Mistral AI, also in EFTA countries. Switzerland recognises the EU and EEA states as adequate, and every EFTA country is either an EEA state or Switzerland.
- Where a sub-processor is located in, or may access data from, a country without an adequate level of protection, in particular the United States, the transfer relies on the EU-U.S. and Swiss-U.S. Data Privacy Framework for certified recipients, or otherwise on the European Commission's standard contractual clauses (2021/914), adapted for Swiss law.

The location and transfer mechanism of each sub-processor is published at [/legal/sub-processors](/legal/sub-processors).

## 9. Audit

The Processor will answer reasonable written questions about its compliance and make available the information necessary to demonstrate it. The Controller may carry out an audit, or have one carried out by an independent auditor bound by confidentiality, no more than once a year (except after a notified breach), on at least 30 days' notice, during business hours and without disproportionate disruption. Each party bears its own costs; the Controller reimburses the Processor's reasonable costs for audits beyond answering written questions.

## 10. Liability

Each party's liability under this DPA is subject to the liability provisions of the Terms of Service, to the extent permitted by applicable data-protection law.

## 11. Term and termination

This DPA is co-terminous with the Terms of Service. Provisions that by their nature should survive termination, including audit and post-termination deletion, survive.

---

## Annex I: Technical and organisational measures

These are the measures the Processor takes under Art. 32 GDPR and Art. 8 FADP. The Processor updates them as the Service develops, without lowering the overall level of protection. The Processor holds no security certification of its own.

### 1. Encryption

- **In transit:** all connections between browsers and the Service use TLS (HTTPS and secure WebSockets), with HTTP Strict Transport Security. Connections to the managed database use TLS.
- **At rest:** the managed database and object storage are encrypted at rest by the hosting provider. Database backups are additionally encrypted (GPG) before they leave the server.
- **Secrets:** stored AI provider keys and internal AI-proxy keys are encrypted with AES-256-GCM. Personal access tokens are stored only as SHA-256 hashes, and document passwords only as scrypt hashes.

### 2. Access control

- **Users:** sign-in only through established identity providers (GitHub, Google); session cookies are HTTP-only, `SameSite=Lax` and revocable ("log out everywhere"); sensitive actions require a recent sign-in; every state-changing request is checked against cross-site request forgery.
- **Authorisation:** access to each document is checked on every request according to its access mode and the member's workspace role; real-time editing requires a short-lived, document-scoped token; file links expire after two minutes.
- **Operators:** administrative access to servers is limited to named staff, by SSH key only (no passwords, no root login), behind a host firewall with brute-force protection. Administrative functions in the application require an explicit administrator flag and are recorded in the audit log.

### 3. Separation and network segmentation

- Each internal service runs in its own container, connected only to the networks it needs (for example, the document renderer and the file converter cannot reach the database). Internal networks have no internet access.
- The database uses separate roles per service, each owning only its own database.
- Rendered document previews run in sandboxed frames isolated from the application, and the server-side renderer may only load an allowlist of origins.
- A strict Content-Security-Policy limits which scripts and resources browsers may load.

### 4. Container and host hardening

- Containers run without Linux capabilities, without privilege escalation and, where possible, as non-root users with read-only file systems.
- The server-side renderer uses Chromium's own sandbox with a restricted system-call profile.
- The host operating system is hardened following CIS-aligned baselines and installs security updates automatically.

### 5. Availability and backups

- Daily encrypted database backups, kept for about 30 days, stored in a separate storage bucket; the managed database provider keeps its own automatic backups.
- Health checks on every service, automatic restarts, and a documented rollback procedure for deployments.
- Rate limits and size limits protect against overload and abuse.

### 6. Logging and monitoring

- A security audit log records access-control changes, deletions, administrative and other security-relevant actions, with IP addresses shortened (IPv4 to /24, IPv6 to /48). Entries are deleted automatically after 2 years.
- Application errors are reported to an error-monitoring service in the EU region; cookies and authorisation headers are removed from error reports.
- Operational alerts (backups, deployments, updates) are sent to the operators.

### 7. Incident response

A documented data-breach response procedure covers detection, containment, assessment, notification of the supervisory authorities within the legal deadlines (72 hours under the GDPR; as soon as possible under the FADP), notification of controllers and affected persons, and post-incident review. Every incident is recorded.

### 8. Secure development and vulnerability management

- All code changes are reviewed and must pass automated tests, type checks, static analysis and secret scanning before release.
- Dependencies are monitored and updated automatically; container images are scanned for known vulnerabilities weekly and on every dependency change.
- Release images are signed and published with a software bill of materials; deployments use pinned versions.
- Secrets are never stored in the code repository and are rotated following a documented procedure.

### 9. Data minimisation and deletion

- Only data needed for the Service is collected; IP addresses are shortened before storage; uploaded knowledge-base originals are deleted after processing.
- Automatic deletion jobs enforce retention periods (for example AI records after 90 days, anonymous documents 30 days after their last edit, unconfirmed uploads after 24 hours, audit-log entries after 2 years).
- Users can export and delete their data themselves.

### 10. Sub-processors

Sub-processors are selected for their data-protection and security practices and bound by data-processing agreements. Where they publish security certifications (for example ISO/IEC 27001 for cloud hosting), the Processor relies on them as part of its due diligence; their current certifications are published by each provider.

## Annex II: Sub-processors

See [/legal/sub-processors](/legal/sub-processors) for the current list, including the location and transfer mechanism of each sub-processor.

---

This is **version {{currentVersion}}**, effective **{{effectiveDate}}**.

- **v3 (2026-11-03).** Transfers described from the position of a Swiss processor (EU adequacy for Switzerland, Art. 16 FADP for onward transfers); FADP references alongside the GDPR; deletion and backup retention; audit procedure; a full Annex I of technical and organisational measures.
- **v2 (2026-10-26).** Members' own (bring-your-own-key) AI providers are not sub-processors.
- **v1 (2026-05-04).** Initial publication.
