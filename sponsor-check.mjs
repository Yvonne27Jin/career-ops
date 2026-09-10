#!/usr/bin/env node
/**
 * sponsor-check.mjs — IND recognised-sponsor check (KM / kennismigrant + research visa)
 *
 * Checks Dutch employer names against two bundled snapshots of the IND public
 * register of recognised sponsors:
 *   - templates/sponsor-register/list_of_KM_sponsors.csv          (Work / highly
 *     skilled migrant "kennismigrant" — the register that matters for a normal
 *     KM work-permit job)
 *   - templates/sponsor-register/list_of_research_visa_sponsors.csv (Research,
 *     EU Directive 2016/801 — formal researcher roles only)
 *
 * Node port of the `km-sponsor-check` skill's `check_sponsor.py` (same
 * matching rules, same bundled data) so the check works from any CLI —
 * headless batch workers included — without depending on a Claude-only
 * skill being enabled. `modes/_profile.md` / `modes/oferta.md` call this
 * script directly; the skill (if installed) is an equivalent, interactive-
 * only alias over the same two CSVs.
 *
 * Registers live under the repo root (system layer, refreshed by
 * `update-system.mjs apply`), NOT under the DATA_ROOT `getCareerOpsRoot()`
 * resolves — same split check-table-freshness.mjs uses for templates/*.yml.
 * The IND updates the live register monthly; treat a match as a strong
 * indicator, never a legal guarantee, and re-check
 * https://ind.nl/en/public-register-recognised-sponsors before anything
 * decision-critical. Snapshot dates live in
 * templates/sponsor-register/README.md.
 *
 * Matching (normalization- and fuzzy-aware, because the register stores full
 * legal names — "Koninklijke Philips N.V." — while people search marketing
 * names — "Philips"):
 *   EXACT   normalized name match                  -> ✅ on the register
 *   STRONG  query is a token-bounded substring       -> 🟡 likely match, verify
 *   FUZZY   close string match (typo-tolerant)       -> 🟠 possible match, verify
 *   NONE    nothing plausible                        -> ❌ not found
 * FUZZY here uses a Levenshtein-distance ratio (cutoff 0.82), an
 * approximation of the Python skill's difflib.SequenceMatcher — close enough
 * for a "verify carefully" tier, not a byte-for-byte port.
 *
 * Run: node sponsor-check.mjs "Philips" "ASML"              (ad hoc, JSON)
 *      node sponsor-check.mjs "Philips" --summary            (human table)
 *      node sponsor-check.mjs --tracker                       (every company
 *        in data/applications.md, deduped, tracker row numbers attached)
 *      node sponsor-check.mjs --input-csv f.csv --name-column "Company" \
 *        [--output-csv f_checked.csv]  (arbitrary CSV, parity with the skill)
 *      node sponsor-check.mjs --self-test
 *      node sponsor-check.mjs --help
 *
 * Issue: km-sponsor-check integration — github.com/career-ops-hq/career-ops
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { parseCsv } from './linkedin-join.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { isPlaceholderCompany } from './lib/placeholder-cell.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

// Repo root (system layer) — distinct from DATA_ROOT. Same split
// check-table-freshness.mjs uses for templates/*.yml: the register snapshots
// ship with the codebase and are refreshed by the updater, not per-user data.
const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const REGISTER_DIR = join(CAREER_OPS, 'templates/sponsor-register');
export const KM_FILE = join(REGISTER_DIR, 'list_of_KM_sponsors.csv');
export const RESEARCH_FILE = join(REGISTER_DIR, 'list_of_research_visa_sponsors.csv');

const KNOWN_FLAGS = ['--tracker', '--input-csv', '--name-column', '--output-csv', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--input-csv', '--name-column', '--output-csv'];

const USAGE = `Usage:
  node sponsor-check.mjs "Company A" ["Company B" ...]     # ad hoc names, JSON
  node sponsor-check.mjs "Company A" --summary              # human-readable table
  node sponsor-check.mjs --tracker                          # every company in data/applications.md
  node sponsor-check.mjs --input-csv <file> --name-column "<col>" [--output-csv <file>]
  node sponsor-check.mjs --self-test                        # run the in-memory test suite
  node sponsor-check.mjs --help                              # print this usage block and exit (-h is an alias)`;

// --- Name normalization (port of check_sponsor.py's normalize()) ---------
// Legal-form/filler tokens stripped so "The Talent Institute B.V." and
// "Talent Institute" compare equal. Already lowercased/de-dotted by the time
// this set is consulted.
const LEGAL_SUFFIXES = new Set([
  'bv', 'nv', 'cv', 'vof', 'cooperatief', 'ua', 'sa', 'sarl', 'se', 'gmbh',
  'ltd', 'limited', 'llp', 'llc', 'inc', 'holding', 'holdings', 'group',
  'groep', 'nederland', 'netherlands', 'the',
]);

// Dotted legal forms collapse to spaceless tokens FIRST ("n.v." -> "nv") so
// they survive as single tokens and can be stripped as suffixes below.
// Global + looped to stability, mirroring the Python re.sub-until-stable loop
// (a single pass misses overlapping runs like "a.b.c.").
const DOTTED_LEGAL = /\b([a-z])\.(?=[a-z]\.?)/g;

export function normalizeSponsorName(name) {
  let s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '');
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(DOTTED_LEGAL, '$1');
  }
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = s.split(/\s+/).filter((t) => t && !LEGAL_SUFFIXES.has(t));
  return tokens.join(' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Fuzzy ratio (Levenshtein-based approximation of difflib's ratio) ----
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function similarityRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

const FUZZY_CUTOFF = 0.82;

// --- Register loading ------------------------------------------------------
export function loadRegister(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h ?? '').trim());
  const orgIdxFound = header.findIndex((h) => /organis/i.test(h));
  const kvkIdxFound = header.findIndex((h) => /kvk/i.test(h));
  const orgIdx = orgIdxFound === -1 ? 0 : orgIdxFound;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const org = String(rows[i][orgIdx] ?? '').trim();
    if (!org) continue;
    const kvk = kvkIdxFound === -1 ? '' : String(rows[i][kvkIdxFound] ?? '').trim();
    out.push({ org, norm: normalizeSponsorName(org), kvk });
  }
  return out;
}

function loadRegisterFile(path) {
  if (!existsSync(path)) {
    throw new Error(`bundled register file not found: ${path} — was the repo checked out without templates/sponsor-register/?`);
  }
  return loadRegister(readFileSync(path, 'utf-8'));
}

// --- Matching ---------------------------------------------------------------
export function matchOne(query, register) {
  const qNorm = normalizeSponsorName(query);
  if (!qNorm) return { grade: 'NONE', matches: [] };

  const exact = [];
  const strong = [];
  const strongSeen = new Set();
  const boundaryRe = qNorm.length >= 3 ? new RegExp(`\\b${escapeRegExp(qNorm)}\\b`) : null;

  for (const { org, norm, kvk } of register) {
    if (norm === qNorm) {
      exact.push({ org, kvk, note: 'exact name match' });
      continue;
    }
    if (boundaryRe && boundaryRe.test(norm) && !strongSeen.has(org)) {
      strongSeen.add(org);
      strong.push({ org, kvk, note: 'contains your search text' });
    }
  }

  if (exact.length) return { grade: 'EXACT', matches: exact };
  if (strong.length) return { grade: 'STRONG', matches: strong.slice(0, 15) };

  const scored = [];
  for (const { org, norm, kvk } of register) {
    const ratio = similarityRatio(qNorm, norm);
    if (ratio >= FUZZY_CUTOFF) scored.push({ org, kvk, ratio });
  }
  scored.sort((a, b) => b.ratio - a.ratio);
  const top = scored.slice(0, 5);
  if (top.length) {
    return {
      grade: 'FUZZY',
      matches: top.map((m) => ({ org: m.org, kvk: m.kvk, note: `similar name (score ${m.ratio.toFixed(2)})` })),
    };
  }
  return { grade: 'NONE', matches: [] };
}

export function checkCompany(query, kmReg, researchReg) {
  return {
    query,
    km: matchOne(query, kmReg),
    research: matchOne(query, researchReg),
  };
}

const GRADE_ICON = { EXACT: '✅', STRONG: '🟡', FUZZY: '🟠', NONE: '❌' };
const GRADE_FLAG = { EXACT: 'yes', STRONG: 'likely', FUZZY: 'maybe', NONE: 'no' };

export function overallVerdict(res) {
  if (res.km.grade === 'EXACT' || res.research.grade === 'EXACT') return 'sponsor';
  if (['STRONG', 'FUZZY'].includes(res.km.grade) || ['STRONG', 'FUZZY'].includes(res.research.grade)) return 'verify';
  return 'not_found';
}

function formatSummary(results) {
  const lines = [];
  for (const res of results) {
    lines.push(`\n### ${res.query}`);
    for (const [label, key] of [
      ['KM / Work (highly skilled migrant)', 'km'],
      ['Research (EU Directive 2016/801)', 'research'],
    ]) {
      const { grade, matches } = res[key];
      const icon = GRADE_ICON[grade];
      if (grade === 'EXACT') {
        const { org, kvk } = matches[0];
        lines.push(`  ${icon} ${label}: ON THE REGISTER — ${org} (KvK ${kvk})`);
      } else if (grade === 'STRONG' || grade === 'FUZZY') {
        const verb = grade === 'STRONG' ? 'Likely match' : 'Possible match';
        lines.push(`  ${icon} ${label}: ${verb} — verify:`);
        for (const { org, kvk, note } of matches) lines.push(`       - ${org} (KvK ${kvk}) [${note}]`);
      } else {
        lines.push(`  ${icon} ${label}: not found`);
      }
    }
  }
  const verdicts = results.map(overallVerdict);
  lines.push('\n---');
  lines.push(`Summary: ${verdicts.filter((v) => v === 'sponsor').length} on register, `
    + `${verdicts.filter((v) => v === 'verify').length} to verify, `
    + `${verdicts.filter((v) => v === 'not_found').length} not found.`);
  return lines.join('\n');
}

// --- Bulk sources: --tracker and --input-csv --------------------------------

/** Every distinct, non-placeholder company in data/applications.md, in row order. */
export function trackerCompanies(trackerContent) {
  const lines = trackerContent.split('\n');
  const colmap = resolveColumns(lines);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const company = String(row.company ?? '').trim();
    if (!company || isPlaceholderCompany(company)) continue;
    const key = normalizeSponsorName(company);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ company, trackerNum: row.num });
  }
  return out;
}

function annotateCsv(inputCsv, nameColumn, kmReg, researchReg) {
  const rows = parseCsv(readFileSync(inputCsv, 'utf-8'));
  if (rows.length === 0) throw new Error(`${inputCsv} is empty`);
  const header = rows[0];
  const colIdx = header.indexOf(nameColumn);
  if (colIdx === -1) throw new Error(`column '${nameColumn}' not in ${JSON.stringify(header)}`);
  const dataRows = rows.slice(1);
  const results = dataRows.map((r) => {
    const name = String(r[colIdx] ?? '').trim();
    return name ? checkCompany(name, kmReg, researchReg) : null;
  });
  return { header, colIdx, dataRows, results };
}

function writeAnnotatedCsv(outputCsv, header, colIdx, dataRows, results) {
  const outHeader = [...header, 'KM_sponsor', 'Research_sponsor', 'sponsor_match_detail'];
  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [outHeader.map(csvCell).join(',')];
  dataRows.forEach((row, i) => {
    const res = results[i];
    const out = [...row];
    if (res) {
      const detail = res.km.matches[0]?.org ?? res.research.matches[0]?.org ?? '';
      out[header.length] = GRADE_FLAG[res.km.grade];
      out[header.length + 1] = GRADE_FLAG[res.research.grade];
      out[header.length + 2] = detail;
    } else {
      out[header.length] = '';
      out[header.length + 1] = '';
      out[header.length + 2] = '';
    }
    lines.push(out.map(csvCell).join(','));
  });
  writeFileSync(outputCsv, lines.join('\n') + '\n', 'utf-8');
}

// --- Self-test ---------------------------------------------------------------
function selfTest() {
  let failures = 0;
  const check = (label, cond) => {
    if (!cond) { console.error(`FAIL: ${label}`); failures++; }
  };

  check('normalize strips legal suffix + accents', normalizeSponsorName('Koninklijke Philips N.V.') === 'koninklijke philips');
  check('normalize handles "The X B.V." filler', normalizeSponsorName('The Talent Institute B.V.') === normalizeSponsorName('Talent Institute'));
  check('normalize collapses dotted abbreviations', normalizeSponsorName('V.O.F. Test') === 'test');
  check('normalize of empty/punctuation-only is empty string', normalizeSponsorName('   ...  ') === '');

  const fixtureRegister = [
    { org: 'Koninklijke Philips N.V.', norm: normalizeSponsorName('Koninklijke Philips N.V.'), kvk: '123' },
    { org: 'ASML Netherlands B.V.', norm: normalizeSponsorName('ASML Netherlands B.V.'), kvk: '456' },
    { org: 'Totally Unrelated Corp B.V.', norm: normalizeSponsorName('Totally Unrelated Corp B.V.'), kvk: '789' },
  ];

  const exactRes = matchOne('ASML Netherlands B.V.', fixtureRegister);
  check('exact match grades EXACT', exactRes.grade === 'EXACT' && exactRes.matches[0].kvk === '456');

  const strongRes = matchOne('Philips', fixtureRegister);
  check('substring match grades STRONG', strongRes.grade === 'STRONG' && strongRes.matches.some((m) => m.kvk === '123'));

  const fuzzyRes = matchOne('Koninklijke Philps NV', fixtureRegister); // two typos
  check('typo-tolerant match grades FUZZY or better', fuzzyRes.grade === 'FUZZY' || fuzzyRes.grade === 'EXACT' || fuzzyRes.grade === 'STRONG');

  const noneRes = matchOne('Completely Nonexistent Entity Xyzzy', fixtureRegister);
  check('no plausible match grades NONE', noneRes.grade === 'NONE');

  const overall = checkCompany('ASML Netherlands B.V.', fixtureRegister, []);
  check('overallVerdict is "sponsor" on an EXACT km match', overallVerdict(overall) === 'sponsor');

  const trackerFixture = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-01-01 | ASML | Analyst | 4.2/5 | Applied | ✅ | [1](reports/1.md) | |',
    '| 2 | 2026-01-02 | ? | Analyst | 3.0/5 | Discarded | ❌ | — | undisclosed |',
    '| 3 | 2026-01-03 | ASML | Analyst 2 | 4.0/5 | Applied | ✅ | [3](reports/3.md) | dup company |',
  ].join('\n');
  const companies = trackerCompanies(trackerFixture);
  check('trackerCompanies skips the "?" placeholder row', !companies.some((c) => c.company === '?'));
  check('trackerCompanies dedupes the same company across rows', companies.filter((c) => normalizeSponsorName(c.company) === normalizeSponsorName('ASML')).length === 1);

  check(`bundled KM register file exists at ${KM_FILE}`, existsSync(KM_FILE));
  check(`bundled research register file exists at ${RESEARCH_FILE}`, existsSync(RESEARCH_FILE));
  if (existsSync(KM_FILE)) {
    const reg = loadRegisterFile(KM_FILE);
    check('bundled KM register loads a plausible number of rows', reg.length > 1000);
  }

  if (failures === 0) {
    console.log('sponsor-check.mjs --self-test: all checks passed');
    process.exit(0);
  } else {
    console.error(`sponsor-check.mjs --self-test: ${failures} check(s) failed`);
    process.exit(1);
  }
}

// --- CLI ---------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (hasFlag(args, '--self-test')) {
    selfTest();
    return;
  }

  const kmReg = loadRegisterFile(KM_FILE);
  const researchReg = loadRegisterFile(RESEARCH_FILE);
  const summary = hasFlag(args, '--summary');
  const inputCsv = flagValue(args, '--input-csv');
  const nameColumn = flagValue(args, '--name-column');
  const outputCsv = flagValue(args, '--output-csv');
  const useTracker = hasFlag(args, '--tracker');

  if (inputCsv && !nameColumn) {
    console.error('Error: --name-column is required with --input-csv');
    process.exit(1);
  }

  let results;
  let sourceNote;

  if (useTracker) {
    const root = getCareerOpsRoot();
    const trackerPath = resolveTrackerPath(root);
    if (!existsSync(trackerPath)) {
      console.error(`Error: tracker not found at ${trackerPath}`);
      process.exit(1);
    }
    const companies = trackerCompanies(readFileSync(trackerPath, 'utf-8'));
    results = companies.map(({ company, trackerNum }) => ({ ...checkCompany(company, kmReg, researchReg), trackerNum }));
    sourceNote = `tracker (${trackerPath})`;
  } else if (inputCsv) {
    const { header, colIdx, dataRows, results: csvResults } = annotateCsv(inputCsv, nameColumn, kmReg, researchReg);
    results = csvResults.filter(Boolean);
    if (outputCsv) {
      writeAnnotatedCsv(outputCsv, header, colIdx, dataRows, csvResults);
    }
    sourceNote = `${inputCsv} (column "${nameColumn}")`;
  } else {
    const names = args.filter((a) => !a.startsWith('-'));
    if (names.length === 0) {
      console.log(USAGE);
      process.exit(0);
    }
    results = names.map((n) => checkCompany(n, kmReg, researchReg));
    sourceNote = 'ad hoc names';
  }

  if (summary) {
    console.log(`Checked ${results.length} name(s) against KM (${kmReg.length}) and Research (${researchReg.length}) sponsor registers. Source: ${sourceNote}.`);
    console.log(formatSummary(results));
    if (outputCsv) console.log(`\nAnnotated CSV written to ${outputCsv}`);
    console.log('\nCaveats: this is a monthly snapshot, not the live register — re-check '
      + 'https://ind.nl/en/public-register-recognised-sponsors before anything decision-critical. '
      + 'Being on the register does not mean a company will sponsor a specific role.');
    return;
  }

  const payload = {
    source: sourceNote,
    registerSizes: { km: kmReg.length, research: researchReg.length },
    results,
    summary: {
      sponsor: results.filter((r) => overallVerdict(r) === 'sponsor').length,
      verify: results.filter((r) => overallVerdict(r) === 'verify').length,
      not_found: results.filter((r) => overallVerdict(r) === 'not_found').length,
    },
    caveats: [
      'Snapshot, not live — re-check https://ind.nl/en/public-register-recognised-sponsors before anything decision-critical.',
      'On the register does not mean a company will sponsor a specific role, or that the role clears the salary threshold.',
    ],
    outputCsv: outputCsv || null,
  };
  console.log(JSON.stringify(payload, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
