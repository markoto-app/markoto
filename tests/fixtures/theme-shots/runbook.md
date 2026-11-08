<!--
  Fixture: runbook — template "On-call runbook" (Engineering).
  Stresses: short procedures with numbered steps containing inline commands
  and shell blocks inside list items; many short `bash` blocks; task-list
  checklists (checked + unchecked, nested); an escalation table and an alert
  reference table with long cells; caution/warning/important alerts; a
  quick-reference section of dense tables; a scene of h3s that are short, so
  headings land near page ends; a horizontal rule.
  Suggested title: "Checkout platform — on-call runbook". Patch: runbook-patch.json.
-->

# How to use this runbook

This runbook is for the engineer on call for the **checkout platform** (services `cart-api`, `checkout-api`, `payment-gateway`, `order-events`). Each procedure starts with the alert that sends you here, then lists what to check and what to do, in order. Do the steps in sequence unless a step says otherwise, and write what you did in the incident channel as you go — the timeline is easier to reconstruct while it is happening.

> [!IMPORTANT]
> If customers cannot pay and you have not found the cause within **15 minutes**, declare a SEV-1 and page the incident commander. Declaring early is cheap; declaring late is not.

## Before your shift

- [ ] You can log in to the production cluster: `kubectl --context prod-eu get ns checkout`.
- [ ] Your `vault` token is valid for at least 12 hours: `vault token lookup -format=json | jq .data.ttl`.
- [ ] The pager app is installed, notifications are allowed, and the escalation test page from Monday reached you.
- [ ] You have read the handover notes in `#checkout-oncall`, in particular:
  - [ ] open incidents and their follow-ups,
  - [ ] deploys that are frozen or pinned,
  - [ ] planned maintenance by the payment providers.
- [x] You know where the dashboards are (bookmark **Checkout / Overview**).

# Severity levels

| Level | Definition | Examples | Response |
|---|---|---|---|
| SEV-1 | Customers cannot complete payments, or data is being lost | Checkout error rate > 5 % for 5 min; orders not persisted | Page IC immediately, status page within 15 min |
| SEV-2 | Degraded checkout for a subset of customers or one payment method | One provider failing; p99 latency > 3 s | Incident channel, IC optional, status page if > 30 min |
| SEV-3 | No customer impact yet, but one is likely | Queue backlog growing; certificate expires in < 7 days | Fix during working hours; ticket |
| SEV-4 | Cosmetic or internal-only | Dashboard panel broken | Ticket |

# Procedures

## CheckoutErrorRateHigh

**Alert:** `checkout-api` 5xx rate above 2 % over 5 minutes.

1. Open **Checkout / Overview** and check whether errors are concentrated on one endpoint, one pod or one payment method.
2. Look at the most recent deploy:
   ```bash
   kubectl --context prod-eu -n checkout rollout history deploy/checkout-api | tail -3
   ```
   If a deploy finished in the last 30 minutes, roll it back (step 5) before investigating further.
3. Check the error breakdown in the logs:
   ```bash
   logcli query --since=15m '{app="checkout-api"} |= "level=error"' \
     | jq -r '.error_code' | sort | uniq -c | sort -rn | head
   ```
4. If the top error is `PROVIDER_TIMEOUT`, go to [PaymentProviderDegraded](#paymentproviderdegraded).
5. To roll back:
   ```bash
   kubectl --context prod-eu -n checkout rollout undo deploy/checkout-api
   kubectl --context prod-eu -n checkout rollout status deploy/checkout-api --timeout=5m
   ```
6. Confirm the error rate falls within 5 minutes. If it does not, the deploy was not the cause — escalate.

## PaymentProviderDegraded

**Alert:** success rate for one provider below 90 % over 10 minutes, or provider p99 latency above 4 s.

1. Check the provider's status page (links in the [quick reference](#quick-reference)) and our provider dashboard. Provider incidents are usually announced 10–20 minutes after we see them.
2. Find out how much traffic is affected: `curl -s localhost:9090/api/v1/query --data-urlencode 'query=sum by (provider) (rate(payment_attempts_total[5m]))'` via the Prometheus port-forward.
3. If the provider handles **less than 30 %** of traffic, fail it over to the secondary for its payment methods:
   ```bash
   gatewayctl route set --method card --region EU --primary stripeless --secondary adyenne \
     --reason "INC-$(date +%Y%m%d)-provider-degraded" --ttl 2h
   ```
4. If it handles more than 30 %, do **not** fail over alone: the secondary's rate limits are lower. Page the payments lead, who can raise them with the provider.
5. Post the change in `#checkout-oncall` with the command you ran and its TTL.

> [!WARNING]
> `gatewayctl route set` without `--ttl` makes the change permanent. A forgotten permanent route cost us 0.4 % in authorisation rate for nine days in March.

## OrderEventsBacklog

**Alert:** consumer lag on topic `order-events` above 50,000 messages for 10 minutes.

1. Check whether the consumers are running and how many there are:
   ```bash
   kubectl --context prod-eu -n checkout get pods -l app=order-events-consumer
   ```
2. If pods are crash-looping, read the last crash: `kubectl logs -p <pod> --tail=100`.
3. If they are healthy but slow, scale out (the topic has 48 partitions, so more than 48 consumers do nothing):
   ```bash
   kubectl --context prod-eu -n checkout scale deploy/order-events-consumer --replicas=24
   ```
4. Watch the lag for 10 minutes. It should fall by at least 5,000 messages per minute.
5. If one partition stays stuck while the others drain, a poison message is likely. Find its offset:
   ```bash
   kafkactl describe consumer-group order-events-consumer | awk '$5 > 1000'
   ```
   and skip it **only** after copying it to the dead-letter topic:
   ```bash
   kafkactl consume order-events --partition 17 --offset 88412093 --max-messages 1 -o json > /tmp/poison.json
   kafkactl produce order-events-dlq --file /tmp/poison.json
   kafkactl reset offset order-events-consumer --topic order-events --partition 17 --offset 88412094 --execute
   ```

> [!CAUTION]
> Never reset offsets for the whole group. Skipping unprocessed order events means orders that were paid for are never fulfilled.

## DatabaseConnectionsSaturated

**Alert:** `checkout-db` connections above 90 % of `max_connections` for 5 minutes.

1. See who holds the connections:
   ```sql
   SELECT usename, application_name, state, count(*)
   FROM pg_stat_activity
   GROUP BY 1, 2, 3
   ORDER BY 4 DESC;
   ```
2. Long `idle in transaction` sessions usually mean a stuck worker. Note the PIDs and the `application_name`.
3. Restart the offending deployment rather than killing backends one by one.
4. If the cause is a traffic spike, check that PgBouncer is in transaction mode: `SHOW CONFIG;` on the bouncer admin console must print `pool_mode = transaction`.

## CertificateExpiringSoon

**Alert:** a TLS certificate served by the ingress expires in less than 14 days.

1. List certificates and their expiry: `kubectl get certificate -A -o wide`.
2. If `READY` is `False`, describe it and read the last event: `kubectl describe certificate <name> -n <ns>`.
3. Most failures are DNS-01 challenges that cannot write the TXT record. Check the DNS provider token in Vault: `vault kv get secret/cert-manager/dns`.
4. Trigger a renewal after fixing the cause: `cmctl renew <name> -n <ns>`.

---

# Escalation

| Area | First contact | Second contact | Hours | How |
|---|---|---|---|---|
| Incident commander | IC rotation | Head of engineering | 24/7 | Pager: `ic-primary` |
| Payments | Payments on-call | Daniel Osei | 24/7 | Pager: `payments-oncall` |
| Database | Storage on-call | Lena Vogt | 24/7 | Pager: `storage-oncall` |
| Network / CDN | Platform on-call | — | 24/7 | Pager: `platform-oncall` |
| Payment provider (Stripeless) | Merchant support line | Technical account manager | 24/7 (support), office hours (TAM) | Phone in the provider vault entry; quote merchant ID `MX-44812` |
| Legal / data protection | DPO on-call | General counsel | Office hours; DPO on-call for breaches only | E-mail `dpo@` + pager `dpo-breach` |

# After the incident

- [ ] The incident channel has a timeline with UTC timestamps.
- [ ] Temporary changes (routes, scaling, feature flags) are listed with their owners and expiry.
- [ ] A post-incident review is scheduled within five working days for SEV-1 and SEV-2.
- [ ] Customer-facing status page entries are resolved.

# Quick reference

## Dashboards and links

| What | Where |
|---|---|
| Checkout overview | Grafana → Checkout / Overview |
| Provider health | Grafana → Payments / Providers |
| Logs | `logcli` or Grafana → Explore → Loki |
| Status page admin | status admin → Components → Checkout |
| Stripeless status | `status.stripeless.example` |
| Adyenne status | `status.adyenne.example` |

## Commands

| Task | Command |
|---|---|
| Pods of a service | `kubectl -n checkout get pods -l app=<svc>` |
| Recent logs | `kubectl -n checkout logs deploy/<svc> --since=10m` |
| Roll back | `kubectl -n checkout rollout undo deploy/<svc>` |
| Scale | `kubectl -n checkout scale deploy/<svc> --replicas=<n>` |
| Feature flag off | `flagctl set checkout.<flag> false --env prod --reason <INC>` |
| Provider route | `gatewayctl route show --method card --region EU` |
| DB console (read-only) | `psql "$(vault kv get -field=ro_url secret/checkout-db)"` |

## Port-forwards

```bash
kubectl --context prod-eu -n monitoring port-forward svc/prometheus 9090:9090 &
kubectl --context prod-eu -n checkout port-forward svc/checkout-db-bouncer 6432:6432 &
```
