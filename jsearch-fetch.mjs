#!/usr/bin/env node
/**
 * jsearch-fetch.mjs — Fetch jobs from OpenWebNinja's JSearch API (Google for Jobs)
 * and queue new, filtered ones into data/pipeline.md.
 *
 * Usage:
 *   node jsearch-fetch.mjs                 # run all queries from portals.yml `jsearch:`
 *   node jsearch-fetch.mjs --dry-run       # fetch + filter, write nothing
 *   node jsearch-fetch.mjs --query "Senior Data Engineer in Dallas, TX" --date week
 *   node jsearch-fetch.mjs --json          # machine-readable result on stdout
 *
 * Auth: OPENWEBNINJA_API_KEY in {DATA_ROOT}/.env (or the environment).
 *
 * Config (portals.yml, optional — defaults below):
 *   jsearch:
 *     country: us
 *     date_posted: week          # all | today | 3days | week | month
 *     num_pages: 1               # 10 results per page; each page costs quota
 *     queries:
 *       - "Senior Data Engineer in United States"
 *     exclude_companies: [Walmart, "Sam's Club", Tyson]   # in addition to data/blacklist.md
 *     save_jd: true              # archive description to jds/ (aggregator links rot)
 *
 * Filters, in order: US only → portals.yml title_filter (positive/negative) →
 * data/blacklist.md + jsearch.exclude_companies → location_filter.block →
 * dedup against scan-history.tsv, pipeline.md, applications.md (URL, and
 * company+title).
 *
 * Writes: data/pipeline.md (Pending), data/scan-history.tsv (portal=jsearch-api),
 * jds/{company}-{role}.md. Never applies to anything.
 *
 * Aggregator rule: an employer/ATS apply link is preferred as the canonical URL.
 * When only aggregator links exist, the entry is tagged "aggregator: confirm at employer".
 */
import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
try {
  const { config } = await import('dotenv');
  config({ path: path.join(DATA_ROOT, '.env'), quiet: true });
} catch { /* dotenv optional */ }

const API = 'https://api.openwebninja.com/jsearch/search';
const PORTAL = 'jsearch-api';
const TODAY = new Date().toISOString().slice(0, 10);

const PATHS = {
  portals: process.env.CAREER_OPS_PORTALS || path.join(DATA_ROOT, 'portals.yml'),
  pipeline: path.join(DATA_ROOT, 'data/pipeline.md'),
  history: path.join(DATA_ROOT, 'data/scan-history.tsv'),
  blacklist: path.join(DATA_ROOT, 'data/blacklist.md'),
  tracker: process.env.CAREER_OPS_TRACKER
    || [path.join(DATA_ROOT, 'data/applications.md'), path.join(DATA_ROOT, 'applications.md')].find(fs.existsSync)
    || path.join(DATA_ROOT, 'data/applications.md'),
  jds: path.join(DATA_ROOT, 'jds'),
};

const DEFAULT_QUERIES = [
  'Senior Data Engineer in United States',
  'Data Platform Engineer in United States',
  'Staff Data Engineer in United States',
  'Senior Data Engineer remote',
];

const AGGREGATOR_HOSTS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com',
  'dice.com', 'simplyhired.com', 'careerbuilder.com', 'talent.com', 'jooble.org',
  'adzuna.com', 'snagajob.com', 'builtin.com', 'wellfound.com', 'lensa.com',
  'jobright.ai', 'ladders.com', 'salary.com', 'learn4good.com', 'teal.com',
  'bebee.com', 'jobleads.com', 'whatjobs.com', 'recruit.net', 'joblist.com',
  'getwork.com', 'tallo.com', 'clearancejobs.com', 'theladders.com', 'jobs.institutedata.com',
  'google.com', 'upwork.com', 'echojobs.io', 'hiringcafe.com', 'hiring.cafe',
];
const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com',
  'icims.com', 'smartrecruiters.com', 'workable.com', 'jobvite.com', 'oraclecloud.com',
  'taleo.net', 'successfactors.com', 'successfactors.eu', 'bamboohr.com', 'breezy.hr',
  'recruitee.com', 'paylocity.com', 'ultipro.com', 'ukg.com', 'adp.com', 'dayforcehcm.com',
  'avature.net', 'eightfold.ai', 'phenompeople.com', 'rippling.com', 'jazzhr.com',
  'applytojob.com', 'teamtailor.com', 'personio.de', 'pinpointhq.com', 'gem.com',
];

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const JSON_OUT = flag('--json');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

// ── helpers ───────────────────────────────────────────────────────────
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const normCompany = (s) => norm(s).replace(/\b(inc|llc|ltd|corp|corporation|co|company|na|n a|plc|group|holdings)\b/g, '').replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 60);
const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const hostIn = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
const normUrl = (u) => {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|gh_src|source|src|ref|trk|lever-source)/i.test(k)) x.searchParams.delete(k);
    x.hash = '';
    return (x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + (x.search || '')).toLowerCase();
  } catch { return String(u).toLowerCase(); }
};

function loadConfig() {
  const doc = yaml.load(readIf(PATHS.portals)) || {};
  const js = doc.jsearch || {};
  return {
    country: js.country || 'us',
    datePosted: opt('--date') || js.date_posted || 'week',
    numPages: Number(opt('--pages') || js.num_pages || 1),
    queries: opt('--query') ? [opt('--query')] : (js.queries?.length ? js.queries : DEFAULT_QUERIES),
    excludeCompanies: (js.exclude_companies || []).map(normCompany),
    saveJd: js.save_jd !== false,
    titlePos: (doc.title_filter?.positive || []).map((s) => s.toLowerCase()),
    titleNeg: (doc.title_filter?.negative || []).map((s) => s.toLowerCase()),
    locBlock: (doc.location_filter?.block || []).map((s) => s.toLowerCase()),
  };
}

function loadBlacklist() {
  const companies = new Set(); const domains = [];
  for (const line of readIf(PATHS.blacklist).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4 || !cells[1] || /^-+$/.test(cells[1]) || cells[1] === 'Company') continue;
    if (cells[3] === 'domain') domains.push(cells[1].toLowerCase());
    else companies.add(normCompany(cells[1]));
  }
  return { companies, domains };
}

function loadSeen() {
  const urls = new Set(); const keys = new Set();
  const lines = readIf(PATHS.history).split('\n').slice(1);
  for (const l of lines) {
    const [url, , , title, company] = l.split('\t');
    if (url) urls.add(normUrl(url));
    if (title && company) keys.add(normCompany(company) + '|' + norm(title));
  }
  for (const src of [readIf(PATHS.pipeline), readIf(PATHS.tracker)]) {
    for (const m of src.matchAll(/https?:\/\/[^\s|)>\]]+/g)) urls.add(normUrl(m[0]));
  }
  // pipeline entries: "| Company | Title |"
  for (const m of readIf(PATHS.pipeline).matchAll(/^- \[.\] (?:#\d+ \| )?\S+ \| ([^|]+) \| ([^|]+) \|/gm)) {
    keys.add(normCompany(m[1]) + '|' + norm(m[2]));
  }
  return { urls, keys };
}

function pickApplyLink(job) {
  const opts = [
    ...(job.apply_options || []).map((o) => ({ link: o.apply_link, direct: !!o.is_direct })),
    { link: job.job_apply_link, direct: !!job.job_apply_is_direct },
  ].filter((o) => o.link);
  const empHost = host(job.employer_website || '');
  const score = (o) => {
    const h = host(o.link);
    if (hostIn(h, ATS_HOSTS)) return 3;
    if (empHost && (h === empHost || h.endsWith('.' + empHost))) return 3;
    if (o.direct && !hostIn(h, AGGREGATOR_HOSTS)) return 2;
    if (!hostIn(h, AGGREGATOR_HOSTS)) return 1;
    return 0;
  };
  const best = opts.map((o) => ({ ...o, s: score(o) })).sort((a, b) => b.s - a.s)[0];
  if (!best) return { url: job.job_google_link || '', aggregator: true };
  return { url: best.link, aggregator: best.s === 0 };
}

function fmtSalary(j) {
  if (!j.job_min_salary && !j.job_max_salary) return 'comp n/a';
  const k = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`);
  const range = [j.job_min_salary, j.job_max_salary].filter(Boolean).map(k).join('–');
  return `${range}${j.job_salary_period && j.job_salary_period !== 'YEAR' ? '/' + j.job_salary_period.toLowerCase() : ''}`;
}

const clean = (s) => String(s || '').replace(/[|\t\n\r]+/g, ' ').trim();

async function search(query, cfg, key) {
  const params = new URLSearchParams({
    query, page: '1', num_pages: String(cfg.numPages), country: cfg.country, date_posted: cfg.datePosted,
  });
  const res = await fetch(`${API}?${params}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(60000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (json.status && json.status !== 'OK') throw new Error(`API status ${json.status}: ${JSON.stringify(json.error || '').slice(0, 200)}`);
  return json.data || [];
}

// ── main ──────────────────────────────────────────────────────────────
const key = process.env.OPENWEBNINJA_API_KEY;
if (!key) {
  console.error('OPENWEBNINJA_API_KEY is not set. Add it to .env:  OPENWEBNINJA_API_KEY=...');
  process.exit(2);
}

const cfg = loadConfig();
const bl = loadBlacklist();
const seen = loadSeen();
const counts = { fetched: 0, added: 0, skipped_dup: 0, skipped_title: 0, skipped_location: 0, skipped_blacklist: 0 };
const added = []; const history = []; const errors = [];
const batchSeen = new Set();

for (const q of cfg.queries) {
  let jobs;
  try { jobs = await search(q, cfg, key); }
  catch (e) { errors.push({ query: q, error: e.message }); log(`✗ "${q}": ${e.message}`); continue; }
  log(`• "${q}" → ${jobs.length} results`);
  counts.fetched += jobs.length;

  for (const j of jobs) {
    const title = clean(j.job_title); const company = clean(j.employer_name);
    const { url, aggregator } = pickApplyLink(j);
    const loc = j.job_is_remote ? `Remote${j.job_state ? ' · ' + [j.job_city, j.job_state].filter(Boolean).join(', ') : ''}`
      : [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || 'Unknown';
    const tl = title.toLowerCase();
    const ck = normCompany(company) + '|' + norm(title);
    const histRow = (status) => history.push([url, TODAY, PORTAL, title, company, status, clean(loc)].join('\t'));

    if (seen.urls.has(normUrl(url)) || seen.keys.has(ck) || batchSeen.has(ck) || batchSeen.has(normUrl(url))) { counts.skipped_dup++; continue; }
    batchSeen.add(ck); batchSeen.add(normUrl(url));

    const cn = normCompany(company);
    if (bl.companies.has(cn) || cfg.excludeCompanies.some((x) => x && (cn === x || cn.startsWith(x + ' ')))
        || bl.domains.some((d) => host(url).endsWith(d) || host(j.employer_website || '').endsWith(d))) {
      counts.skipped_blacklist++; histRow('skipped_blacklist'); continue;
    }
    if ((cfg.titlePos.length && !cfg.titlePos.some((p) => tl.includes(p))) || cfg.titleNeg.some((n) => tl.includes(n))) {
      counts.skipped_title++; histRow('skipped_title'); continue;
    }
    const ll = loc.toLowerCase();
    if ((j.job_country && j.job_country.toUpperCase() !== 'US') || cfg.locBlock.some((b) => ll.includes(b))) {
      counts.skipped_location++; histRow('skipped_location'); continue;
    }

    let jdRef = '';
    if (cfg.saveJd && j.job_description && !DRY) {
      fs.mkdirSync(PATHS.jds, { recursive: true });
      const file = `${slug(company)}-${slug(title)}.md`;
      fs.writeFileSync(path.join(PATHS.jds, file),
        `# ${title} — ${company}\n\n**URL:** ${url}\n**Source:** JSearch (${j.job_publisher || 'unknown publisher'}), fetched ${TODAY}\n**Location:** ${loc}\n**Comp:** ${fmtSalary(j)}\n\n## Job Description\n\n${j.job_description}\n`);
      jdRef = `, jd local:jds/${file}`;
    }
    const posted = j.job_posted_at_datetime_utc ? j.job_posted_at_datetime_utc.slice(0, 10) : 'n/a';
    const note = `jsearch-api ${TODAY}, posted ${posted}, via ${clean(j.job_publisher) || 'n/a'}, sponsorship UNCONFIRMED`
      + (aggregator ? ', aggregator: confirm at employer' : '') + `, job id ${clean(j.job_id).slice(0, 40)}` + jdRef;
    const line = `- [ ] ${url} | ${company} | ${title} | ${clean(loc)} | ${fmtSalary(j)} | note: ${note}`;
    added.push({ url, company, title, location: loc, comp: fmtSalary(j), aggregator, line });
    histRow('added'); counts.added++;
  }
}

if (!DRY && added.length) {
  let pipe = readIf(PATHS.pipeline) || '# Pipeline — Pending URLs\n\n## Pending\n';
  const block = added.map((a) => a.line).join('\n') + '\n';
  const m = pipe.match(/^## Pending\s*\n(\n?)/m);
  pipe = m ? pipe.slice(0, m.index + m[0].length) + block + '\n' + pipe.slice(m.index + m[0].length)
           : pipe + '\n## Pending\n\n' + block;
  fs.writeFileSync(PATHS.pipeline, pipe);
}
if (!DRY && history.length) {
  if (!fs.existsSync(PATHS.history)) fs.writeFileSync(PATHS.history, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  const cur = readIf(PATHS.history);
  fs.appendFileSync(PATHS.history, (cur.endsWith('\n') ? '' : '\n') + history.join('\n') + '\n');
}

if (JSON_OUT) {
  console.log(JSON.stringify({ dryRun: DRY, counts, errors, added: added.map(({ line, ...r }) => r) }, null, 2));
} else {
  log(`\n${DRY ? '[dry-run] ' : ''}fetched ${counts.fetched} · added ${counts.added} · dup ${counts.skipped_dup} · title ${counts.skipped_title} · location ${counts.skipped_location} · blacklist ${counts.skipped_blacklist}`);
  for (const a of added) log(`  + ${a.company} — ${a.title} (${a.location}, ${a.comp})${a.aggregator ? ' [aggregator]' : ''}`);
  if (errors.length) process.exitCode = 1;
}
