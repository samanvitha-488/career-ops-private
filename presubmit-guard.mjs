#!/usr/bin/env node
// Pre-submit duplicate guard (user rule 2026-11-03). Claude Code PreToolUse hook on the Tsenta apply tools.
// Reads the hook payload on stdin and exits 2 (blocks the submit, message on stderr) unless:
//   1. both inboxes (Gmail + Outlook dashboard) were refreshed within the last 24 h, and
//   2. dedup-check.mjs logged this exact posting (--url) within the last 24 h with outcome clear or approved.
// Exit 0 lets the call through. Any crash also blocks: a guard that can't read its data must not wave things past.
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const DAY = 24 * 3600 * 1000;
const block = (msg) => { process.stderr.write(`PRE-SUBMIT DUPLICATE GUARD: ${msg}\n`); process.exit(2); };

export const normUrl = (u) => {
  try {
    const x = new URL(String(u).trim());
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|gh_src|src$|source$|ref$|lever-source)/i.test(k)) x.searchParams.delete(k);
    x.hash = '';
    return (x.host.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase();
  } catch { return String(u || '').trim().toLowerCase(); }
};

try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const ti = payload.tool_input || {};
  const target = ti.url || ti.jobUrl || ti.applyUrl || ti.jobLink || ti.jobId || '';
  if (!target) block('no job URL in this apply call, so I cannot match it to a duplicate check. Pass the posting url.');

  // 1. Inbox freshness
  let inbox;
  try { inbox = JSON.parse(fs.readFileSync(path.join(root, 'data/inbox-status.json'), 'utf8')); }
  catch { block('no inbox status yet. Pull the inbox dashboard DB and run dedup-check.mjs first.'); }
  for (const s of inbox.sources || []) {
    if (!s.last_refresh || Date.now() - new Date(s.last_refresh) > DAY)
      block(`${s.src} inbox data is older than 24 h (last refresh ${s.last_refresh || 'never'}). Ask the user to click "Check for new emails" on the inbox dashboard, re-pull it, re-run dedup-check.mjs.`);
  }

  // 2. A recent dedup check for this exact posting
  const logPath = path.join(root, 'data/dedup-checks.tsv');
  if (!fs.existsSync(logPath)) block('no duplicate-check log. Run dedup-check.mjs --url <posting> first.');
  const [head, ...lines] = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const cols = head.split('\t');
  const key = normUrl(target);
  const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])))
    .filter((r) => r.url && normUrl(r.url) === key)
    .sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1));
  const last = rows[0];
  if (!last) block(`no duplicate check logged for ${target}. Run: node dedup-check.mjs --inbox-dir <dir> --company ... --role ... --url "${target}" --tsenta clear|hit:<id>`);
  if (Date.now() - new Date(last.checked_at) > DAY) block(`the duplicate check for this posting is older than 24 h (${last.checked_at}). Re-run dedup-check.mjs.`);
  if (last.outcome === 'duplicate') block(`DUPLICATE: ${last.company} ${last.role} was already applied (${last.detail}). Not submitting. If the user explicitly wants to re-apply, re-run dedup-check.mjs with --approve-duplicate.`);
  if (last.outcome === 'possible') block(`POSSIBLE DUPLICATE: ${last.company} ${last.role} (${last.detail}). Show the user the match and ask. Only after they say apply, re-run dedup-check.mjs with --approve.`);
  if (last.outcome !== 'clear' && last.outcome !== 'approved') block(`unexpected check outcome "${last.outcome}".`);
  process.exit(0);
} catch (e) {
  block(`guard error (${e.message}); blocking to be safe.`);
}
