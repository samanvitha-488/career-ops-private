#!/usr/bin/env node
// Export data/applications.md + data/discard.log as JSON for the "Job Hunt Tracker" dashboard artifact
// (https://claude.ai/artifact/XTLp6UN5WCW8x2UuVe9EqB). Run after every scan/apply batch, then re-upload.
// Usage: node export-tracker-dashboard.mjs <out_dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const outDir = process.argv[2] || path.join(root, 'output');
fs.mkdirSync(outDir, { recursive: true });

const md = fs.readFileSync(path.join(root, 'data/applications.md'), 'utf8');
// Duplicate-check log from dedup-check.mjs (latest check per tracker #).
const checks = [];
try {
  const [head, ...lines] = fs.readFileSync(path.join(root, 'data/dedup-checks.tsv'), 'utf8').split('\n').filter(Boolean);
  const cols = head.split('\t');
  for (const l of lines) { const v = l.split('\t'); checks.push(Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']))); }
} catch {}
const lastCheck = new Map();
for (const c of checks) if (c.num) lastCheck.set(Number(c.num), c);
const tick = (v) => (v === 'hit' ? '✗' : v === 'weak' ? '?' : v === 'clear' ? '✓' : '–');
const dupLabel = (c) => !c ? 'Not checked (before rule)' :
  `${c.outcome === 'duplicate' ? 'Duplicate' : c.outcome === 'possible' ? 'Possible duplicate' : 'Clear'} · Tracker ${tick(c.tracker)} · Tsenta ${tick(c.tsenta)} · Inbox ${tick(c.inbox)}${c.inbox_as_of ? ' (emails as of ' + c.inbox_as_of.slice(5, 10).replace('-', '/') + ')' : ''}`;

const rows = [];
for (const line of md.split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(line)) continue;
  const c = line.split('|').slice(1, -1).map((s) => s.trim());
  // Some rows carry an extra "Via" column shift; tracker header: # Date Company Via Role Score Status PDF Report Notes
  if (c.length < 10) continue;
  const [num, date, company, viaCell, role, score, status, , report] = c;
  const notes = c.slice(9).join(' | ');
  const rep = (report.match(/\(\.\.\/(reports\/[^)]+)\)/) || [])[1];
  let url = '';
  if (rep) {
    try {
      const r = fs.readFileSync(path.join(root, rep), 'utf8');
      url = (r.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1] || '';
    } catch {}
  }
  const via = viaCell && viaCell !== '—' ? viaCell : /tsenta/i.test(notes) && status === 'Applied' ? 'Tsenta' : '';
  rows.push({ num: Number(num), date, company, via, role, score: parseFloat(score) || null, status, notes, url, ...classify(status, notes, parseFloat(score) || null), dupcheck: dupLabel(lastCheck.get(Number(num))) });
}

function classify(status, n, score) {
  const s = status.toLowerCase();
  if (s === 'applied' && /DUPLICATE SUBMISSION/.test(n)) return { group: 'Applied', reason: 'Applied twice (Gmail + Outlook)', action: '' };
  if (s === 'applied') return { group: 'Applied', reason: /tsenta/i.test(n) ? 'Applied via Tsenta' : 'Applied', action: '' };
  if (s === 'rejected') return { group: 'Closed', reason: 'Rejected by employer', action: '' };
  if (s === 'interview' || s === 'responded' || s === 'offer') return { group: 'Applied', reason: status, action: 'Reply to the employer' };
  // A SKIP/Discarded row is closed even if older note text still carries a Needs-you marker (MANUAL APPLY, POSSIBLE DUPLICATE).
  if ((s === 'skip' || s === 'discarded') && !/(?<!POSSIBLE )\bDUPLICATE:/i.test(n))
    return { group: 'Skipped', reason: /Dropped by user/i.test(n) ? 'Dropped by you' : skipReason(n, score), action: '' };
  // A closed row the user (or the check) confirmed as a duplicate is done, even if an older POSSIBLE DUPLICATE note remains.
  if ((s === 'skip' || s === 'discarded') && /(?<!POSSIBLE )\bDUPLICATE:/.test(n)) return { group: 'Skipped', reason: 'Already applied (duplicate)', action: '' };
  // Inbox/Tsenta/tracker dedup check writes these markers into the tracker note (see modes/_custom.md).
  if (/POSSIBLE DUPLICATE/i.test(n)) return { group: 'Needs you', reason: 'Possible duplicate: similar email or application found', action: 'Check the match in the notes; tell Claude apply or skip' };
  if (/\bDUPLICATE:|already applied (on|via|to this)/.test(n)) return { group: 'Skipped', reason: 'Already applied (duplicate)', action: 'Check the earlier application' };
  if (/🖐️|MANUAL APPLY|CAPTCHA_FAILED|send failed|FAILED \(|PENDING_SUBMIT_REVIEW/.test(n) && !/expired/i.test(n))
    return { group: 'Needs you', reason: /PENDING_SUBMIT_REVIEW/.test(n) ? 'Tsenta waiting on your answers' : 'Apply by hand: Tsenta could not submit', action: /PENDING_SUBMIT_REVIEW/.test(n) ? 'Answer the open questions in Tsenta' : 'Apply on the company site with the saved PDF + cover letter' };
  if (/\bHOLD\b|ATS (6[5-9]|7\d|8\d)%/.test(n) && s === 'evaluated') return { group: 'Needs you', reason: 'On hold: ATS score 65–89%', action: 'Decide: add real experience for missing keywords, or apply as is' };
  const reason = skipReason(n, score);
  if (s === 'skip' || s === 'discarded') return { group: 'Skipped', reason, action: '' };
  return { group: 'Not applied', reason, action: /VERIFY|CONFIRM|RESEARCH|ASK/i.test(n) ? 'Verify the open question before applying' : '' };
}

function skipReason(n, score) {
  if (/expired|posting closed|no longer (open|accepting)|not found at employer/i.test(n)) return 'Posting expired';
  if (/clearance|citizen|public trust/i.test(n)) return 'Clearance / citizenship';
  if (/no (visa )?sponsorship|non-sponsor|does not sponsor|won'?t sponsor|without sponsorship|unable to sponsor|sponsorship knock-out|filed 0 H-1B|0 H-1B LCAs|no H-1B (record|filing)|SKIP: SPONSOR|excludes? H-1B|not now or in the future require sponsorship|no H-1B|H-1B not (accepted|supported)/i.test(n)) return 'No sponsorship';
  // Bar since 2026-11-04: Fit >= 3.8 AND Final >= 3.5. Fit is read from the note ("Fit 4.2 / Final 3.6"); older rows without it fall back to the final score.
  const fit = parseFloat((n.match(/\bFit:?\s*(\d\.\d)/) || [])[1]);
  if (/SKIP: FIT/i.test(n) || (!isNaN(fit) && fit < 3.8)) return 'Fit below 3.8';
  if (!isNaN(fit) && score != null && score < 3.5 && !/SKIP: LOGISTICS/i.test(n)) return 'Good fit, logistics too risky';
  if (isNaN(fit) && score != null && score < 3.8 && !/SKIP: LOGISTICS/i.test(n)) return 'Fit below 3.8';
  if (/(below|under) (her |the )?\$?180K|walk-away|band tops|floor/i.test(n)) return 'Pay below $180K floor';
  if (/Gate 1|fails? location|on-?site .*(fails|outside)|relocat|outside remote|remote only for|non-target city|non-US|hybrid|SKIP: LOGISTICS/i.test(n)) return 'Location / logistics';
  if (/\b(manager|director|head of)\b/i.test(n)) return 'Level';
  return 'Other (see notes)';
}

const discards = fs.readFileSync(path.join(root, 'data/discard.log'), 'utf8').split('\n').filter(Boolean).map((l) => {
  const [at, url, ...rest] = l.split('\t');
  const why = rest.join(' ');
  const reason = /expired|not on live board/i.test(why) ? 'Posting expired' : /comp .*below|floor/i.test(why) ? 'Pay below $180K floor' : /location|Gate 1|must be based/i.test(why) ? 'Outside US / target area' : /title/i.test(why) ? 'Title not a match' : /visa|sponsor/i.test(why) ? 'No sponsorship' : /posted|age/i.test(why) ? 'Too old' : /clearance|citizen/i.test(why) ? 'Clearance / citizenship' : /pre-screen|not data eng|mismatch/i.test(why) ? 'Role not a match' : 'Other';
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const company = (url.match(/(?:greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com)\/([^/?#]+)/) || [])[1] || host;
  return { date: at.slice(0, 10), url, company, reason, detail: why };
}).filter((d, i, all) => all.findLastIndex((x) => x.url === d.url) === i); // one row per posting, latest wins

// Inbox sync items that need the user (agreed 2026-11-03): applications/interviews at companies not in the
// tracker, and mails that match several rows. Untracked rejections stay in the file only (noise).
try {
  const seen = new Set();
  const items = fs.readFileSync(path.join(root, 'data/inbox/needs-review.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && m.id && !seen.has(m.id) && seen.add(m.id))
    .filter((m) => m.type === 'confirmation' || m.type === 'interview' || /rows|could not/.test(m.why || ''))
    .filter((m) => !m.resolved);
  items.forEach((m, i) => rows.push({
    key: 'inbox-' + crypto.createHash('sha1').update(`${m.src}:${m.id}`).digest('hex').slice(0, 16), mtype: m.type,
    num: 9000 + i, date: String(m.date || m.at || '').slice(0, 10), company: m.company || '(not named)', role: m.role || '', score: null,
    status: 'Inbox', notes: `${/outlook/i.test(m.src) ? 'Outlook' : 'Gmail'}: "${m.subject || ''}" · ${m.preview || ''}`, url: m.link || '',
    group: 'Needs you', reason: m.type === 'interview' ? 'Inbox: interview / reply, not matched to a tracked role' : m.type === 'confirmation' ? 'Inbox: you applied to a role not in the tracker' : 'Inbox: ' + m.why,
    action: m.type === 'interview' ? 'Reply to the recruiter; tell Claude which role it is' : 'Tell Claude to add it to the tracker (so duplicates are caught) or ignore',
    dupcheck: '',
  }));
} catch {}

// One row per run: how many roles were checked and what was found.
const runs = new Map();
for (const c of checks) {
  const r = runs.get(c.run) || { run: c.run, checked: 0, duplicates: 0, possible: 0, clear: 0, inbox_as_of: '' };
  r.checked++;
  if (c.outcome === 'duplicate') r.duplicates++; else if (c.outcome === 'possible') r.possible++; else r.clear++;
  if (c.inbox_as_of && (!r.inbox_as_of || c.inbox_as_of < r.inbox_as_of)) r.inbox_as_of = c.inbox_as_of;
  runs.set(c.run, r);
}
fs.writeFileSync(path.join(outDir, 'dedup-runs.json'), JSON.stringify([...runs.values()]));
// Duplicates caught at scan that never became tracker rows (no #) still deserve a line in the dashboard.
fs.writeFileSync(path.join(outDir, 'dedup-checks.json'), JSON.stringify(checks.map((c, i) => ({ id: String(i + 1), ...c }))));
let inbox = { sources: [] };
try { inbox = JSON.parse(fs.readFileSync(path.join(root, 'data/inbox-status.json'), 'utf8')); } catch {}
fs.writeFileSync(path.join(outDir, 'inbox-status.json'), JSON.stringify(inbox.sources));
// Which inbox(es) have mail about each role (user 2026-11-04: filter the dashboard by Gmail / Outlook).
// Sources: the tracker note (inbox sync always quotes "Gmail …" / "Outlook …") plus job emails in data/inbox
// whose company matches exactly one tracker row.
{
  const STOPW = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'the', 'group', 'holdings', 'technologies', 'technology', 'solutions', 'usa', 'us', 'and', 'of', 'labs', 'systems', 'health']);
  const nrm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = (x) => nrm(x).split(' ').filter((w) => w.length >= 2 && !STOPW.has(w)).join(' ') || nrm(x);
  const byCo = new Map();
  for (const r of rows) { const k = key(r.company); if (!k) continue; if (!byCo.has(k)) byCo.set(k, []); byCo.get(k).push(r); }
  const seen = new Map();
  const store = path.join(root, 'data/inbox');
  try {
    for (const f of fs.readdirSync(store).filter((f) => /^scan-(gmail|outlook)-.*\.json$/.test(f))) {
      const src = /outlook/.test(f) ? 'Outlook' : 'Gmail';
      for (const m of JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')).records || []) {
        const hits = m.company ? byCo.get(key(m.company)) : null;
        if (hits && hits.length === 1) { const s2 = seen.get(hits[0]) || new Set(); s2.add(src); seen.set(hits[0], s2); }
      }
    }
  } catch {}
  for (const r of rows) {
    const s2 = seen.get(r) || new Set();
    if (/\bGmail\b/.test(r.notes || '')) s2.add('Gmail');
    if (/\bOutlook\b/.test(r.notes || '')) s2.add('Outlook');
    if (!r.key) r.key = 'row-' + r.num;
    r.inbox = s2.size === 2 ? 'Both' : s2.size === 1 ? [...s2][0] : '';
    if (r.via === undefined) r.via = '';
  }
}
fs.writeFileSync(path.join(outDir, 'tracker.json'), JSON.stringify(rows));
fs.writeFileSync(path.join(outDir, 'scan-drops.json'), JSON.stringify(discards));
const counts = rows.reduce((a, r) => ((a[r.group] = (a[r.group] || 0) + 1), a), {});
console.log(rows.length, 'tracker rows', counts, '|', discards.length, 'scan drops →', outDir);
