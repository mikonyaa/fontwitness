import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { configSchema, matcherSchema, ruleSchema } from './config.js';
import type { RunReport } from './model.js';
import { fontIdentity, hash } from './util.js';
import { evaluateRule } from './contracts.js';

const text = z.string().max(4096);
const id = text.min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const coverage = z.enum(['complete', 'partial']);
const measurement = z.enum(['measured', 'unmeasured']);
const contract = z.enum(['expected', 'unexpected', 'unmeasured']);
const diagnostic = z.strictObject({ code: id, message: text });
const reasons = z.array(diagnostic);
const identity = { familyName: text, postScriptName: text, isCustomFont: z.boolean() };
// A saved capture contains resolved settings. Never manufacture evidence via config defaults.
const browserInput = configSchema.shape.browser.removeDefault();
const limitsInput = configSchema.shape.limits.removeDefault();
const browser = browserInput.extend({
  headless: browserInput.shape.headless.removeDefault(), viewport: browserInput.shape.viewport.removeDefault(),
  deviceScaleFactor: browserInput.shape.deviceScaleFactor.removeDefault(), locale: browserInput.shape.locale.removeDefault()
});
const limits = limitsInput.extend({
  maxTextNodes: limitsInput.shape.maxTextNodes.removeDefault(),
  maxMatchesPerRule: limitsInput.shape.maxMatchesPerRule.removeDefault(),
  maxTextLength: limitsInput.shape.maxTextLength.removeDefault()
});
const rule = ruleSchema.extend({
  match: ruleSchema.shape.match.removeDefault(), scope: ruleSchema.shape.scope.removeDefault(),
  minMatches: ruleSchema.shape.minMatches.removeDefault(), required: ruleSchema.shape.required.removeDefault()
});
const element = z.strictObject({
  id, key: id.nullable(), path: text, nodeIds: z.array(id).max(10000),
  textFingerprint: fingerprint, structureFingerprint: fingerprint, signature: fingerprint,
  measurementStatus: measurement, coverage, reasons,
  counts: z.strictObject({ textNodes: count, measured: count, excluded: count, unsupported: count })
});
const elementResult = z.strictObject({
  elementId: id, key: id.nullable(), measurementStatus: measurement, contractStatus: contract, coverage, reasons,
  actualFonts: z.array(z.strictObject({ ...identity, observationIds: z.array(id).min(1).max(10000) })),
  allowed: z.array(matcherSchema).max(100), required: z.array(matcherSchema).max(100)
});
const captureShape = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('capture'), mode: z.enum(['audit', 'inspect']),
  toolVersion: id, captureId: id, recordedAt: z.iso.datetime(),
  target: z.strictObject({ pageId: id, url: z.string().min(1).max(8192), finalUrl: z.string().min(1).max(8192) }),
  environment: z.strictObject({ browser: z.string().max(256), playwright: id, node: id, os: id, osVersion: id, arch: id }),
  settings: z.strictObject({ browser, limits, capturePolicy: id }),
  readiness: z.strictObject({ fontsReady: z.boolean(), stable: z.boolean(), attempts: count.max(5), stableWindowMs: count.min(20).max(5000), samples: z.array(fingerprint).max(10) }),
  coverage: z.strictObject({ status: coverage, matched: count, measured: count, unmeasured: count, excluded: count, unsupported: count, excludedSurfaces: z.array(text) }),
  observations: z.array(z.strictObject({
    id, path: text, textFingerprint: fingerprint, textLength: count.min(1), text: z.string().max(65536).optional(),
    requestedCSS: z.strictObject({ fontFamily: text, fontSize: text, fontWeight: text, fontStyle: text }),
    measurementStatus: measurement, fonts: z.array(z.strictObject({ ...identity, glyphCount: count })).max(65536), reasons,
    provenance: z.strictObject({ method: z.literal('CSS.getPlatformFontsForNode'), nodeType: z.literal(3), backendNodeId: count.min(1).optional() })
  })).max(10000),
  capturedRules: z.array(z.strictObject({ rule, matched: count, elements: z.array(element).max(2000), reasons })).max(100),
  ruleResults: z.array(z.strictObject({ id, selector: id, contractStatus: contract, coverage, matched: count, reasons, elements: z.array(elementResult).max(2000) })).max(100).optional(),
  diagnostics: reasons,
  networkEvidence: z.array(z.strictObject({ url: z.string().max(8192), status: count.min(100).max(599).optional(), code: id })).max(200),
  artifactManifest: z.array(z.strictObject({ path: id, mediaType: id, bytes: count, sha256: fingerprint, consistent: z.boolean() })),
  summary: z.strictObject({ exitCode: z.literal([0, 1, 2, 3, 130]), partial: z.boolean(), contractVerdict: contract.optional() })
});

export interface CaptureIssue { path: string; code: string; message: string; }
export class CaptureInputError extends Error {
  readonly code = 'INVALID_CAPTURE';
  constructor(readonly issues: CaptureIssue[]) { super('Capture evidence is malformed or internally inconsistent.'); }
}

/** Validate the recorded shape and evidence graph; this cannot authenticate the capture's origin. */
export function parseCapture(value: unknown): RunReport {
  const parsed = captureShape.safeParse(value);
  if (!parsed.success) throw new CaptureInputError(parsed.error.issues.slice(0, 20).map(i => ({
    path: i.path.join('.'), code: i.code,
    message: i.code === 'unrecognized_keys' ? 'Unexpected capture field.' : 'Invalid recorded field type, value, or size.'
  })));
  const run: RunReport = parsed.data;
  const issues: CaptureIssue[] = [];
  const check = (ok: boolean, path: string, message: string) => {
    if (!ok && issues.length < 20) issues.push({ path, code: 'EVIDENCE_INVARIANT', message });
  };
  const fatal = run.summary.exitCode === 2 || run.summary.exitCode === 130;
  const observations = new Map(run.observations.map((o, index) => [o.id, { o, index }]));
  check(observations.size === run.observations.length, 'observations', 'Observation IDs must be unique.');
  check(run.observations.length <= run.settings.limits.maxTextNodes, 'observations', 'Recorded text-node limit was exceeded.');
  for (const [i, o] of run.observations.entries()) {
    const path = `observations.${i}`;
    check(o.measurementStatus === 'measured' ? o.fonts.length > 0 && o.reasons.length === 0 : o.fonts.length === 0 && o.reasons.length > 0, path, 'Measurement status must agree with font evidence and reasons.');
    check(o.text === undefined || (o.text.length === Math.min(o.textLength, run.settings.limits.maxTextLength) && hash(o.text) === o.textFingerprint), path, 'Saved text must agree with its length, limit, and fingerprint.');
    check(o.textLength <= run.settings.limits.maxTextLength || o.reasons.some(r => r.code === 'TEXT_LENGTH_LIMIT'), path, 'Text exceeding the recorded limit needs a measurement reason.');
  }
  const ruleIds = new Set<string>();
  const canonicalElements = new Map<string, RunReport['capturedRules'][number]['elements'][number]>();
  const referenced = new Set<string>();
  for (const [ri, r] of run.capturedRules.entries()) {
    const path = `capturedRules.${ri}`;
    check(!ruleIds.has(r.rule.id), path, 'Rule IDs must be unique.'); ruleIds.add(r.rule.id);
    check(run.mode !== 'audit' || r.rule.allowed !== undefined, path, 'Recorded audit rules need allowed matchers.');
    check(r.elements.length === Math.min(r.matched, run.settings.limits.maxMatchesPerRule), path, 'Matched count, selected elements, and recorded match limit must agree.');
    check(r.matched <= run.settings.limits.maxMatchesPerRule || r.reasons.some(d => d.code === 'MATCH_LIMIT'), path, 'Truncated matches need an explicit match-limit reason.');
    const elementIds = new Set<string>();
    for (const [ei, e] of r.elements.entries()) {
      const ep = `${path}.elements.${ei}`;
      check(!elementIds.has(e.id), ep, 'Element IDs must be unique within a rule.'); elementIds.add(e.id);
      // The collector deliberately shares a canonical root ID across overlapping rules/scopes.
      check(!canonicalElements.has(e.id) || canonicalElements.get(e.id)!.path === e.path, ep, 'Shared element IDs must refer to the same canonical DOM root.');
      canonicalElements.set(e.id, e);
      check(new Set(e.nodeIds).size === e.nodeIds.length, ep, 'Element node references must be unique.');
      check(e.nodeIds.every(n => observations.has(n)), ep, 'Every element node reference needs an observation.');
      const selected = e.nodeIds.flatMap(n => { referenced.add(n); const entry = observations.get(n); return entry ? [entry] : []; }).sort((a, b) => a.index - b.index).map(entry => entry.o);
      const measured = selected.filter(o => o.measurementStatus === 'measured').length;
      check(e.counts.textNodes === e.nodeIds.length && e.counts.measured === measured, ep, 'Element counts must agree with referenced observations.');
      check((e.measurementStatus === 'measured') === (selected.length > 0 && measured === selected.length), ep, 'Element measurement status must agree with referenced observations.');
      check(e.textFingerprint === hash(JSON.stringify(selected.map(o => o.textFingerprint))) && e.structureFingerprint === hash(JSON.stringify(selected.map(o => o.path.slice(e.path.length)))), ep, 'Element fingerprints must agree with referenced text and structure.');
      check(e.coverage === 'partial' ? e.reasons.length > 0 : e.reasons.length === 0 && e.measurementStatus === 'measured' && e.counts.unsupported === 0, ep, 'Complete coverage needs measured supported text; partial coverage needs reasons.');
    }
  }
  check(run.observations.every(o => referenced.has(o.id)), 'observations', 'Observations must be referenced by a selected element.');
  check(fatal || run.capturedRules.length > 0, 'capturedRules', 'Nonfatal captures need recorded selection rules.');
  const measured = run.observations.filter(o => o.measurementStatus === 'measured').length;
  const elements = [...canonicalElements.values()];
  check(run.coverage.matched === run.capturedRules.reduce((n, r) => n + r.matched, 0), 'coverage.matched', 'Matched count must agree with all recorded rules.');
  check(run.coverage.measured === measured && run.coverage.unmeasured === run.observations.length - measured, 'coverage', 'Canonical measurement counts must agree with observations.');
  check(run.coverage.excluded === elements.reduce((n, e) => n + e.counts.excluded, 0) && run.coverage.unsupported === elements.reduce((n, e) => n + e.counts.unsupported, 0), 'coverage', 'Surface counts must agree with canonical selected roots.');
  check(run.readiness.samples.length % 2 === 0 && run.readiness.samples.length <= run.readiness.attempts * 2 && (fatal || run.readiness.samples.length === run.readiness.attempts * 2), 'readiness', 'Readiness samples must agree with attempted measurement windows.');
  const partial = fatal || !run.readiness.fontsReady || !run.readiness.stable || run.diagnostics.some(d => ['FONT_READY_TIMEOUT', 'UNSTABLE_CAPTURE', 'SCREENSHOT_STATE_CHANGED'].includes(d.code)) || run.observations.length === 0 || run.capturedRules.some(r => r.reasons.length > 0 || r.elements.some(e => e.coverage === 'partial'));
  check((run.coverage.status === 'partial') === partial && run.summary.partial === partial, 'coverage', 'Coverage and summary must agree with evidence completeness.');
  check(partial || (run.environment.browser.length > 0 && run.readiness.attempts > 0), 'environment', 'Complete captures need a browser and a confirmed readiness window.');
  check(run.summary.exitCode !== 0 || !partial, 'summary', 'Successful capture cannot have incomplete evidence.');
  check(run.summary.exitCode !== 3 || partial, 'summary', 'Insufficient measurement must retain partial coverage.');
  const evaluated = run.mode === 'audit' ? new Map(run.capturedRules.map(r => [r.rule.id, evaluateRule(r, run.observations)])) : undefined;
  if (run.mode === 'inspect') {
    check(run.ruleResults === undefined && run.summary.contractVerdict === undefined && run.summary.exitCode !== 1, 'summary', 'Inspect captures cannot contain contract verdicts.');
  } else {
    const unexpected = [...evaluated!.values()].some(r => r.contractStatus === 'unexpected');
    check(run.summary.contractVerdict === (unexpected ? 'unexpected' : partial ? 'unmeasured' : 'expected'), 'summary', 'Audit contract verdict must agree with evaluated evidence.');
    check(fatal || run.summary.exitCode === (unexpected ? 1 : partial ? 3 : 0), 'summary', 'Audit exit code must agree with its contract verdict.');
  }
  if (run.ruleResults) {
    const results = new Map(run.ruleResults.map(r => [r.id, r]));
    check(results.size === run.ruleResults.length && results.size === ruleIds.size && [...ruleIds].every(id => results.has(id)), 'ruleResults', 'Rule result IDs must uniquely reference all captured rules.');
    for (const [ri, r] of run.capturedRules.entries()) {
      const result = results.get(r.rule.id); if (!result) continue;
      const path = `ruleResults.${ri}`;
      const expected = evaluated?.get(r.rule.id);
      const expectedElements = new Map(expected?.elements.map(e => [e.elementId, e]));
      check(!!expected && result.contractStatus === expected.contractStatus && result.coverage === expected.coverage, path, 'Rule verdict and coverage must agree with evaluated evidence.');
      const resultElements = new Map(result.elements.map(e => [e.elementId, e]));
      check(result.selector === r.rule.selector && result.matched === r.matched && resultElements.size === result.elements.length && resultElements.size === r.elements.length, path, 'Rule results must agree with recorded selections.');
      for (const e of r.elements) {
        const er = resultElements.get(e.id);
        check(!!er, path, 'Element result IDs must reference the captured elements.'); if (!er) continue;
        check(er.key === e.key && er.coverage === e.coverage && er.measurementStatus === e.measurementStatus, path, 'Element result state must agree with captured evidence.');
        const expectedElement = expectedElements.get(e.id);
        check(er.contractStatus === expectedElement?.contractStatus && JSON.stringify(er.allowed) === JSON.stringify(r.rule.allowed) && JSON.stringify(er.required) === JSON.stringify(r.rule.required), path, 'Element verdict and matchers must agree with the recorded contract.');
        check(er.contractStatus !== 'expected' || e.coverage === 'complete' && e.measurementStatus === 'measured', path, 'Expected contracts need complete measured evidence.');
        check(new Set(er.actualFonts.map(fontIdentity)).size === er.actualFonts.length, path, 'Actual font identities must be unique.');
        for (const font of er.actualFonts) check(new Set(font.observationIds).size === font.observationIds.length && font.observationIds.every(id => e.nodeIds.includes(id) && observations.get(id)?.o.fonts.some(f => fontIdentity(f) === fontIdentity(font))), path, 'Actual font origins must reference matching element observations.');
        const actual = new Set(er.actualFonts.map(fontIdentity));
        check(e.nodeIds.every(id => observations.get(id)?.o.fonts.every(f => actual.has(fontIdentity(f)))), path, 'Actual font results must include the referenced font identities.');
      }
    }
  }
  if (issues.length) throw new CaptureInputError(issues);
  return run;
}

export async function loadCapture(file: string): Promise<RunReport> {
  if ((await stat(file)).size > 25 * 1024 * 1024) throw new CaptureInputError([{ path: '', code: 'CAPTURE_SIZE_LIMIT', message: 'Capture exceeds 25 MiB.' }]);
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CaptureInputError([{ path: '', code: 'INVALID_JSON', message: 'Capture must be a JSON document.' }]);
  }
  return parseCapture(value);
}
