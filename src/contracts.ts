import type { CapturedRule, ElementCapture, ElementResult, FontUsage, Observation, RuleResult } from './model.js';
import type { FontMatcher, Rule } from './config.js';
import { fontIdentity } from './util.js';

export function matchesFont(font: FontUsage, matcher: FontMatcher): boolean {
  return Object.keys(matcher).length > 0 && Object.entries(matcher).every(([k, v]) => font[k as keyof FontUsage] === v);
}
export function evaluateElement(rule: Rule, element: ElementCapture, observations: Observation[]): ElementResult {
  const selected = observations.filter(o => element.nodeIds.includes(o.id));
  const actual = new Map<string, ElementResult['actualFonts'][number]>();
  for (const observation of selected) for (const font of observation.fonts) {
    const id = fontIdentity(font);
    const identity = actual.get(id) ?? { familyName: font.familyName, postScriptName: font.postScriptName, isCustomFont: font.isCustomFont, observationIds: [] };
    identity.observationIds.push(observation.id); actual.set(id, identity);
  }
  const reasons = [...element.reasons];
  let violation = false;
  for (const observation of selected) for (const font of observation.fonts) {
    if (!rule.allowed?.some(m => matchesFont(font, m))) { violation = true; const message = `Observed ${font.familyName} (${font.postScriptName}) is outside the allowed set.`; if (!reasons.some(r => r.message === message)) reasons.push({ code: 'FONT_NOT_ALLOWED', message }); }
  }
  // Absence is proven only when every selected surface was measured.
  if (element.coverage === 'complete' && element.measurementStatus === 'measured') for (const matcher of rule.required) {
    if (!selected.some(o => o.fonts.some(f => matchesFont(f, matcher)))) { violation = true; reasons.push({ code: 'REQUIRED_FONT_MISSING', message: `Required matcher ${JSON.stringify(matcher)} was not observed.` }); }
  }
  return { elementId: element.id, key: element.key, measurementStatus: element.measurementStatus, coverage: element.coverage, contractStatus: violation ? 'unexpected' : element.coverage === 'partial' || element.measurementStatus === 'unmeasured' ? 'unmeasured' : 'expected', reasons, actualFonts: [...actual.values()].sort((a, b) => fontIdentity(a).localeCompare(fontIdentity(b))), allowed: rule.allowed ?? [], required: rule.required };
}
export function evaluateRule(capture: CapturedRule, observations: Observation[]): RuleResult {
  const elements = capture.elements.map(e => evaluateElement(capture.rule, e, observations));
  const missing = capture.matched < capture.rule.minMatches;
  const reasons = [...capture.reasons];
  if (missing) reasons.push({ code: 'SELECTOR_MIN_MATCHES', message: `Expected at least ${capture.rule.minMatches} matches; found ${capture.matched}.` });
  const partial = capture.reasons.length > 0 || elements.some(e => e.coverage === 'partial');
  return { id: capture.rule.id, selector: capture.rule.selector, matched: capture.matched, elements, reasons, coverage: partial ? 'partial' : 'complete', contractStatus: missing || elements.some(e => e.contractStatus === 'unexpected') ? 'unexpected' : partial || elements.some(e => e.contractStatus === 'unmeasured') ? 'unmeasured' : 'expected' };
}
