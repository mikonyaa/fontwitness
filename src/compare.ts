import type { CompareReport } from './model.js';
import { TOOL_VERSION } from './model.js';
import { CAPTURE_POLICY, CHROMIUM_VERSION, PLAYWRIGHT_VERSION } from './model.js';
import { fontIdentity, indexObservations } from './util.js';
import { parseCapture } from './capture-input.js';

export function compareRuns(beforeInput: unknown, afterInput: unknown, crossEnv = false): CompareReport {
  const before = parseCapture(beforeInput), after = parseCapture(afterInput);
  const report: CompareReport = { schemaVersion: 1, kind: 'comparison', toolVersion: TOOL_VERSION, recordedAt: new Date().toISOString(), mode: crossEnv ? 'cross-env' : 'strict', contractVerdict: null, before: before.captureId, after: after.captureId, environmentDifferences: [], diagnostics: [], changes: [], summary: { exitCode: 3, partial: true, changed: 0 } };
  const issue = (code: string, message: string) => report.diagnostics.push({ code, message });
  if ([before, after].some(run => run.settings.capturePolicy !== CAPTURE_POLICY)) issue('UNSUPPORTED_CAPTURE_POLICY', 'This comparator supports light-dom-textnodes-v2; recapture using the supported policy.');
  if ([before, after].some(run => run.environment.browser !== CHROMIUM_VERSION || run.environment.playwright !== PLAYWRIGHT_VERSION)) issue('UNSUPPORTED_BROWSER_PAIR', 'Captures need the supported pinned Chromium/Playwright measurement pair.');
  if (before.schemaVersion !== after.schemaVersion || before.settings.capturePolicy !== after.settings.capturePolicy || JSON.stringify(before.settings.limits) !== JSON.stringify(after.settings.limits)) issue('CAPTURE_POLICY_MISMATCH', 'Capture schemas, limits, or policies differ.');
  for (const field of ['browser', 'playwright', 'node', 'os', 'osVersion', 'arch'] as const) if (before.environment[field] !== after.environment[field]) report.environmentDifferences.push(`environment.${field}: ${before.environment[field]} → ${after.environment[field]}`);
  for (const field of ['headless', 'viewport', 'deviceScaleFactor', 'locale'] as const) if (JSON.stringify(before.settings.browser[field]) !== JSON.stringify(after.settings.browser[field])) report.environmentDifferences.push(`browser.${field}: ${JSON.stringify(before.settings.browser[field])} → ${JSON.stringify(after.settings.browser[field])}`);
  if (!crossEnv && report.environmentDifferences.length) issue('ENVIRONMENT_MISMATCH', 'Strict comparison requires identical recorded environments.');
  if (before.target.pageId !== after.target.pageId) issue('PAGE_KEY_MISMATCH', 'Stable page IDs differ.');
  if (before.coverage.status === 'partial' || after.coverage.status === 'partial' || before.summary.exitCode === 2 || after.summary.exitCode === 2) issue('PARTIAL_CAPTURE', 'At least one capture is incomplete.');
  const beforeRules = new Map(before.capturedRules.map(r => [r.rule.id, r]));
  const afterRules = new Map(after.capturedRules.map(r => [r.rule.id, r]));
  const beforeNodes = indexObservations(before.observations), afterNodes = indexObservations(after.observations);
  const identities = (selected: ReturnType<typeof indexObservations>, ids: string[]) => [...new Set(selected(ids).flatMap(o => o.fonts.map(fontIdentity)))].sort();
  for (const id of new Set([...beforeRules.keys(), ...afterRules.keys()])) {
    const a = beforeRules.get(id), b = afterRules.get(id);
    if (!a || !b) { issue('RULE_SET_CHANGED', `Rule ${id} is missing in one capture.`); continue; }
    if (a.rule.selector !== b.rule.selector || a.rule.scope !== b.rule.scope || a.rule.keyAttribute !== b.rule.keyAttribute) issue('RULE_POLICY_CHANGED', `Rule ${id} selects a different scope or key policy.`);
    if (a.matched === 0 || b.matched === 0) issue('NO_COMPARABLE_ELEMENTS', `Rule ${id} has no selected elements in at least one capture.`);
    const keys = (elements: typeof a.elements) => {
      const map = new Map<string, typeof a.elements[number]>();
      for (const e of elements) { if (!e.key) issue('MISSING_ELEMENT_KEY', `Rule ${id} has an element without a stable key.`); else if (map.has(e.key)) issue('DUPLICATE_ELEMENT_KEY', `Rule ${id} has duplicate key ${e.key}.`); else map.set(e.key, e); }
      return map;
    };
    const ak = keys(a.elements), bk = keys(b.elements);
    for (const key of new Set([...ak.keys(), ...bk.keys()])) {
      const ae = ak.get(key), be = bk.get(key);
      if (!ae || !be) { issue('ELEMENT_SET_CHANGED', `Rule ${id}, key ${key} is missing in one capture.`); continue; }
      if (ae.textFingerprint !== be.textFingerprint) issue('TEXT_INPUT_CHANGED', `Rule ${id}, key ${key} has different text.`);
      if (ae.structureFingerprint !== be.structureFingerprint) issue('STRUCTURE_CHANGED', `Rule ${id}, key ${key} has different light-DOM text structure.`);
      const fontsA = identities(beforeNodes, ae.nodeIds), fontsB = identities(afterNodes, be.nodeIds);
      report.changes.push({ ruleId: id, key, before: fontsA, after: fontsB, changed: JSON.stringify(fontsA) !== JSON.stringify(fontsB) });
    }
  }
  report.summary.changed = report.changes.filter(c => c.changed).length;
  report.summary.partial = report.diagnostics.length > 0;
  report.summary.exitCode = report.summary.partial ? 3 : crossEnv ? 0 : report.summary.changed > 0 ? 1 : 0;
  return report;
}
