import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../dist/config.js';
import { matchesFont, evaluateRule } from '../../dist/contracts.js';
import { compareRuns } from '../../dist/compare.js';
import { escapeHtml, safeJson } from '../../dist/report/render.js';
import { sanitizeUrl } from '../../dist/util.js';
import { takeSnapshot } from '../../dist/dom-targets.js';
import { hash } from '../../dist/util.js';
import { CHROMIUM_VERSION } from '../../dist/model.js';

const font = { familyName: 'Primary', postScriptName: 'Primary-Regular', isCustomFont: true, glyphCount: 9 };
const config = () => parseConfig({ schemaVersion: 1, page: { id: 'test', url: 'http://127.0.0.1:3000' }, rules: [{ id: 'copy', selector: 'p', keyAttribute: 'data-key', allowed: [{ familyName: 'Primary' }], required: [{ familyName: 'Primary' }] }] });
const observation = () => ({ id: 't1', path: '1.2', textFingerprint: hash('Real text'), textLength: 9, requestedCSS: { fontFamily: 'Alias', fontSize: '20px', fontWeight: '400', fontStyle: 'normal' }, fonts: [font], reasons: [], measurementStatus: 'measured', provenance: { method: 'CSS.getPlatformFontsForNode', nodeType: 3 } });
const element = () => ({ id: 'e1', key: 'one', path: '1', nodeIds: ['t1'], textFingerprint: hash(JSON.stringify([observation().textFingerprint])), structureFingerprint: hash(JSON.stringify(['.2'])), signature: hash('signature'), measurementStatus: 'measured', coverage: 'complete', reasons: [], counts: { textNodes: 1, measured: 1, excluded: 0, unsupported: 0 } });
const run = () => ({ schemaVersion: 1, kind: 'capture', mode: 'inspect', toolVersion: '0.1.1', recordedAt: '2026-10-13T00:00:00.000Z', captureId: 'x', target: { pageId: 'page', url: 'http://127.0.0.1:3000/', finalUrl: 'http://127.0.0.1:3000/' }, environment: { browser: CHROMIUM_VERSION, playwright: '1.64.0', node: 'v24.21.0', os: 'linux', osVersion: '6', arch: 'x64' }, settings: { browser: config().browser, capturePolicy: 'light-dom-textnodes-v2', limits: config().limits }, readiness: { fontsReady: true, stable: true, attempts: 1, stableWindowMs: 200, samples: [hash('stable'), hash('stable')] }, coverage: { status: 'complete', matched: 1, measured: 1, unmeasured: 0, excluded: 0, unsupported: 0, excludedSurfaces: ['shadow DOM'] }, observations: [observation()], capturedRules: [{ rule: config().rules[0], matched: 1, elements: [element()], reasons: [] }], diagnostics: [], networkEvidence: [], artifactManifest: [], summary: { exitCode: 0, partial: false } });
const secondElement = r => { r.observations.push({ ...observation(), id: 't2', path: '2.2' }); r.capturedRules[0].elements.push({ ...element(), id: 'e2', key: 'second', path: '2', nodeIds: ['t2'] }); r.capturedRules[0].matched = 2; r.coverage.matched = 2; r.coverage.measured = 2; };

test('strict config validates URL, unknown keys, exhaustive allowed set, and unique rule IDs', () => {
  assert.equal(config().browser.locale, 'en-US');
  assert.throws(() => parseConfig({ ...config(), unknown: true }));
  assert.throws(() => parseConfig({ ...config(), page: { id: 'x', url: 'file:///tmp/private' } }));
  assert.throws(() => parseConfig({ ...config(), rules: [{ id: 'a', selector: 'p' }] }));
  assert.throws(() => parseConfig({ ...config(), rules: [config().rules[0], config().rules[0]] }));
  assert.throws(() => parseConfig({ ...config(), rules: [{ ...config().rules[0], allowed: [{}] }] }));
  assert.throws(() => parseConfig({ ...config(), preparation: { hook: 'https://example.com/code.mjs' } }));
});
test('matchers compare every explicit field exactly', () => {
  assert.equal(matchesFont(font, { familyName: 'Primary', isCustomFont: true }), true);
  assert.equal(matchesFont(font, { familyName: 'primary' }), false);
  assert.equal(matchesFont(font, { familyName: 'Prim' }), false);
  assert.equal(matchesFont(font, { postScriptName: 'Other' }), false);
  assert.equal(matchesFont(font, { familyName: 'Primary', isCustomFont: false }), false);
  assert.equal(matchesFont(font, {}), false);
});
test('independent contract verdicts: allowed, required, and disallowed', () => {
  const c = { rule: config().rules[0], matched: 1, elements: [element()], reasons: [] };
  assert.equal(evaluateRule(c, [observation()]).contractStatus, 'expected');
  const bad = { ...observation(), fonts: [{ ...font, familyName: 'Unexpected' }] };
  assert.equal(evaluateRule(c, [bad]).contractStatus, 'unexpected');
  assert.ok(evaluateRule(c, [bad]).elements[0].reasons.some(d => d.code === 'FONT_NOT_ALLOWED'));
  const missing = { ...c, rule: { ...c.rule, allowed: [{ familyName: 'Primary' }], required: [{ familyName: 'Secondary' }] } };
  assert.ok(evaluateRule(missing, [observation()]).elements[0].reasons.some(d => d.code === 'REQUIRED_FONT_MISSING'));
});
test('partial evidence never proves absence or produces expected', () => {
  const c = { rule: { ...config().rules[0], required: [{ familyName: 'Secondary' }] }, matched: 1, elements: [{ ...element(), coverage: 'partial', measurementStatus: 'unmeasured' }], reasons: [] };
  const result = evaluateRule(c, [observation()]);
  assert.equal(result.contractStatus, 'unmeasured');
  assert.ok(!result.elements[0].reasons.some(r => r.code === 'REQUIRED_FONT_MISSING'));
  const bad = evaluateRule(c, [{ ...observation(), fonts: [{ ...font, familyName: 'Bad' }] }]);
  assert.equal(bad.contractStatus, 'unexpected'); assert.equal(bad.coverage, 'partial');
});
test('all matches are evaluated, including a final defect', () => {
  const second = { ...element(), id: 'e2', nodeIds: ['t2'], key: 'last' };
  const result = evaluateRule({ rule: config().rules[0], matched: 2, elements: [element(), second], reasons: [] }, [observation(), { ...observation(), id: 't2', fonts: [{ ...font, familyName: 'Bad' }] }]);
  assert.equal(result.elements[0].contractStatus, 'expected'); assert.equal(result.elements[1].contractStatus, 'unexpected');
});
test('missing selector is a known violation', () => {
  const result = evaluateRule({ rule: config().rules[0], matched: 0, elements: [], reasons: [] }, []);
  assert.equal(result.contractStatus, 'unexpected'); assert.equal(result.reasons[0].code, 'SELECTOR_MIN_MATCHES');
});
test('allowed fallback retains distinct origins without glyph aggregation', () => {
  const o = { ...observation(), fonts: [font, { ...font, familyName: 'Secondary', postScriptName: 'Secondary' }] };
  const r = evaluateRule({ rule: { ...config().rules[0], allowed: [{ familyName: 'Primary' }, { familyName: 'Secondary' }] }, matched: 1, elements: [element()], reasons: [] }, [o]);
  assert.equal(r.contractStatus, 'expected'); assert.equal(r.elements[0].actualFonts.length, 2); assert.ok(!('glyphCount' in r.elements[0].actualFonts[0]));
});
test('compare equality and actual identity change use independent expectations', () => {
  const a = run(), b = run(); assert.equal(compareRuns(a, b).summary.exitCode, 0);
  b.observations[0].fonts = [{ ...font, familyName: 'Changed' }];
  assert.equal(compareRuns(a, b).summary.exitCode, 1); assert.equal(compareRuns(a, b).contractVerdict, null);
});
test('compare strict environment mismatch and cross-env semantics', () => {
  const a = run(), b = run(); b.environment.os = 'darwin'; b.observations[0].fonts = [{ ...font, familyName: 'Other' }];
  assert.equal(compareRuns(a, b).summary.exitCode, 3); assert.equal(compareRuns(a, b, true).summary.exitCode, 0);
  b.coverage.status = 'partial'; b.summary = { exitCode: 3, partial: true }; b.capturedRules[0].elements[0].coverage = 'partial'; b.capturedRules[0].elements[0].reasons.push({ code: 'UNSUPPORTED_SURFACE', message: 'Selected content includes unsupported content.' });
  assert.equal(compareRuns(a, b, true).summary.exitCode, 3);
});
test('compare refuses incompatible capture policies in both modes', () => {
  const before = run(), after = run(); before.settings.capturePolicy = 'light-dom-textnodes-v1';
  for (const crossEnv of [false, true]) {
    const result = compareRuns(before, after, crossEnv);
    assert.equal(result.summary.exitCode, 3); assert.equal(result.summary.partial, true);
    assert.equal(result.contractVerdict, null);
    assert.ok(result.diagnostics.some(reason => reason.code === 'CAPTURE_POLICY_MISMATCH'));
  }
});
test('compare duplicate keys, missing keys, text and structure changes stay ambiguous', () => {
  for (const mutate of [b => { secondElement(b); b.capturedRules[0].elements[1].key = 'one'; }, b => b.capturedRules[0].elements[0].key = null, b => { b.observations[0].textFingerprint = hash('different'); b.capturedRules[0].elements[0].textFingerprint = hash(JSON.stringify([b.observations[0].textFingerprint])); }, b => { b.observations[0].path = '1.3'; b.capturedRules[0].elements[0].structureFingerprint = hash(JSON.stringify(['.3'])); }]) {
    const b = run(); mutate(b); assert.equal(compareRuns(run(), b).summary.exitCode, 3);
  }
});
test('compare reordering uses keys rather than array indices or backend IDs', () => {
  const a = run(); secondElement(a); const b = structuredClone(a); b.capturedRules[0].elements.reverse(); b.observations[0].provenance.backendNodeId = 999;
  assert.equal(compareRuns(a, b).summary.exitCode, 0);
});
test('escaping and sanitization protect embedded HTML/JSON and URL credentials', () => {
  const s = '</script><script>globalThis.pwned=true</script>&\u2028';
  assert.ok(!escapeHtml(s).includes('<script>')); assert.ok(!safeJson({ s }).includes('</script>')); assert.equal(JSON.parse(safeJson({ s })).s, s);
  assert.equal(sanitizeUrl('https://user:password@example.com/path?token=secret#private'), 'https://example.com/path');
  assert.equal(sanitizeUrl('data:font/ttf;base64,AAAA'), '[data URL omitted]');
});
test('CDP node errors: detached, unavailable, empty observations are explicit', async () => {
  for (const mode of ['detached', 'unavailable', 'empty']) {
    const raw = { nodes: [{ id: 't1', path: '1.2', text: 'Real text', textLength: 9, requestedCSS: observation().requestedCSS, reasons: [] }], rules: [{ matched: 1, elements: [{ ...element(), unsupported: 0, excluded: 0, signature: 's' }], reasons: [] }], fontState: 'loaded' };
    const cdp = { send: async (method, args) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'root' } };
      if (method === 'Runtime.callFunctionOn') return { result: args.functionDeclaration.includes('this.data') ? { value: raw } : args.functionDeclaration.includes('this.nodes') ? { objectId: 'array' } : { value: mode !== 'detached' } };
      if (method === 'Runtime.getProperties') return { result: [{ name: '0', value: { objectId: 'text' } }] };
      if (method === 'DOM.requestNode') return { nodeId: 1 };
      if (method === 'DOM.describeNode') return { node: { nodeType: 3, backendNodeId: 9 } };
      if (method === 'CSS.getPlatformFontsForNode') { if (mode === 'unavailable') throw new Error('CDP unavailable'); return { fonts: [] }; }
      return {};
    } };
    const result = await takeSnapshot(cdp, config());
    assert.equal(result.observations[0].measurementStatus, 'unmeasured'); assert.equal(result.rules[0].elements[0].coverage, 'partial');
    assert.equal(result.observations[0].reasons[0].code, mode === 'detached' ? 'NODE_DETACHED' : mode === 'empty' ? 'EMPTY_FONT_OBSERVATION' : 'CDP_NODE_UNAVAILABLE');
  }
});
