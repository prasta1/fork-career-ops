// @ts-check
// HubSpot plugin — mirror the tracker to HubSpot deals (export).
//
// data/applications.md stays the source of truth; HubSpot is an OPT-IN MIRROR.
// One deal per tracker row, named "Company - Role" — the portal's existing
// naming convention, and the dedup key. Deal stage follows tracker status via
// STAGES. Each deal is linked to a Company record matched by exact name
// (created with just the name when missing — reports carry no domain).
// Lives entirely behind `node plugins.mjs run hubspot`; never runs during a scan.
//
//   node plugins.mjs run hubspot export --dry-run   # preview, zero network
//   node plugins.mjs run hubspot export             # upsert deals

import { canonicalStatus } from '../../plugins/notion/_notion.mjs';
import { parseScore } from '../../plugins/notion/index.mjs';

const HUB = 'https://api.hubapi.com/crm';
const DEALS = `${HUB}/v3/objects/deals`;
const COMPANIES = `${HUB}/v3/objects/companies`;

// Canonical tracker state → stage id in the portal's "Job Search Pipeline"
// (HubSpot pipeline id "default"). Ids are portal-specific: the labels shown in
// the UI are custom, and several stages have no tracker equivalent
// (Researching, Outreach / Network) — those are moved by hand only.
// Override any entry in config/plugins.yml under plugins.hubspot.stages.
// SKIP is deliberately absent: a role you decided not to pursue never becomes a deal.
const STAGES = {
  Evaluated: 'appointmentscheduled', // Identified
  Applied: '1433346584',             // Applied
  Responded: '1433346584',           // Applied — no "Responded" stage; a reply is still pre-interview
  Interview: '1433346930',           // Interviewing
  Offer: '1433345082',               // Offer
  Hired: '10837143',                 // Closed Won - Hired
  Rejected: 'closedlost',            // Closed Lost
  Discarded: 'closedlost',           // Closed Lost
};

// Pipeline display order. Deals only ever move FORWARD along it, so a stage you
// set by hand (e.g. Researching) is never undone by an older tracker status.
const STAGE_ORDER = ['appointmentscheduled', '1433346929', 'decisionmakerboughtin', '1433346584', '1433346930', '1433345082', '10837143', 'closedlost'];

/**
 * Should a deal currently at `from` be moved to `to`?
 * True only for a forward move; a stage not in STAGE_ORDER (custom override) always moves.
 * @param {string|undefined} from
 * @param {string} to
 */
export function movesForward(from, to) {
  if (!from || from === to) return false;
  const a = STAGE_ORDER.indexOf(from), b = STAGE_ORDER.indexOf(to);
  return a === -1 || b === -1 || b > a;
}

/**
 * Map one tracker row to HubSpot deal properties.
 * @param {Record<string,string>} row  Tracker row keyed by lowercased header (#, company, role, score, status, report…).
 * @param {{ pipeline?: string, stages?: Record<string,string> }} [settings]  Non-secret overrides from config/plugins.yml.
 * @returns {{ dealname: string, pipeline: string, dealstage: string, description: string } | null}
 *   null when the row must not be mirrored: missing company/role, SKIP, or a status with no stage.
 */
export function dealProps(row, settings = {}) {
  const company = (row.company || '').trim();
  const role = (row.role || '').trim();
  if (!company || !role) return null;
  const status = canonicalStatus(row.status);
  const dealstage = status && { ...STAGES, ...(settings.stages || {}) }[status];
  if (!dealstage) return null;
  const score = parseScore(row.score);
  // Report cell is a markdown link; keep the root-relative path so it's findable from HubSpot.
  const report = (row.report || '').match(/\((?:\.\.\/)?(reports\/[^)]+)\)/)?.[1];
  const description = [
    `career-ops #${row['#'] || '?'}`,
    Number.isFinite(score) ? `score ${score}/5` : null,
    `status ${status}`,
    report,
  ].filter(Boolean).join(' · ');
  return { dealname: `${company} - ${role}`, pipeline: settings.pipeline || 'default', dealstage, description };
}

export default {
  /**
   * export: upsert each tracker row as a HubSpot deal.
   * Create sends every property; update sends only dealstage (and only when it
   * changed), so notes you typed into a deal's description in HubSpot survive.
   * @param {{ applications: Array<Record<string,string>> }} snapshot  Frozen read-only tracker view.
   * @param {any} ctx  Engine context: env, settings, fetchJson (allowedHosts-guarded), log, dryRun.
   */
  async export(snapshot, ctx) {
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    const wanted = rows.map(row => ({ company: (row.company || '').trim(), props: dealProps(row, ctx.settings) })).filter(w => w.props);
    if (ctx.dryRun) {
      for (const { company, props } of wanted) ctx.log(`would upsert: ${props.dealname} → ${props.dealstage}  (link company: ${company})`);
      return { pushed: wanted.length };
    }

    const headers = { Authorization: `Bearer ${ctx.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
    const call = async (url, method, body) => {
      // ponytail: fixed pacing stays under HubSpot's 4 req/s search limit; add 429 backoff if it ever bites
      await new Promise(r => setTimeout(r, 250));
      return ctx.fetchJson(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    };
    const searchByName = (base, prop, value) => call(`${base}/search`, 'POST', {
      filterGroups: [{ filters: [{ propertyName: prop, operator: 'EQ', value }] }], properties: [prop, 'dealstage'], limit: 1,
    });

    // Company id by exact name, resolved once per run (many rows share a company).
    const companyIds = new Map();
    const companyId = async (name) => {
      if (companyIds.has(name)) return companyIds.get(name);
      let id = (await searchByName(COMPANIES, 'name', name))?.results?.[0]?.id;
      if (!id) { id = (await call(COMPANIES, 'POST', { properties: { name } })).id; ctx.log(`created company: ${name}`); }
      companyIds.set(name, id);
      return id;
    };

    let pushed = 0;
    for (const { company, props } of wanted) {
      const cid = await companyId(company);
      const hit = (await searchByName(DEALS, 'dealname', props.dealname))?.results?.[0];
      let dealId = hit?.id;
      if (!hit) { dealId = (await call(DEALS, 'POST', { properties: props })).id; ctx.log(`created: ${props.dealname}`); }
      else if (movesForward(hit.properties?.dealstage, props.dealstage)) { await call(`${DEALS}/${hit.id}`, 'PATCH', { properties: { dealstage: props.dealstage } }); ctx.log(`moved: ${props.dealname} → ${props.dealstage}`); }
      // ponytail: idempotent PUT every run (60 cheap calls) beats a per-deal GET to check whether the link already exists
      await call(`${HUB}/v4/objects/deals/${dealId}/associations/default/companies/${cid}`, 'PUT');
      pushed++;
    }
    return { pushed };
  },
};
