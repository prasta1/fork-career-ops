---
name: career-ops-plugin-hubspot
description: How to mirror the career-ops tracker to HubSpot deals.
license: MIT
---

# hubspot plugin

Mirrors your application tracker to HubSpot deals. `data/applications.md`
stays the source of truth — HubSpot is an additive mirror. One deal per
tracker row, named `Company - Role`; that name is the dedup key. Each deal is
linked to a Company record matched by exact name and created (name only, no
domain) when missing — add domains in HubSpot yourself if you want enrichment.
Each deal also gets one "Job posting: <url>" note, the URL read from the row's
report header (`**URL:**`), and one dated note per `data/follow-ups.md` row logged
against that tracker # (`Follow-up #N (date, channel) → contact: notes`). Notes
already on the deal are never duplicated.

## Commands

- `node plugins.mjs run hubspot export --dry-run` — list every deal that would
  be created or moved. Zero network.
- `node plugins.mjs run hubspot export` — upsert. New rows create a deal with
  name, pipeline, stage and a description (`career-ops #N · score X/5 ·
  status S · reports/…`). Existing deals only get their stage moved, and only
  when it differs, so notes you typed in HubSpot survive.

## Setup

1. HubSpot → Settings → Integrations → Private Apps → Create. Scopes:
   `crm.objects.deals.read`, `crm.objects.deals.write`,
   `crm.objects.companies.read`, `crm.objects.companies.write`, and — required
   by HubSpot's Notes API even for deal notes — `crm.objects.contacts.read`,
   `crm.objects.contacts.write`.
2. Put the token in `.env`: `HUBSPOT_ACCESS_TOKEN=pat-na1-…`
3. `node plugins.mjs enable hubspot --confirm` (already done if you're reading
   this via `plugins.mjs skill`).

## Stage mapping

Tracker status → stage in the portal's "Job Search Pipeline" (id `default`).
Deals only move forward, so a stage you set by hand (Researching, Outreach /
Network) is never undone by an older tracker status.

| Status | Stage label | Stage id |
|---|---|---|
| Evaluated | Identified | appointmentscheduled |
| Applied, Responded | Applied | 1433346584 |
| Interview | Interviewing | 1433346930 |
| Offer | Offer | 1433345082 |
| Hired | Closed Won - Hired | 10837143 |
| Rejected, Discarded | Closed Lost | closedlost |
| SKIP | never mirrored | — |

Override in `config/plugins.yml` (stage ids, not labels — find them under
Settings → Objects → Deals → Pipelines):

```yaml
plugins:
  hubspot:
    enabled: true
    pipeline: default
    stages:
      Responded: 1433346930   # e.g. treat a reply as Interviewing instead
```
