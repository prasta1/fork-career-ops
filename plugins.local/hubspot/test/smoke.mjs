// Zero-network check: the entry imports cleanly, exposes the manifest's hooks,
// and the tracker-row → deal-properties mapping holds for the cases that matter.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = ['provider', 'ingest', 'search', 'notify', 'export'];

const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
const mod = await import(path.join(here, '..', manifest.entry || 'index.mjs'));
const hooks = mod.default;

assert(hooks && typeof hooks === 'object', 'default export must be an object of hooks');
for (const k of Object.keys(hooks)) assert(KINDS.includes(k), `unknown hook "${k}"`);
for (const h of manifest.hooks) assert(typeof hooks[h] === 'function', `manifest declares hook "${h}" but index.mjs does not export it`);

const { dealProps } = mod;
const row = { '#': '12', company: 'Acme', role: 'Head of CS', score: '**4.2/5**', status: 'Applied', report: '[012](../reports/012-acme-2026-09-01.md)' };
const p = dealProps(row, {});
assert.equal(p.dealname, 'Acme - Head of CS');
assert.equal(p.pipeline, 'default');
assert.equal(p.dealstage, '1433346584'); // Applied
assert.match(p.description, /4\.2\/5/);
assert.match(p.description, /#12/);
assert.match(p.description, /reports\/012-acme-2026-09-01\.md/);

// Aliases resolve through templates/states.yml; SKIP rows are never mirrored.
assert.equal(dealProps({ ...row, status: '**entrevista**' }).dealstage, '1433346930'); // Interviewing
assert.equal(dealProps({ ...row, status: 'SKIP' }), null);
// Closed-lost rows carry the tracker note as the closed-lost reason; open rows don't.
assert.equal(dealProps({ ...row, status: 'Discarded', notes: 'no GSI evidence' }).closed_lost_reason, 'no GSI evidence');
assert.equal(dealProps({ ...row, notes: 'no GSI evidence' }).closed_lost_reason, undefined);
assert.equal(dealProps({ ...row, role: '' }), null);
// Settings override the stage map and pipeline.
assert.equal(dealProps(row, { pipeline: 'p9', stages: { Applied: 'stage_x' } }).dealstage, 'stage_x');
assert.equal(dealProps(row, { pipeline: 'p9' }).pipeline, 'p9');

// Forward-only moves: hand-set Researching is never undone by Evaluated; Rejected still closes.
const { movesForward } = mod;
assert.equal(movesForward('1433346929', 'appointmentscheduled'), false);
assert.equal(movesForward('appointmentscheduled', '1433346584'), true);
assert.equal(movesForward('1433346929', 'closedlost'), true);
assert.equal(movesForward('1433346584', '1433346584'), false);
assert.equal(movesForward('custom_x', '1433346584'), true);

// Posting URL comes from the report header line and nothing else.
const { parsePostingUrl } = mod;
assert.equal(parsePostingUrl('# Evaluation\n\n**Date:** 2026-09-01\n**URL:** https://jobs.example.com/x/123\n**Score:** 4/5'), 'https://jobs.example.com/x/123');
assert.equal(parsePostingUrl('**Score:** 4/5\nsee https://elsewhere.example.com'), null);

// Follow-up rows parse by tracker #; header, separator and pin lines are ignored.
const { parseFollowUps } = mod;
const fu = parseFollowUps('# Follow-ups\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 11 | 2026-09-07 | Hightouch | AI Strategy Consultant | LinkedIn | Hannah F | asked if open |\n- next #62 2026-09-08 (set 2026-09-05)\n');
assert.deepEqual([...fu.keys()], ['11']);
assert.deepEqual(fu.get('11')[0], { num: '1', date: '2026-09-07', channel: 'LinkedIn', contact: 'Hannah F', notes: 'asked if open' });

console.log('✓ smoke ok:', Object.keys(hooks).join(', '));
