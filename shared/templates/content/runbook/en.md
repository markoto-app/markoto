<!-- An on-call runbook for one service or platform. The title block prints the title, the services covered (subtitle), the owning team and the date; the date is on every page because printouts go stale. Section numbers come from the design, so "see 3.2" works on a call. -->

# How to use this runbook

<!-- Two or three sentences: who this is for, which services it covers, and how a procedure is laid out (the alert that sends you here, then steps in order). Ask the reader to log what they do in the incident channel as they go. -->

> [!IMPORTANT]
> If customers are affected and you have not found the cause within 15 minutes, declare an incident and page the incident commander.

## Before your shift

<!-- A checklist the engineer ticks at handover: access works, tokens are valid, the pager reaches them, they have read the handover notes. Put the command that proves each point in backticks. -->

- [ ] You can reach the production environment: `command to check access`.
- [ ] Your credentials are valid for the whole shift.
- [ ] The pager app is installed and a test page reached you.
- [ ] You have read the handover notes.

# Severity levels

<!-- One row per level, most severe first. Definition in customer terms, a concrete example with a threshold, and what the level requires (who to page, when the status page is updated). -->

| Level | Definition | Examples | Response |
|---|---|---|---|
| SEV-1 | | | |
| SEV-2 | | | |
| SEV-3 | | | |

# Procedures

<!-- One H2 per alert, named exactly as the alert is named in the pager, so the engineer can search for it. Open with the bold "Alert:" line (condition and threshold), then numbered steps in the order to do them: what to check, the exact command, what result means what, and when to escalate. Put multi-line commands in a code block inside the step. Copy the procedure block for each further alert. -->

## AlertName

**Alert:** Condition and threshold that fire it.

1. Check the dashboard for the affected component.
2. Look at the most recent change:
   ```bash
   command --to-run
   ```
3. If the change is the cause, roll it back. Otherwise go to step 4.
4. Confirm the alert clears within a few minutes. If it does not, escalate.

<!-- Use an alert where a step can make things worse: > [!WARNING] for a risky command, > [!CAUTION] for something that loses data. -->

## SecondAlertName

**Alert:** Condition and threshold that fire it.

1. Step one.
2. Step two.

> [!WARNING]
> What must not be done here, and why.

---

# Escalation

<!-- Who to call when the procedure does not help: one row per area, a first and a second contact (roles, not only names), the hours they cover, and how to reach them (pager handle, phone entry). -->

| Area | First contact | Second contact | Hours | How |
|---|---|---|---|---|
| Incident commander | | | 24/7 | |
| | | | | |

# After the incident

<!-- What must be done before the incident is closed. Keep it to the items people forget. -->

- [ ] The incident channel has a timeline with UTC timestamps.
- [ ] Temporary changes are listed with an owner and an expiry.
- [ ] A post-incident review is scheduled.
- [ ] The status page entry is resolved.

# Quick reference

<!-- Lookup tables for the middle of the night: where the dashboards and status pages are, and the commands used most often, with placeholders in angle brackets. -->

## Dashboards and links

| What | Where |
|---|---|
| Service overview | |
| Logs | |

## Commands

| Task | Command |
|---|---|
| Recent logs | `command <service>` |
| Roll back | `command <service>` |
