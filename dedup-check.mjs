#!/usr/bin/env node
// Three-place duplicate check (user rule 2026-11-03): tracker + Tsenta + Gmail/Outlook inbox dashboard.
// The Tsenta lookup is done by the agent over MCP and passed in with --tsenta.
//
// Usage:
//   node dedup-check.mjs --inbox-dir <dir with scan-*.json> --company "Acme" --role "Senior Data Engineer"
//        [--job-id 12345] [--url https://...] [--num 352] [--tsenta clear|hit:<detail>] [--run 2026-11-05] [--dry-run]
//
// Writes data/inbox-status.json (inbox freshness) and appends one row to data/dedup-checks.tsv
// (unless --dry-run). Prints a JSON verdict: outcome = clear | possible | duplicate.
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const need = (k) => { if (!args[k] || args[k] === true) { console.error(`missing --${k}`); process.exit(2); } return args[k]; };
const company = need('company');
const role = need('role');
const inboxDir = typeof args['inbox-dir'] === 'string' ? args['inbox-dir'] : path.join(root, 'data/inbox'); // local store, kept fresh by the 4-hourly inbox sync
const jobId = args['job-id'] && args['job-id'] !== true ? String(args['job-id']) : '';
const selfNum = args.num ? Number(args.num) : null;
const tsenta = typeof args.tsenta === 'string' ? args.tsenta : 'not checked';
const now = new Date();
const runId = typeof args.run === 'string' ? args.run : now.toISOString().slice(0, 10);

const STOP = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'the', 'group', 'holdings', 'technologies', 'technology', 'solutions', 'health', 'usa', 'us', 'and', 'of', 'labs', 'systems']);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const companyKeys = (() => {
  const words = norm(company).split(' ').filter((w) => w.length >= 2 && !STOP.has(w));
  const keys = new Set();
  if (words.length) keys.add(words.join(' '));
  if (words[0] && words[0].length >= 4) keys.add(words[0]);
  keys.add(norm(company).replace(/ /g, ''));
  if (/^[a-z] [a-z] /.test(norm(company))) keys.add(norm(company).replace(/^([a-z]) ([a-z]) /, '$1$2 ')); // "D R Horton" -> "dr horton"
  return [...keys].filter((k) => k.length >= 3);
})();
const hasCompany = (text) => {
  const t = ' ' + norm(text) + ' ';
  const tight = t.replace(/ /g, '');
  return companyKeys.some((k) => t.includes(' ' + k + ' ') || (k.length >= 6 && tight.includes(k.replace(/ /g, ''))));
};
const ROLE_STOP = new Set(['senior', 'sr', 'staff', 'lead', 'principal', 'i', 'ii', 'iii', 'iv', 'remote', 'hybrid', 'the', 'and', 'of', 'a', 'to', 'for', 'with']);
const GENERIC = new Set(['data', 'engineer', 'engineering', 'software', 'developer', 'analytics', 'platform', 'ai', 'ml']);
const roleTokens = norm(role).split(' ').filter((w) => w.length > 1 && !ROLE_STOP.has(w));
const specTokens = roleTokens.filter((w) => !GENERIC.has(w));
// Share of the role's tokens found in text. When the role has specific words (e.g. "payments", "finance"),
// those decide: "Senior Data Engineer - Finance" is not "Staff Data Engineer, Payments".
const roleOverlap = (text) => {
  if (!roleTokens.length) return 0;
  const t = new Set(norm(text).split(' '));
  const frac = (arr) => arr.filter((w) => t.has(w)).length / arr.length;
  return specTokens.length ? Math.min(frac(specTokens), frac(roleTokens)) : frac(roleTokens);
};
// Sender is the company itself (ATS mail usually carries the company slug in the address or name).
const senderMatch = (r) => {
  const name = norm(r.fromName);
  const addr = String(r.from || '').toLowerCase();
  return companyKeys.some((k) => {
    const tight = k.replace(/ /g, '');
    return (name && (name === k || name.startsWith(k + ' '))) || addr.split(/[@.+_-]/).some((part) => part === tight || (tight.length >= 4 && part.startsWith(tight)));
  });
};
const hasJobId = (text) => jobId && new RegExp(`(^|[^0-9a-z])${jobId.replace(/[^0-9a-z]/gi, '.?')}([^0-9a-z]|$)`, 'i').test(String(text || ''));

// 1. Tracker
const trackerHits = [];
for (const line of fs.readFileSync(path.join(root, 'data/applications.md'), 'utf8').split('\n')) {
  if (!/^\|\s*\d+\s*\|/.test(line)) continue;
  const c = line.split('|').slice(1, -1).map((s) => s.trim());
  const num = Number(c[0]);
  if (num === selfNum || !hasCompany(c[2])) continue;
  const notes = c.slice(9).join(' ');
  const idMatch = hasJobId(notes) || hasJobId(c[4]);
  const ov = roleOverlap(c[4]);
  const active = /Applied|Responded|Interview|Offer|Rejected/.test(c[6]);
  const recent = (now - new Date(c[1])) / 864e5 <= 120;
  if (idMatch || ov >= 0.6 || (active && recent)) trackerHits.push({ num, role: c[4], status: c[6], strong: idMatch || (ov >= 0.8 && active) });
}

// 2. Inbox (Gmail + Outlook dashboard DB dump)
const files = fs.readdirSync(inboxDir).filter((f) => /^scan-(gmail|outlook)-.*\.json$/.test(f));
const status = { Gmail: { src: 'Gmail', last_refresh: '', newest_email: '', emails: 0 }, Outlook: { src: 'Outlook', last_refresh: '', newest_email: '', emails: 0 } };
const APPLIED_RE = /thank(s| you) for (applying|your (application|interest))|application (received|submitted|was received|confirmation)|we (have )?received your application|complete (your|the) (full )?(job )?application|you have progressed|interview|next steps|unfortunately|not (to )?(move|moving) forward|other candidates|assessment|schedule/i;
const inboxHits = [];
for (const f of files) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')); } catch { continue; }
  const src = /gmail/.test(f) ? 'Gmail' : 'Outlook';
  const st = status[src];
  if (doc.scannedAt && doc.scannedAt > st.last_refresh) st.last_refresh = doc.scannedAt;
  for (const r of doc.records || []) {
    st.emails++;
    if (r.date && r.date > st.newest_email) st.newest_email = r.date;
    const text = [r.subject, r.preview, r.from, r.fromName].join(' ');
    if (!hasCompany(text)) continue;
    const idMatch = hasJobId(text);
    const ov = roleOverlap([r.subject, r.preview].join(' '));
    const applied = APPLIED_RE.test(text);
    if (!idMatch && !applied) continue; // job alerts, newsletters, marketing
    const fromCompany = senderMatch(r);
    // Keep "Thank you for applying to <Company>!" mails (no role in the subject, sent via the ATS domain) as a weak hit.
    const subjectNamesCompany = hasCompany(r.subject || '');
    if (!idMatch && !fromCompany && !subjectNamesCompany && ov < 0.6) continue; // a different company that shares a word ("Wider Circle" vs "Circle")
    inboxHits.push({ src, date: (r.date || '').slice(0, 10), subject: r.subject || '', link: r.link || '', strong: idMatch || (applied && ov >= 0.8 && (fromCompany || ov === 1)) });
  }
}
fs.writeFileSync(path.join(root, 'data/inbox-status.json'), JSON.stringify({ checked_at: now.toISOString(), sources: Object.values(status) }, null, 2));

// 3. Tsenta (passed in)
const tsentaHit = tsenta.startsWith('hit');

const inboxAsOf = Object.values(status).map((s) => s.last_refresh).filter(Boolean).sort()[0] || '';
const strongTracker = trackerHits.filter((h) => h.strong);
const strongInbox = inboxHits.filter((h) => h.strong);
let outcome = 'clear';
if (strongTracker.length || strongInbox.length || tsentaHit) outcome = 'duplicate';
else if (trackerHits.length || inboxHits.length) outcome = 'possible';

const fmtHits = (hs) => hs.slice(0, 3).map((h) => h.num ? `#${h.num} ${h.status}` : `${h.src} ${h.date} "${h.subject.slice(0, 60)}"`).join('; ');
const detail = [
  trackerHits.length ? `tracker: ${fmtHits(trackerHits)}` : '',
  tsentaHit ? `tsenta: ${tsenta.slice(4) || 'hit'}` : '',
  inboxHits.length ? `inbox: ${fmtHits(inboxHits)}` : '',
].filter(Boolean).join(' | ');
const mark = (hits, strong) => (strong.length ? 'hit' : hits.length ? 'weak' : 'clear');
// User sign-off for a flagged role (only when the user said so in chat): --approve lifts a "possible",
// --approve-duplicate lifts a "duplicate" (e.g. a deliberate re-apply). The pre-submit guard then lets it through.
if (outcome === 'possible' && args.approve) outcome = 'approved';
if (outcome === 'duplicate' && args['approve-duplicate']) outcome = 'approved';
const postingUrl = typeof args.url === 'string' ? args.url : '';
const result = {
  run: runId, checked_at: now.toISOString(), num: selfNum, company, role, job_id: jobId, url: postingUrl,
  tracker: mark(trackerHits, strongTracker), tsenta: tsentaHit ? 'hit' : tsenta === 'clear' ? 'clear' : 'not checked',
  inbox: mark(inboxHits, strongInbox), inbox_as_of: inboxAsOf, outcome, detail,
  hits: { tracker: trackerHits, inbox: inboxHits.slice(0, 10) },
};
if (!args['dry-run']) {
  const logPath = path.join(root, 'data/dedup-checks.tsv');
  const cols = ['run', 'checked_at', 'num', 'company', 'role', 'job_id', 'tracker', 'tsenta', 'inbox', 'inbox_as_of', 'outcome', 'detail', 'url'];
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, cols.join('\t') + '\n');
  else {
    // One-time migration: older logs had no url column.
    const [head, ...rest] = fs.readFileSync(logPath, 'utf8').split('\n');
    if (!head.split('\t').includes('url')) fs.writeFileSync(logPath, [cols.join('\t'), ...rest.map((l) => (l ? l + '\t' : l))].join('\n'));
  }
  fs.appendFileSync(logPath, cols.map((k) => String(result[k] ?? '').replace(/[\t\n]/g, ' ')).join('\t') + '\n');
}
console.log(JSON.stringify(result, null, 2));
