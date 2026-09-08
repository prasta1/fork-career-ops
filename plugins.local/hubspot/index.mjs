// @ts-check
// HubSpot plugin — mirror the tracker to HubSpot deals (export).
//
// data/applications.md stays the source of truth; HubSpot is an OPT-IN MIRROR.
// One deal per tracker row, named "Company - Role" — the portal's existing
// naming convention, and the dedup key. Deal stage follows tracker status via
// STAGES. Each deal is linked to a Company record matched by exact name
// (created with just the name when missing — reports carry no domain), and
// gets a "Job posting: <url>" note, the URL read from the row's report header,
// plus one dated note per data/follow-ups.md row logged against that tracker #.
// Lives entirely behind `node plugins.mjs run hubspot`; never runs during a scan.
//
//   node plugins.mjs run hubspot export --dry-run   # preview, zero network
//   node plugins.mjs run hubspot export             # upsert deals

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStatus } from '../../plugins/notion/_notion.mjs';
import { parseScore } from '../../plugins/notion/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HUB = 'https://api.hubapi.com/crm';
const DEALS = `${HUB}/v3/objects/deals`;
const COMPANIES = `${HUB}/v3/objects/companies`;
const NOTES = `${HUB}/v3/objects/notes`;
const NOTE_TO_DEAL = 214; // HubSpot-defined association type id

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
  const props = { dealname: `${company} - ${role}`, pipeline: settings.pipeline || 'default', dealstage, description };
  // A closed-lost deal carries the tracker note as HubSpot's stock closed-lost reason.
  if (dealstage === 'closedlost' && (row.notes || '').trim()) props.closed_lost_reason = row.notes.trim();
  return props;
}

/**
 * Posting URL from a report's header (`**URL:** https://…`), or null.
 * @param {string} text  Report markdown.
 */
export function parsePostingUrl(text) {
  return String(text ?? '').match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m)?.[1] ?? null;
}

/**
 * Follow-up rows from a data/follow-ups.md table, keyed by tracker #.
 * Header, separator and `- next #N …` pin lines are ignored.
 * @param {string} text
 * @returns {Map<string, Array<{num:string,date:string,channel:string,contact:string,notes:string}>>}
 */
export function parseFollowUps(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('| ')) continue;
    const c = line.split('|').slice(1, -1).map(x => x.trim());
    if (!/^\d+$/.test(c[0]) || !/^\d+$/.test(c[1])) continue;
    const [num, app, date, , , channel, contact, notes] = c;
    if (!out.has(app)) out.set(app, []);
    out.get(app).push({ num, date, channel, contact, notes });
  }
  return out;
}

function followUpsByApp() {
  try { return parseFollowUps(readFileSync(join(ROOT, 'data', 'follow-ups.md'), 'utf8')); } catch { return new Map(); }
}

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Posting URL for a tracker row: a URL cell if the tracker has one, else its report's header. */
function postingUrl(row) {
  if (/^https?:\/\//i.test(row.url || '')) return row.url.trim();
  const report = (row.report || '').match(/\((?:\.\.\/)?(reports\/[^)]+)\)/)?.[1];
  if (!report) return null;
  try { return parsePostingUrl(readFileSync(join(ROOT, report), 'utf8')); } catch { return null; }
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
    const followUps = followUpsByApp();
    // Every note a deal should carry: the posting URL, then one per logged follow-up.
    // `key` is the dedup marker searched for in existing note bodies.
    const notesFor = (row, url) => {
      const list = [];
      if (url) list.push({ key: url, body: `Job posting: <a href="${url.replace(/"/g, '%22')}">${url}</a>`, ts: new Date().toISOString() });
      for (const f of followUps.get((row['#'] || '').trim()) || []) {
        list.push({ key: `Follow-up #${f.num} (`, body: esc(`Follow-up #${f.num} (${f.date}, ${f.channel}) → ${f.contact}: ${f.notes}`), ts: `${f.date}T12:00:00Z` });
      }
      return list;
    };
    const wanted = rows.map(row => ({ company: (row.company || '').trim(), notes: notesFor(row, postingUrl(row)), props: dealProps(row, ctx.settings) })).filter(w => w.props);
    if (ctx.dryRun) {
      for (const { company, notes, props } of wanted) ctx.log(`would upsert: ${props.dealname} → ${props.dealstage}  (link company: ${company}; notes: ${notes.map(n => n.key.startsWith('http') ? 'posting URL' : n.key.replace(' (', '')).join(', ') || 'none'})`);
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

    // Ensure each desired note exists on the deal. Fresh deals have no notes, so
    // only existing deals are searched (once per deal); a note whose body already
    // carries the key is left alone.
    const ensureNotes = async (dealId, notes, isNew, dealname) => {
      if (!notes.length) return;
      let existing = [];
      if (!isNew) {
        const found = await call(`${NOTES}/search`, 'POST', {
          filterGroups: [{ filters: [{ propertyName: 'associations.deal', operator: 'EQ', value: String(dealId) }] }], properties: ['hs_note_body'], limit: 100,
        });
        existing = (found?.results || []).map(n => n.properties?.hs_note_body || '');
      }
      for (const n of notes) {
        if (existing.some(b => b.includes(n.key))) continue;
        await call(NOTES, 'POST', {
          properties: { hs_timestamp: n.ts, hs_note_body: n.body },
          associations: [{ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_DEAL }] }],
        });
        ctx.log(`noted: ${dealname} ← ${n.key.startsWith('http') ? n.key : n.key.replace(' (', '')}`);
      }
    };

    let pushed = 0;
    for (const { company, notes, props } of wanted) {
      const cid = await companyId(company);
      const hit = (await searchByName(DEALS, 'dealname', props.dealname))?.results?.[0];
      let dealId = hit?.id;
      if (!hit) { dealId = (await call(DEALS, 'POST', { properties: props })).id; ctx.log(`created: ${props.dealname}`); }
      else if (movesForward(hit.properties?.dealstage, props.dealstage)) {
        const { dealstage, closed_lost_reason } = props;
        await call(`${DEALS}/${hit.id}`, 'PATCH', { properties: closed_lost_reason ? { dealstage, closed_lost_reason } : { dealstage } });
        ctx.log(`moved: ${props.dealname} → ${dealstage}`);
      }
      // ponytail: idempotent PUT every run (60 cheap calls) beats a per-deal GET to check whether the link already exists
      await call(`${HUB}/v4/objects/deals/${dealId}/associations/default/companies/${cid}`, 'PUT');
      await ensureNotes(dealId, notes, !hit, props.dealname);
      pushed++;
    }
    return { pushed };
  },
};
