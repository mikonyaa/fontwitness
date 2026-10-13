import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { parseArgs } from 'node:util';
import { compareRuns } from '../dist/compare.js';
import { loadCapture, parseCapture } from '../dist/capture-input.js';
import { writeReport } from '../dist/artifacts.js';
import { renderReport } from '../dist/report/render.js';
import { hash, fontIdentity } from '../dist/util.js';

const args = parseArgs({ options: { baseline: { type: 'string' }, label: { type: 'string' }, worker: { type: 'boolean' }, input: { type: 'string' }, out: { type: 'string' } } }).values;
if (args.worker) {
  const started = performance.now(); let loaded, compared, written;
  let summary, failure;
  try {
    const a = await loadCapture(args.input), b = await loadCapture(args.input); loaded = performance.now();
    const result = compareRuns(a, b); compared = performance.now(); summary = result.summary;
    await mkdir(args.out); await writeReport(args.out, result); written = performance.now();
  } catch (error) { failure = { code: error.code ?? error.message, message: error.message }; }
  console.log(JSON.stringify({ summary, failure, loadMs: loaded && loaded - started, compareMs: compared && compared - loaded, reportMs: written && written - compared, elapsedMs: performance.now() - started, maxRSSKiB: process.resourceUsage().maxRSS }));
} else {
  if (!args.baseline || !args.label) throw new Error('Usage: npm run profile:compare -- --baseline real-capture.json --label unique-label');
  const base = parseCapture(JSON.parse(await readFile(args.baseline, 'utf8')));
  const directory = resolve('artifacts/performance', args.label); await mkdir(directory, { recursive: true });
  const maxBytes = 25 * 1024 * 1024;
  const actual = base.observations.find(o => o.measurementStatus === 'measured' && o.fonts.length === 1);
  if (!actual) throw new Error('Baseline needs a real single-font observation');
  const templateRule = base.capturedRules[0].rule;
  function fixture(roots, nodesPerRoot, rows) {
    const observations = [], elements = [], results = [];
    for (let i = 0; i < roots; i++) {
      const path = `0.1.${i}`, nodeIds = [];
      for (let j = 0; j < nodesPerRoot; j++) {
        const o = structuredClone(actual); o.id = `t${i * nodesPerRoot + j + 1}`; o.path = `${path}.${j}`; delete o.provenance.backendNodeId;
        observations.push(o); nodeIds.push(o.id);
      }
      const e = { id: `e${i + 1}`, key: `root-${i}`, path, nodeIds, textFingerprint: hash(JSON.stringify(Array(nodesPerRoot).fill(actual.textFingerprint))), structureFingerprint: hash(JSON.stringify(Array.from({ length: nodesPerRoot }, (_, j) => `.${j}`))), signature: hash(`synthetic-root-${i}`), measurementStatus: 'measured', coverage: 'complete', reasons: [], counts: { textNodes: nodesPerRoot, measured: nodesPerRoot, excluded: 0, unsupported: 0 } };
      elements.push(e);
      const f = actual.fonts[0];
      results.push({ elementId: e.id, key: e.key, measurementStatus: 'measured', contractStatus: 'expected', coverage: 'complete', reasons: [], actualFonts: [{ familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, observationIds: nodeIds }], allowed: templateRule.allowed, required: templateRule.required });
    }
    const capturedRules = [], ruleResults = [];
    for (let i = 0, remaining = rows; remaining > 0; i++) {
      const count = Math.min(roots, remaining); remaining -= count;
      const rule = { ...templateRule, id: `synthetic-${i}` };
      capturedRules.push({ rule, matched: count, elements: elements.slice(0, count), reasons: [] });
      ruleResults.push({ id: rule.id, selector: rule.selector, contractStatus: 'expected', coverage: 'complete', matched: count, reasons: [], elements: results.slice(0, count) });
    }
    return { ...base, captureId: 'synthetic-stress-fixture', target: { pageId: 'synthetic-stress-fixture', url: 'http://127.0.0.1/benchmark', finalUrl: 'http://127.0.0.1/benchmark' }, settings: { ...base.settings, limits: { ...base.settings.limits, maxTextNodes: roots === 2000 ? 10000 : 2000, maxMatchesPerRule: roots === 2000 ? 2000 : 200 } }, observations, capturedRules, ruleResults, diagnostics: [], networkEvidence: [], artifactManifest: [], coverage: { ...base.coverage, status: 'complete', matched: rows, measured: observations.length, unmeasured: 0, excluded: 0, unsupported: 0 }, summary: { exitCode: 0, partial: false, contractVerdict: 'expected' } };
  }
  function sizes(run) {
    const changes = run.capturedRules.flatMap(r => r.elements.map(e => ({ ruleId: r.rule.id, key: e.key, before: actual.fonts.map(fontIdentity), after: actual.fonts.map(fontIdentity), changed: false })));
    const comparison = { schemaVersion: 1, kind: 'comparison', toolVersion: base.toolVersion, recordedAt: base.recordedAt, mode: 'strict', contractVerdict: null, before: run.captureId, after: run.captureId, environmentDifferences: [], diagnostics: [], changes, summary: { exitCode: 0, partial: false, changed: 0 } };
    return { inputBytes: Buffer.byteLength(JSON.stringify(run, null, 2) + '\n'), reportBytes: Buffer.byteLength(renderReport(comparison)) };
  }
  // Maximize rows while retaining the maximum 10,000 canonical nodes and 2,000 matches/rule,
  // and respecting both 25 MiB capture and offline HTML ceilings. This is synthetic stress data.
  let low = 2000, high = 200000;
  while (low < high) {
    const rows = Math.ceil((low + high) / 2), candidate = fixture(2000, 5, rows), bytes = sizes(candidate);
    if (bytes.inputBytes <= maxBytes && bytes.reportBytes <= maxBytes) low = rows; else high = rows - 1;
  }
  const fixtures = [['typical', fixture(100, 1, 100)], ['maximum', fixture(2000, 5, low)]];
  const data = { label: args.label, synthetic: true, baseline: resolve(args.baseline), node: process.version, os: process.platform, osVersion: release(), arch: process.arch, recordedBrowser: base.environment.browser, recordedPlaywright: base.environment.playwright, browserLaunchedByBenchmark: false, maxBytes, fixtures: [], raw: [] };
  await writeFile(join(directory, 'environment.json'), JSON.stringify(data, null, 2) + '\n');
  for (const [name, run] of fixtures) {
    const file = join(directory, `${name}.json`); await writeFile(file, JSON.stringify(run, null, 2) + '\n');
    data.fixtures.push({ name, ...sizes(run), observations: run.observations.length, rules: run.capturedRules.length, elements: run.coverage.matched, limits: run.settings.limits, sha256: hash(await readFile(file)) });
    for (let index = 1; index <= 3; index++) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '--input', file, '--out', join(directory, `${name}-${index}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => errors += bytes);
        child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
      });
      data.raw.push({ name, index, ...result });
      await writeFile(join(directory, 'results.json'), JSON.stringify(data, null, 2) + '\n');
      console.log(JSON.stringify(data.raw.at(-1)));
      if (result.failure || result.summary.exitCode !== 0) throw new Error('Benchmark pipeline did not complete successfully; raw result saved');
    }
  }
}
