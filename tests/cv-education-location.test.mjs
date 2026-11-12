// tests/cv-education-location.test.mjs — an education entry never renders a
// location/address line (confirmed 2026-09-23): every education entry is one
// line (title + org, year right-aligned), matching the house style captured
// in modes/_custom.md. This inverts the original #3523-follow-up behavior,
// where education[].location was added and rendered as a `.edu-location`
// div — that div is now permanently removed from the template contract, and
// a payload still carrying education[].location gets an "unrecognised key"
// warning (the field is ignored, not silently accepted) rather than the
// #3523 "renders nothing at all" failure mode this test used to guard.
//
// End-to-end through the real builder because build-cv-html.mjs exports nothing.
// Covers both render paths: the shipped section partial (templates/sections/) and
// the built-in builder (a template copy with no sections/ dir beside it).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail, run, NODE, ROOT, lastRunFailure } from './helpers.mjs';
import { ENTRY_FIELD_SPECS } from '../lib/cv-payload-schema.mjs';

console.log('\nbuild-cv-html.mjs — education entry never renders a location (HTML)');

const BASE = {
  lang: 'en',
  page_format: 'letter',
  candidate: { name: 'Edu Location', email: 'edu@example.com' },
  summary: 'Summary.',
  competencies: ['Competency'],
  experience: [{ company: 'Corp', role: 'Engineer', dates: '2024', bullets: ['Did a thing'] }],
  education: [
    { title: 'B.S. Computer Science', org: 'State University', year: '2020' },
    { title: 'M.S. Computer Science', org: 'Other University', year: '2022' },
  ],
  skills: [{ category: 'Languages', items: 'Node' }],
};

const dir = mkdtempSync(join(tmpdir(), 'cv-edu-loc-'));

// Build PAYLOAD through the template at templateArg (or the default) and return
// { html, stdout }, or null when the build failed (already reported).
function build(label, payload, templateArg) {
  const input = join(dir, `${label}.json`);
  const output = join(dir, `${label}.html`);
  writeFileSync(input, JSON.stringify(payload));
  const args = [join(ROOT, 'build-cv-html.mjs'), input, output];
  if (templateArg) args.push(templateArg);
  const stdout = run(NODE, args);
  if (stdout === null) {
    const f = lastRunFailure();
    fail(`${label}: build-cv-html.mjs crashed (exit ${f?.status}) - ${(f?.stderr || '').trim().split('\n').pop()}`);
    return null;
  }
  if (!existsSync(output)) {
    fail(`${label}: build-cv-html.mjs exited 0 but wrote no output file`);
    return null;
  }
  return { html: readFileSync(output, 'utf-8'), stdout };
}

// A copy of the default template with no sections/ dir beside it, so
// loadSectionPartials() finds nothing and the built-in builder runs.
function templateWithoutPartials() {
  const noPartialDir = join(dir, 'no-partials');
  mkdirSync(noPartialDir, { recursive: true });
  const dest = join(noPartialDir, 'cv-template.html');
  cpSync(join(ROOT, 'templates', 'cv-template.html'), dest, { recursive: false });
  return dest;
}

try {
  // 1 — the schema no longer lists `location` as a known education key.
  if (!ENTRY_FIELD_SPECS.html.education.known.includes('location')) {
    pass('schema: html education known keys do NOT include "location"');
  } else {
    fail(`schema: html education known keys still include "location" (${ENTRY_FIELD_SPECS.html.education.known.join(', ')})`);
  }

  for (const [label, templateArg] of [
    ['partial', null],
    ['builtin', templateWithoutPartials()],
  ]) {
    // A payload that still carries education[].location: never rendered, and
    // the unknown-key warning fires so an author notices the field is ignored.
    const withLoc = build(`${label}-with-location`, {
      ...BASE,
      education: [
        { title: 'B.S. Computer Science', org: 'State University', location: 'Berkeley, CA', year: '2020' },
        { title: 'M.S. Computer Science', org: 'Other University', year: '2022' },
      ],
    }, templateArg);
    if (withLoc) {
      if (withLoc.html.includes('class="edu-location"')) {
        fail(`${label}: edu-location div rendered — education must never show a location line`);
      } else {
        pass(`${label}: no edu-location div rendered even when education[].location is set`);
      }
      if (withLoc.html.includes('Berkeley, CA')) {
        fail(`${label}: the ignored location value still leaked into the rendered HTML somewhere`);
      } else {
        pass(`${label}: the ignored location value does not leak into the output`);
      }
      if (/unrecognised key.*location/i.test(withLoc.stdout)) {
        pass(`${label}: validator warns about the now-ignored education location key`);
      } else {
        fail(`${label}: expected an "unrecognised key location" warning, got: ${withLoc.stdout}`);
      }
    }

    // Baseline: no location in the payload at all — still one line per entry,
    // no edu-location div, no warning.
    const noLoc = build(`${label}-absent`, BASE, templateArg);
    if (noLoc) {
      if (noLoc.html.includes('class="edu-location"')) {
        fail(`${label}: edu-location div rendered when no entry has a location`);
      } else {
        pass(`${label}: no edu-location div when no entry has a location`);
      }
      if (/unrecognised key/i.test(noLoc.stdout)) {
        fail(`${label}: unexpected unrecognised-key warning with no location in the payload: ${noLoc.stdout}`);
      } else {
        pass(`${label}: no spurious warning when the payload never mentions location`);
      }
    }
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
