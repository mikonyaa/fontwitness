import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../dist/config.js';
import { capturePage } from '../../dist/capture.js';
import { compareRuns } from '../../dist/compare.js';
import { chromium, closeOwnedServer } from '../../dist/browser.js';
import { startDemoServer } from '../../examples/font-loading-site/server.mjs';

let server, temporary;
before(async () => { server = await startDemoServer(); temporary = await mkdtemp(join(tmpdir(), 'fontwitness-integration-')); });
after(async () => { await server.close(); });
const baseRule = { id: 'copy', selector: '[data-font-check]', keyAttribute: 'data-font-check', allowed: [{ familyName: 'Alegreya Sans', isCustomFont: true }], required: [{ familyName: 'Alegreya Sans' }] };
function config(mode, overrides = {}) { return parseConfig({ schemaVersion: 1, page: { id: 'fixture', url: `${server.origin}/${mode}`, readySelector: '[data-app-ready]' }, rules: [baseRule], ...overrides }); }
const familySet = run => [...new Set(run.observations.flatMap(o => o.fonts.map(f => f.familyName)))].sort();

test('real fixed vs 404: same CSS request, different engine identities, exits 0/1', async () => {
  const fixed = await capturePage(config('correct')); const broken = await capturePage(config('broken'));
  assert.equal(fixed.summary.exitCode, 0); assert.equal(broken.summary.exitCode, 1);
  assert.deepEqual(familySet(fixed), ['Alegreya Sans']); assert.ok(!familySet(broken).includes('Alegreya Sans'));
  assert.equal(fixed.observations[0].requestedCSS.fontFamily, broken.observations[0].requestedCSS.fontFamily);
  assert.ok(broken.networkEvidence.some(e => e.status === 404)); assert.ok(fixed.observations.every(o => o.fonts[0].postScriptName === 'AlegreyaSans-Regular'));
  assert.equal(compareRuns(broken, fixed).summary.exitCode, 1);
});
test('allowed real Latin/CJK fallback passes, observed forbidden fallback fails', async () => {
  const allowed = await capturePage(config('fallback', { rules: [{ ...baseRule, allowed: [{ familyName: 'Alegreya Sans' }, { familyName: 'Noto Sans CJK JP' }], required: [{ familyName: 'Alegreya Sans' }, { familyName: 'Noto Sans CJK JP' }] }] }));
  assert.equal(allowed.summary.exitCode, 0); assert.deepEqual(familySet(allowed), ['Alegreya Sans', 'Noto Sans CJK JP']);
  const forbidden = await capturePage(config('fallback')); assert.equal(forbidden.summary.exitCode, 1); assert.ok(forbidden.ruleResults[0].elements[0].reasons.some(r => r.code === 'FONT_NOT_ALLOWED'));
});
test('two CSS aliases keep the same platform identity', async () => {
  const run = await capturePage(config('aliases')); assert.equal(run.summary.exitCode, 0); assert.deepEqual(familySet(run), ['Alegreya Sans']); assert.notEqual(run.observations[0].requestedCSS.fontFamily, run.observations[1].requestedCSS.fontFamily);
});
test('FontFace from local bytes has real identity and no invented network URL', async () => {
  const run = await capturePage(config('bytes')); assert.equal(run.summary.exitCode, 0); assert.deepEqual(familySet(run), ['Alegreya Sans']); assert.deepEqual(run.networkEvidence, []); assert.ok(!JSON.stringify(run.observations).includes('primary.ttf'));
});
test('font-display swap late load settles; a font deadline remains partial', async () => {
  const late = await capturePage(config('late')); assert.equal(late.summary.exitCode, 0); assert.equal(late.readiness.fontsReady, true);
  const deadline = await capturePage(config('deadline', { readiness: { fontTimeoutMs: 50, stableWindowMs: 50, maxAttempts: 1 }, rules: [{ ...baseRule, allowed: [{ isCustomFont: true }, { isCustomFont: false }], required: [] }] }));
  assert.equal(deadline.summary.exitCode, 3); assert.equal(deadline.summary.contractVerdict, 'unmeasured'); assert.equal(deadline.readiness.fontsReady, false); assert.equal(deadline.summary.partial, true);
});
test('four levels, sibling TextNodes, all matches, overlapping selectors are canonical', async () => {
  const run = await capturePage(config('nested', { rules: [baseRule, { ...baseRule, id: 'deep', selector: '[data-nested]', keyAttribute: 'data-nested' }] }));
  assert.equal(run.summary.exitCode, 0); assert.equal(run.observations.length, 4); assert.equal(run.coverage.measured, 4); assert.equal(run.capturedRules[0].matched, 2);
  const deep = run.capturedRules[1].elements[0]; assert.equal(deep.nodeIds.length, 1); assert.ok(run.capturedRules[0].elements[0].nodeIds.includes(deep.nodeIds[0])); assert.equal(run.capturedRules[0].elements[0].nodeIds.length, 3);
});
test('last of several matches is audited and fails', async () => {
  const run = await capturePage(config('last')); assert.equal(run.summary.exitCode, 1); assert.equal(run.ruleResults[0].elements.length, 3); assert.equal(run.ruleResults[0].elements.at(-1).contractStatus, 'unexpected');
});
test('visible plus hidden text retains measured evidence and stays incomplete', async () => {
  const run = await capturePage(config('mixed')); assert.equal(run.summary.exitCode, 3); assert.equal(run.coverage.measured, 1); assert.equal(run.coverage.unmeasured, 1); assert.equal(run.ruleResults[0].contractStatus, 'unmeasured');
});
test('missing, hidden, empty, limits, unsupported surfaces, and invalid selectors', async () => {
  const missing = await capturePage(config('correct', { rules: [{ ...baseRule, selector: '#absent' }] })); assert.equal(missing.summary.exitCode, 1); assert.equal(missing.ruleResults[0].reasons[0].code, 'SELECTOR_MIN_MATCHES');
  for (const mode of ['hidden', 'empty', 'unsupported']) { const run = await capturePage(config(mode)); assert.equal(run.summary.exitCode, 3); assert.equal(run.summary.partial, true); }
  const limited = await capturePage(config('nested', { limits: { maxTextNodes: 1 } })); assert.equal(limited.summary.exitCode, 3); assert.ok(JSON.stringify(limited).includes('TEXT_NODE_LIMIT'));
  const matches = await capturePage(config('nested', { limits: { maxMatchesPerRule: 1 } })); assert.equal(matches.summary.exitCode, 3); assert.equal(matches.capturedRules[0].matched, 2); assert.ok(JSON.stringify(matches).includes('MATCH_LIMIT'));
  const invalid = await capturePage(config('correct', { rules: [{ ...baseRule, selector: '[' }] })); assert.equal(invalid.summary.exitCode, 2);
});
test('inspect has observations and no invented contract verdict', async () => {
  const run = await capturePage(config('broken'), { mode: 'inspect' }); assert.equal(run.summary.exitCode, 0); assert.ok(!('contractVerdict' in run.summary)); assert.ok(!('ruleResults' in run));
});
test('three real runs produce equal normalized observations', async () => {
  const runs = []; for (let i = 0; i < 3; i++) runs.push(await capturePage(config('nested')));
  const normalize = run => run.observations.map(({ provenance, ...o }) => ({ ...o, provenance: { method: provenance.method, nodeType: provenance.nodeType } }));
  assert.deepEqual(normalize(runs[0]), normalize(runs[1])); assert.deepEqual(normalize(runs[1]), normalize(runs[2])); assert.equal(compareRuns(runs[0], runs[2]).summary.exitCode, 0);
});
test('unstable rendering never passes', async () => {
  const run = await capturePage(config('unstable', { readiness: { maxAttempts: 2, stableWindowMs: 80 } })); assert.equal(run.summary.exitCode, 3); assert.ok(run.diagnostics.some(r => r.code === 'UNSTABLE_CAPTURE'));
});
test('trusted local hook, deadline, SIGINT cleanup and related reasons', async () => {
  const stopped = new AbortController(); stopped.abort();
  const skipped = await capturePage(config('correct'), { signal: stopped.signal });
  assert.equal(skipped.summary.exitCode, 130); assert.equal(skipped.diagnostics[0].code, 'INTERRUPTED'); assert.equal(skipped.observations.length, 0);
  const hook = join(temporary, 'hook.mjs'); await writeFile(hook, 'export async function prepare({page}) { await page.locator("nav").evaluate(e => e.remove()); }');
  const good = await capturePage(config('correct', { preparation: { hook } })); assert.equal(good.summary.exitCode, 0);
  const slow = join(temporary, 'slow.mjs'); await writeFile(slow, 'export async function prepare(){await new Promise(r=>setTimeout(r,500));}');
  const timeout = await capturePage(config('correct', { preparation: { hook: slow, timeoutMs: 100 } })); assert.equal(timeout.summary.exitCode, 2); assert.ok(timeout.diagnostics.some(d => d.code === 'PREPARATION_TIMEOUT'));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120); const abort = await capturePage(config('deadline'), { signal: controller.signal }); clearTimeout(timer); assert.equal(abort.summary.exitCode, 130);
  const deadline = await capturePage(config('deadline', { readiness: { totalTimeoutMs: 150 } })); assert.equal(deadline.summary.exitCode, 2); assert.ok(deadline.diagnostics.some(d => d.code === 'RUN_TIMEOUT'));
});
test('owned browser is terminated when graceful shutdown cannot complete', async () => {
  const owned = await chromium.launchServer({ headless: true, chromiumSandbox: true, host: '127.0.0.1', handleSIGINT: false });
  const process = owned.process();
  const close = owned.close;
  owned.close = () => new Promise(() => {});
  try {
    assert.equal(await closeOwnedServer(owned, 20), true);
    assert.ok(process.exitCode !== null || process.signalCode !== null, 'The exact owned Chromium process exited');
  } finally { owned.close = close; await owned.kill(); }
});
test('viewport evidence does not scroll or activate synthetic lazy state', async () => {
  let bytes; const run = await capturePage(config('lazy', { artifacts: { screenshots: 'viewport', includeText: true } }), { screenshot: async value => { bytes = value; } });
  assert.equal(run.summary.exitCode, 0); assert.ok(bytes.length > 1000); assert.equal(run.artifactManifest[0].consistent, true); assert.ok(!JSON.stringify(run.observations).includes('Changed after scroll'));
  const hook = join(temporary, 'scroll.mjs'); await writeFile(hook, 'export async function prepare({page}){await page.evaluate(()=>scrollTo(0,900));await page.waitForFunction(()=>document.querySelector("[data-font-check]").textContent==="Changed after scroll");}');
  const scrolled = await capturePage(config('lazy', { preparation: { hook }, artifacts: { screenshots: 'viewport', includeText: true } }), { screenshot: async () => {} }); assert.equal(scrolled.summary.exitCode, 0); assert.ok(JSON.stringify(scrolled.observations).includes('Changed after scroll'));
  assert.equal(compareRuns(run, scrolled).summary.exitCode, 3);
});
test('real browser engine unavailable produces fatal capture, never CSS-only success', async () => {
  // The native mechanism itself is exercised in every test above; mocking only this failure boundary.
  const original = chromium.launchServer; chromium.launchServer = async () => { throw new Error('browser unavailable'); };
  try { const run = await capturePage(config('correct')); assert.equal(run.summary.exitCode, 2); assert.equal(run.observations.length, 0); assert.equal(run.diagnostics[0].code, 'BROWSER_UNAVAILABLE'); }
  finally { chromium.launchServer = original; }
});
test('screenshot-time mutation omits inconsistent evidence and keeps a partial result', async () => {
  const launch = chromium.connect;
  chromium.connect = async (endpoint, options) => {
    const browser = await launch.call(chromium, endpoint, options); const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => { const context=await newContext(options);const newPage=context.newPage.bind(context);context.newPage=async()=>{const page=await newPage();const screenshot=page.screenshot.bind(page);page.screenshot=async options=>{const bytes=await screenshot(options);await page.evaluate(()=>document.querySelector('[data-font-check]').textContent='Mutation during image capture');return bytes;};return page;};return context;};
    return browser;
  };
  let attached = false;
  try { const run=await capturePage(config('correct',{artifacts:{screenshots:'viewport'}}),{screenshot:async()=>{attached=true;}});assert.equal(run.summary.exitCode,3);assert.ok(run.diagnostics.some(d=>d.code==='SCREENSHOT_STATE_CHANGED'));assert.equal(attached,false);assert.equal(run.artifactManifest.length,0); }
  finally { chromium.connect=launch; }
});
test('unavailable CDP domain is a fatal execution error with an explicit reason', async () => {
  const launch=chromium.connect;chromium.connect=async(endpoint,options)=>{const browser=await launch.call(chromium,endpoint,options);const newContext=browser.newContext.bind(browser);browser.newContext=async options=>{const context=await newContext(options);context.newCDPSession=async()=>{throw new Error('CDP blocked');};return context;};return browser;};
  try {const run=await capturePage(config('correct'));assert.equal(run.summary.exitCode,2);assert.equal(run.diagnostics[0].code,'CDP_UNAVAILABLE');}
  finally {chromium.connect=launch;}
});
