/**
 * Run every backend suite one at a time and report honestly.
 *
 * The PowerShell version of this loop counted per-test PASS/FAIL markers with a
 * mojibake regex, so any suite that prints only markers (no "Results:" summary
 * line) came back as "0/0" — which reads as a pass but means nothing ran. This
 * version reads the output as UTF-8 in Node, and treats a suite that produced no
 * recognisable result as a FAILURE rather than silently passing it.
 *
 *   node scripts/run_all_suites.js [--only <substring>]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.resolve(__dirname, '..', 'test');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null;

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !only || f.includes(only))
  .sort();

const results = [];

for (const file of files) {
  const started = Date.now();
  let out = '';
  let crashed = null;
  try {
    out = execFileSync('node', [path.join(TEST_DIR, file)], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit can still be a normal "tests failed" report, so keep the
    // output and only mark it crashed if there is no readable result at all.
    out = `${err.stdout || ''}${err.stderr || ''}`;
    crashed = err.status === null ? 'signal' : `exit ${err.status}`;
  }

  // Two summary shapes exist in this repo, and mis-reading one of them turns a
  // genuinely passing suite into a false failure:
  //   "Results: 46/46 tests passed (0 failed)"
  //   "RESULTS: 18 passed, 0 failed"
  // Both are authoritative, so both are honoured. A suite that matches neither
  // falls back to counting markers, and one with no markers at all is reported
  // as unreadable rather than silently passing.
  const summary =
    out.match(/Results:\s*(\d+)\/(\d+)\s*tests passed\s*\((\d+)\s*failed\)/) ||
    out.match(/RESULTS:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
  const passMarks = (out.match(/(?:^|\s)(?:PASS|\u2705\s*PASS)/gm) || []).length;
  const failMarks = (out.match(/(?:^|\s)FAIL/gm) || []).length;

  let pass;
  let total;
  let fail;
  let counted;
  if (summary && summary.length === 4) {
    pass = Number(summary[1]);
    total = Number(summary[2]);
    fail = Number(summary[3]);
    counted = 'summary';
  } else if (summary) {
    // "<n> passed, <m> failed" carries no total; the total is the sum.
    pass = Number(summary[1]);
    fail = Number(summary[2]);
    total = pass + fail;
    counted = 'summary-alt';
  } else if (passMarks + failMarks > 0) {
    pass = passMarks;
    fail = failMarks;
    total = pass + fail;
    counted = 'markers';
  } else {
    pass = 0;
    total = 0;
    fail = 1;
    counted = 'unreadable';
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ file, pass, total, fail, counted, crashed, secs });

  const flag = fail > 0 ? 'FAIL' : 'ok  ';
  console.log(
    `${flag} ${file.padEnd(48)} ${String(pass).padStart(4)}/${String(total).padEnd(-4)} ` +
      `fail=${fail} [${counted}] ${secs}s${crashed ? ` (${crashed})` : ''}`
  );
  if (fail > 0 && counted === 'unreadable') {
    console.log(out.split(/\r?\n/).slice(-15).join('\n'));
  }
}

console.log('\n=================== SUMMARY ===================');
const bad = results.filter((r) => r.fail > 0);
const unreadable = results.filter((r) => r.counted === 'unreadable');
for (const r of bad) {
  console.log(`FAILING: ${r.file} ${r.pass}/${r.total} fail=${r.fail} (${r.counted})`);
}
const tp = results.reduce((a, r) => a + r.pass, 0);
const tt = results.reduce((a, r) => a + r.total, 0);
const tf = results.reduce((a, r) => a + r.fail, 0);
console.log(
  `TOTAL ${tp}/${tt} passed, ${tf} failed, across ${results.length} suites` +
    (unreadable.length ? `  (${unreadable.length} produced no readable result)` : '')
);
process.exit(tf > 0 ? 1 : 0);
