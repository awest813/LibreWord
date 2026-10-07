/**
 * A small test runner for the end-to-end suites. Tests run in file order and
 * share one page, so a test may rely on the state an earlier one left.
 *
 *   node tests/e2e/smoke.mjs                 run everything
 *   node tests/e2e/smoke.mjs --grep paste    only tests whose name matches (case-insensitive)
 *   node tests/e2e/smoke.mjs --bail          stop at the first failure
 *   HEADED=1 SLOWMO=250 node tests/e2e/…     watch it in a visible browser
 *
 * With --grep, the suite's `setup` runs first (e.g. open a blank document) so
 * a test from the middle of the file has something to work on.
 *
 * Every page error or console error fails the test it happened in. A failing
 * test leaves a screenshot, the page HTML and the document JSON in
 * test-results/<suite>/ for debugging.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { chromium } from 'playwright-core';
import { LAUNCH } from './server.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const GREP = argValue('--grep') ?? process.env.GREP;
const BAIL = argv.includes('--bail') || Boolean(process.env.BAIL);
const grep = GREP ? new RegExp(GREP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

/** Launch options honouring HEADED and SLOWMO. */
export const launchOptions = (extra = {}) => ({
  ...LAUNCH,
  headless: !process.env.HEADED,
  slowMo: Number(process.env.SLOWMO) || 0,
  ...extra,
});
export const launch = (extra) => chromium.launch(launchOptions(extra));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/**
 * Create a suite. `page` is the page whose errors are watched and which is
 * captured on failure (it can be replaced later with suite.watch(page)).
 */
export function createSuite(file, { page = null, setup = null } = {}) {
  const name = basename(file).replace(/\.m?js$/, '');
  const outDir = new URL(`../../test-results/${name}/`, import.meta.url);
  const results = { passed: 0, failed: 0, skipped: 0 };
  // Failure captures from an earlier run would only mislead.
  rm(outDir, { recursive: true, force: true }).catch(() => {});
  let errors = [];
  let watched = null;
  let setupDone = !grep;
  let stopped = false;
  const started = Date.now();

  const onPageError = (e) => errors.push(`page error: ${e.message}`);
  const onConsole = (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
  };

  const suite = {
    /** Name of the test running now (for crash messages). */
    current: 'startup',
    /** Record an error from somewhere else (another tab, a worker) against the current test. */
    noteError(message) {
      errors.push(message);
    },

    /** Watch another page for errors (and capture it on failure). */
    watch(p) {
      if (watched) {
        watched.off('pageerror', onPageError);
        watched.off('console', onConsole);
      }
      watched = p;
      p.on('pageerror', onPageError);
      p.on('console', onConsole);
    },

    async capture(testName) {
      if (!watched || watched.isClosed()) return null;
      try {
        await mkdir(outDir, { recursive: true });
        const base = new URL(slug(testName), outDir).pathname;
        await watched.screenshot({ path: `${base}.png` }).catch(() => {});
        await writeFile(`${base}.html`, await watched.content()).catch(() => {});
        const json = await watched.evaluate(() => window.libreword?.editor?.getJSON?.() ?? null).catch(() => null);
        if (json) await writeFile(`${base}.json`, JSON.stringify(json, null, 2));
        return base;
      } catch {
        return null;
      }
    },

    async test(testName, fn) {
      if (stopped || (grep && !grep.test(testName))) {
        results.skipped++;
        return;
      }
      if (!setupDone) {
        setupDone = true;
        if (setup) await setup();
      }
      errors = [];
      suite.current = testName;
      const t0 = Date.now();
      try {
        await fn();
        if (errors.length) throw new Error(`Errors in the page during this test:\n${errors.join('\n')}`);
        results.passed++;
        const ms = Date.now() - t0;
        console.log(`  ✓ ${testName}${ms > 2000 ? ` (${(ms / 1000).toFixed(1)}s)` : ''}`);
      } catch (err) {
        results.failed++;
        // Long values (whole documents) are cut here; the saved .html/.json have everything.
        const lines = String(err.message).split('\n').slice(0, 16).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
        console.log(`  ✗ ${testName}\n    ${lines.join('\n    ')}`);
        const saved = await suite.capture(testName);
        if (saved) console.log(`    saved: ${saved}.png (and .html, .json)`);
        if (BAIL) stopped = true;
      }
    },

    /** Print the summary and exit with the right code. */
    finish() {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const parts = [`${results.passed} passed`];
      if (results.failed) parts.push(`${results.failed} failing`);
      if (results.skipped) parts.push(`${results.skipped} skipped`);
      console.log(`\n${results.failed ? '' : 'all passing — '}${parts.join(', ')} (${secs}s)`);
      return results.failed ? 1 : 0;
    },
  };
  if (page) suite.watch(page);
  return suite;
}
