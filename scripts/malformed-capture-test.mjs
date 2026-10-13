import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { evaluateRule } from '../dist/contracts.js';
import { hash } from '../dist/util.js';

// Optional arguments exercise the installed CLI with its own real captures as well.
const cli = resolve(process.argv[2] ?? 'dist/cli.js');
const baseline = JSON.parse(await readFile(process.argv[3] ?? 'site/reports/correct/capture.json', 'utf8'));
const changedFile = resolve(process.argv[4] ?? 'site/reports/broken/capture.json');
const temporary = await mkdtemp(join(tmpdir(), 'fontwitness-malformed-'));
const evidence = [];
const fixture = async (name, capture) => {
  const file = join(temporary, `${name}.json`); await writeFile(file, JSON.stringify(capture)); return file;
};
function command(args, expected) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json', '--no-open'], { cwd: temporary, encoding: 'utf8', timeout: 30000, maxBuffer: 30 * 1024 * 1024 });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  const value = JSON.parse(result.stdout);
  assert.doesNotMatch(result.stdout, /secret-unknown-field/);
  evidence.push({ args, expected, exitCode: result.status, summary: value.summary, error: value.error, diagnostics: value.diagnostics });
  return value;
}
async function compare(name, a, b = a, expected = 2, cross = false) {
  const out = join(temporary, `out-${name}`);
  const value = command(['compare', a, b, '--out', out, ...(cross ? ['--cross-env'] : [])], expected);
  if (expected === 2) { await assert.rejects(access(out)); assert.equal(value.error.code, 'INVALID_CAPTURE'); }
  else { await access(join(out, 'report.html')); assert.equal(value.contractVerdict, null); assert.equal(value.summary.exitCode, expected); }
  return value;
}
const good = await fixture('intact', baseline);
assert.equal((await compare('equal', good, good, 0)).summary.partial, false);
assert.equal((await compare('change', good, changedFile, 1)).summary.changed > 0, true);
for (const [name, mutate] of [
  ['FW-1-missing-observations', c => c.observations = []],
  ['duplicate-observation', c => c.observations.push(structuredClone(c.observations[0]))],
  ['duplicate-rule', c => c.capturedRules.push(structuredClone(c.capturedRules[0]))],
  ['duplicate-element', c => c.capturedRules[0].elements.push(structuredClone(c.capturedRules[0].elements[0]))],
  ['dangling-node', c => c.capturedRules[0].elements[0].nodeIds.push('absent')],
  ['duplicate-node-reference', c => c.capturedRules[0].elements[0].nodeIds.push(c.capturedRules[0].elements[0].nodeIds[0])],
  ['lying-count', c => c.coverage.measured++],
  ['empty-measured-fonts', c => c.observations[0].fonts = []],
  ['invalid-glyph-count', c => c.observations[0].fonts[0].glyphCount = 1.5],
  ['unconfirmed-complete', c => c.readiness.stable = false],
  ['unsupported-complete', c => c.capturedRules[0].elements[0].counts.unsupported++],
  ['missing-resolved-setting', c => delete c.settings.limits.maxTextLength],
  ['missing-resolved-rule', c => delete c.capturedRules[0].rule.required],
  ['wrong-environment-type', c => c.environment.browser = 156],
  ['orphan-result', c => c.ruleResults[0].elements[0].elementId = 'absent'],
  ['dangling-font-origin', c => c.ruleResults[0].elements[0].actualFonts[0].observationIds = ['absent']],
  ['unknown-field', c => c['secret-unknown-field'] = 'private'],
  ['wrong-kind', c => c.kind = 'comparison']
]) { const damaged = structuredClone(baseline); mutate(damaged); await compare(name, await fixture(name, damaged)); }
const syntax = join(temporary, 'syntax.json'); await writeFile(syntax, '{ secret-unknown-field'); await compare('invalid-json', syntax);
const oversized = join(temporary, 'oversized.json'); await writeFile(oversized, ' '.repeat(25 * 1024 * 1024 + 1)); await compare('size-limit', oversized);

const partial = structuredClone(baseline);
partial.observations[0].fonts = []; partial.observations[0].measurementStatus = 'unmeasured';
partial.observations[0].reasons = [{ code: 'CDP_NODE_UNAVAILABLE', message: 'Text-node measurement was unavailable.' }];
for (const r of partial.capturedRules) for (const e of r.elements) if (e.nodeIds.includes(partial.observations[0].id)) {
  e.measurementStatus = 'unmeasured'; e.coverage = 'partial'; e.counts.measured--; e.reasons.push(...partial.observations[0].reasons);
}
partial.coverage.status = 'partial'; partial.coverage.measured--; partial.coverage.unmeasured++;
partial.summary = { exitCode: 3, partial: true, contractVerdict: 'unmeasured' };
partial.ruleResults = partial.capturedRules.map(r => evaluateRule(r, partial.observations));
const limited = await fixture('valid-partial', partial);
assert.equal((await compare('valid-partial', limited, limited, 3)).summary.partial, true);
assert.equal((await compare('valid-partial-cross', limited, limited, 3, true)).summary.partial, true);
for (const [name, mutate, code] of [
  ['policy', c => c.settings.capturePolicy = 'light-dom-textnodes-v1', 'CAPTURE_POLICY_MISMATCH'],
  ['text', c => {
    const o = c.observations[0]; delete o.text; o.textFingerprint = hash('changed text');
    for (const r of c.capturedRules) for (const e of r.elements) e.textFingerprint = hash(JSON.stringify(c.observations.filter(o => e.nodeIds.includes(o.id)).map(o => o.textFingerprint)));
  }, 'TEXT_INPUT_CHANGED'],
  ['structure', c => {
    c.observations[0].path += '.0';
    for (const r of c.capturedRules) for (const e of r.elements) e.structureFingerprint = hash(JSON.stringify(c.observations.filter(o => e.nodeIds.includes(o.id)).map(o => o.path.slice(e.path.length))));
  }, 'STRUCTURE_CHANGED'],
  ['environment', c => c.environment.os = c.environment.os === 'darwin' ? 'linux' : 'darwin', 'ENVIRONMENT_MISMATCH']
]) {
  const input = structuredClone(baseline); mutate(input); const file = await fixture(name, input);
  assert.ok((await compare(name, good, file, 3)).diagnostics.some(d => d.code === code));
  if (name === 'environment') { const result = await compare('environment-cross', good, file, 0, true); assert.equal(result.contractVerdict, null); }
  else await compare(`${name}-cross`, good, file, 3, true);
}
const unsupported = structuredClone(baseline); unsupported.settings.capturePolicy = 'unknown-policy'; const policy = await fixture('unsupported-policy', unsupported);
assert.ok((await compare('unsupported-self', policy, policy, 3)).diagnostics.some(d => d.code === 'UNSUPPORTED_CAPTURE_POLICY'));
const out = join(temporary, 'existing'); await mkdir(out); await writeFile(join(out, 'sentinel'), 'preserve');
assert.equal(command(['compare', good, good, '--out', out], 2).error.code, 'OUTPUT_EXISTS'); assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'preserve');
command(['compare', good, join(temporary, 'absent.json'), '--out', join(temporary, 'absent-output')], 2);
await mkdir('artifacts/malformed', { recursive: true });
await writeFile('artifacts/malformed/evidence.json', JSON.stringify({ node: process.version, cli, temporary, source: process.argv[3] ?? 'Archived macOS example, not a new capture', cases: evidence }, null, 2) + '\n');
console.log(JSON.stringify({ cases: evidence.length, acceptedExitCodes: [0, 1, 2, 3], temporary, cli }));
