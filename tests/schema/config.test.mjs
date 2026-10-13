import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { configSchema, parseConfig } from '../../src/config.ts';

const schemaText = readFileSync(new URL('../../schemas/config-v1.schema.json', import.meta.url), 'utf8');
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(schemaText));
const minimal = () => ({ schemaVersion: 1, page: { id: 'page', url: 'http://127.0.0.1:3000/' }, rules: [{ id: 'copy', selector: 'p', allowed: [{ familyName: 'Primary' }] }] });
const runtime = (input, mode) => { try { parseConfig(input, mode); return true; } catch { return false; } };
function parity(input, expected, mode = 'audit') {
  const original = structuredClone(input);
  assert.equal(validate(input), expected, JSON.stringify(validate.errors));
  assert.equal(runtime(input, mode), expected);
  assert.deepEqual(input, original, 'Validation must not mutate or fill defaults in the caller input');
}

test('shipped schema is deterministic input schema, using Draft 2020-12', () => {
  assert.equal(JSON.parse(schemaText).$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schemaText, JSON.stringify(z.toJSONSchema(configSchema, { io: 'input', target: 'draft-2020-12' }), null, 2) + '\n');
});
test('FW-2: official example and minimal audit/inspect inputs pass real schema and runtime validation', () => {
  parity(JSON.parse(readFileSync(new URL('../../examples/font-loading-site/fontwitness.config.json', import.meta.url), 'utf8')), true);
  parity(minimal(), true);
  const inspect = minimal(); delete inspect.rules[0].allowed;
  parity(inspect, true, 'inspect');
  assert.equal(runtime(inspect, 'audit'), false, 'Audit additionally requires exhaustive allowed matchers');
});
test('empty and partially defaulted nested inputs remain optional, without requiring resolved outputs', () => {
  for (const fields of [
    { browser: {}, readiness: {}, limits: {}, artifacts: {} },
    { browser: { locale: 'ru-RU' }, readiness: { maxAttempts: 1 }, limits: { maxTextNodes: 2 }, artifacts: { includeText: true } },
    { preparation: { hook: './prepare.mjs' } }
  ]) parity({ ...minimal(), ...fields }, true);
  const c = parseConfig({ ...minimal(), readiness: {}, limits: {} });
  assert.equal(c.readiness.totalTimeoutMs, 90000); assert.equal(c.limits.maxTextLength, 16384);
  parity({ ...minimal(), browser: { viewport: {} } }, false);
});

const ranges = [
  ['browser.viewport.width', 320, 3840], ['browser.viewport.height', 200, 2160],
  ['browser.deviceScaleFactor', 0.5, 3],
  ['readiness.navigationTimeoutMs', 100, 120000], ['readiness.fontTimeoutMs', 50, 120000],
  ['readiness.stableWindowMs', 20, 5000], ['readiness.maxAttempts', 1, 5], ['readiness.totalTimeoutMs', 100, 300000],
  ['limits.maxTextNodes', 1, 10000], ['limits.maxMatchesPerRule', 1, 2000], ['limits.maxTextLength', 16, 65536],
  ['preparation.timeoutMs', 100, 60000], ['rules.0.minMatches', 1, 2000]
];
for (const [path, min, max] of ranges) test(`schema/runtime range parity: ${path}`, () => {
  for (const [value, expected] of [[min, true], [max, true], [min - 1, false], [max + 1, false], ['100', false], ...(path === 'browser.deviceScaleFactor' ? [[1.5, true]] : [[min + 0.5, false]])]) {
    const input = minimal(); input.browser = { viewport: { width: 1280, height: 800 } }; input.preparation = { hook: './prepare.mjs' };
    const parts = path.split('.'); let target = input;
    for (const p of parts.slice(0, -1)) target = target[p] ??= {};
    target[parts.at(-1)] = value; parity(input, expected);
  }
});
test('schema/runtime reject unknown keys, invalid arrays, types, enums, and key syntax', () => {
  for (const mutate of [
    c => c.unknown = true, c => c.page.secret = true, c => c.browser = { unknown: true },
    c => c.readiness = { unknown: true }, c => c.limits = { unknown: true }, c => c.artifacts = { unknown: true },
    c => c.rules[0].unknown = true, c => c.rules[0].allowed[0].unknown = true,
    c => c.rules = [], c => c.rules[0].allowed = [], c => c.rules[0].match = 'first',
    c => c.rules[0].scope = 'shadow', c => c.rules[0].keyAttribute = 'data bad',
    c => c.rules[0].allowed[0].isCustomFont = 'true', c => c.page.url = 'not a URL',
    c => c.browser = { headless: null }, c => c.rules[0].selector = '', c => c.schemaVersion = 2
  ]) { const c = minimal(); mutate(c); parity(c, false); }
});
test('documented semantic refinements remain authoritative at runtime', () => {
  for (const mutate of [
    c => c.rules[0].allowed = [{}], c => c.rules.push({ ...c.rules[0], selector: 'span' }),
    c => c.page.url = 'ftp://example.com/', c => c.preparation = { hook: 'https://example.com/prepare.mjs' }
  ]) {
    const c = minimal(); mutate(c);
    assert.equal(validate(c), true); assert.equal(runtime(c, 'inspect'), false);
  }
});
