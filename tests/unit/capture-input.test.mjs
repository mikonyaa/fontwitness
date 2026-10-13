import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareRuns } from '../../dist/index.js';
import { evaluateRule } from '../../dist/contracts.js';
import { hash } from '../../dist/util.js';

const saved = () => JSON.parse(readFileSync(new URL('../../site/reports/correct/capture.json', import.meta.url), 'utf8'));

test('FW-1: public compare boundary rejects missing observations rather than claiming complete equality', () => {
  const damaged = saved(); damaged.observations = [];
  assert.throws(() => compareRuns(damaged, damaged), { code: 'INVALID_CAPTURE' });
});

for (const [name, damage] of [
  ['dangling node reference', c => c.capturedRules[0].elements[0].nodeIds.push('absent')],
  ['duplicate observation ID', c => c.observations.push(structuredClone(c.observations[0]))],
  ['duplicate rule ID', c => c.capturedRules.push(structuredClone(c.capturedRules[0]))],
  ['duplicate element ID within a rule', c => c.capturedRules[0].elements.push(structuredClone(c.capturedRules[0].elements[0]))],
  ['lying complete count', c => c.coverage.measured = 0],
  ['invalid font glyph count', c => c.observations[0].fonts[0].glyphCount = -1],
  ['invalid browser setting', c => c.settings.browser.headless = 'true'],
  ['invalid environment shape', c => c.environment.os = {}],
  ['no evidence in a measured observation', c => c.observations[0].fonts = []],
  ['invented successful audit verdict', c => { c.observations[0].fonts[0].familyName = 'Forbidden'; delete c.ruleResults; }],
  ['contradictory summary flag', c => c.summary.partial = true],
  ['different roots sharing a canonical element ID', c => c.capturedRules[0].elements[1].id = c.capturedRules[0].elements[0].id]
]) test(`saved capture rejects ${name}`, () => {
  const damaged = saved(); damage(damaged);
  assert.throws(() => compareRuns(damaged, damaged), { code: 'INVALID_CAPTURE' });
});

test('intact independently recorded capture still compares completely', () => {
  const result = compareRuns(saved(), saved());
  assert.deepEqual(result.summary, { exitCode: 0, partial: false, changed: 0 });
  assert.ok(result.changes.every(c => c.before.length > 0 && c.after.length > 0));
});
test('raw font records sharing an identity retain their per-call counts and emitted origins', () => {
  const capture = saved();
  const originalCount = capture.observations[0].fonts[0].glyphCount;
  capture.observations[0].fonts.push({ ...capture.observations[0].fonts[0], glyphCount: 1 });
  capture.ruleResults = capture.capturedRules.map(rule => evaluateRule(rule, capture.observations));
  assert.equal(compareRuns(capture, capture).summary.exitCode, 0);
  assert.deepEqual(capture.observations[0].fonts.map(f => f.glyphCount), [originalCount, 1]);
  assert.deepEqual(capture.ruleResults[0].elements[0].actualFonts[0].observationIds, [capture.observations[0].id, capture.observations[0].id]);
});
test('font origins cannot silently drop one of several contributing TextNodes', () => {
  const capture = saved(), root = capture.capturedRules[0].elements[0];
  root.path = '1.1'; root.nodeIds = capture.observations.map(o => o.id);
  root.counts.textNodes = root.counts.measured = 2;
  root.textFingerprint = hash(JSON.stringify(capture.observations.map(o => o.textFingerprint)));
  root.structureFingerprint = hash(JSON.stringify(capture.observations.map(o => o.path.slice(root.path.length))));
  capture.ruleResults = capture.capturedRules.map(rule => evaluateRule(rule, capture.observations));
  assert.equal(compareRuns(capture, capture).summary.exitCode, 0);
  capture.ruleResults[0].elements[0].actualFonts[0].observationIds.pop();
  assert.throws(() => compareRuns(capture, capture), { code: 'INVALID_CAPTURE' });
});
