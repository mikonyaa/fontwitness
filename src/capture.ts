import { randomUUID } from 'node:crypto';
import { platform, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CDPSession, BrowserContext, Page } from 'playwright';
import { chromium, installedPlaywrightVersion } from './browser.js';
import type { Config } from './config.js';
import { CAPTURE_POLICY, CHROMIUM_VERSION, PLAYWRIGHT_VERSION, TOOL_VERSION, type RunReport, type Diagnostic } from './model.js';
import { evaluateRule } from './contracts.js';
import { takeSnapshot, type Snapshot } from './dom-targets.js';
import { renderingFrame, stableWindow, waitFonts } from './readiness.js';
import { bounded, hash, sanitizeUrl } from './util.js';

export interface CaptureOptions { mode?: 'inspect' | 'audit'; configDir?: string; signal?: AbortSignal; screenshot?: (bytes: Buffer) => Promise<void>; }
export async function capturePage(config: Config, options: CaptureOptions = {}): Promise<RunReport> {
  const mode = options.mode ?? 'audit';
  const report: RunReport = { schemaVersion: 1, kind: 'capture', mode, toolVersion: TOOL_VERSION, captureId: randomUUID(), recordedAt: new Date().toISOString(), target: { pageId: config.page.id, url: sanitizeUrl(config.page.url), finalUrl: sanitizeUrl(config.page.url) }, environment: { browser: '', playwright: PLAYWRIGHT_VERSION, node: process.version, os: platform(), osVersion: release(), arch: arch() }, settings: { browser: config.browser, limits: config.limits, capturePolicy: CAPTURE_POLICY }, readiness: { fontsReady: false, stable: false, attempts: 0, stableWindowMs: config.readiness.stableWindowMs, samples: [] }, coverage: { status: 'partial', matched: 0, measured: 0, unmeasured: 0, excluded: 0, unsupported: 0, excludedSurfaces: ['iframes', 'shadow DOM (including closed roots)', 'canvas', 'SVG', 'generated content', 'form control values', 'whitespace-only nodes', 'script/style/template content'] }, observations: [], capturedRules: [], diagnostics: [], networkEvidence: [], artifactManifest: [], summary: { exitCode: 2, partial: true } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let domainsEnabled = false;
  let page: Page | undefined;
  let fatal = false;
  let interrupted = false;
  let deadline = false;
  const close = () => context?.close().catch(() => {});
  const abort = () => { interrupted = true; void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { deadline = true; void close(); }, config.readiness.totalTimeoutMs);
  try {
    if (options.signal?.aborted) throw new Error('INTERRUPTED');
    browser = await chromium.launch({ headless: config.browser.headless, chromiumSandbox: true, handleSIGINT: false, timeout: Math.min(30000, config.readiness.totalTimeoutMs) });
    report.environment.browser = browser.version(); report.environment.playwright = installedPlaywrightVersion;
    if (browser.version() !== CHROMIUM_VERSION || installedPlaywrightVersion !== PLAYWRIGHT_VERSION) throw new Error('BROWSER_VERSION_MISMATCH');
    context = await browser.newContext({ viewport: config.browser.viewport, deviceScaleFactor: config.browser.deviceScaleFactor, locale: config.browser.locale, acceptDownloads: false });
    page = await context.newPage();
    if (deadline || interrupted) throw new Error('STOPPED');
    // Only metadata is retained, never headers, response bodies, cookies, or auth state.
    page.on('requestfailed', req => { if (req.resourceType() === 'font' && report.networkEvidence.length < 200) report.networkEvidence.push({ url: sanitizeUrl(req.url()), code: 'FONT_REQUEST_FAILED' }); });
    page.on('response', res => { if (res.request().resourceType() === 'font' && res.status() >= 400 && report.networkEvidence.length < 200) report.networkEvidence.push({ url: sanitizeUrl(res.url()), status: res.status(), code: 'FONT_HTTP_ERROR' }); });
    cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); domainsEnabled = true;
    await page.goto(config.page.url, { waitUntil: 'domcontentloaded', timeout: config.readiness.navigationTimeoutMs });
    report.target.finalUrl = sanitizeUrl(page.url());
    if (config.preparation) {
      const hookPath = resolve(options.configDir ?? process.cwd(), config.preparation.hook);
      if (!hookPath.endsWith('.mjs')) throw new Error('PREPARATION_HOOK_MUST_BE_MJS');
      const hook: { prepare?: (args: { page: Page; context: BrowserContext }) => Promise<void> } = await bounded(import(pathToFileURL(hookPath).href), config.preparation.timeoutMs, 'PREPARATION_TIMEOUT');
      if (typeof hook.prepare !== 'function') throw new Error('PREPARATION_EXPORT_MISSING');
      await bounded(Promise.resolve(hook.prepare({ page, context })), config.preparation.timeoutMs, 'PREPARATION_TIMEOUT');
    }
    if (config.page.readySelector) await page.waitForSelector(config.page.readySelector, { state: 'attached', timeout: config.readiness.navigationTimeoutMs });
    report.readiness.fontsReady = await waitFonts(page, config.readiness.fontTimeoutMs);
    if (!report.readiness.fontsReady) report.diagnostics.push({ code: 'FONT_READY_TIMEOUT', message: 'document.fonts.ready did not settle before its deadline. Observations cannot establish a complete contract.' });
    let snapshot: Snapshot | undefined;
    for (let attempt = 1; attempt <= config.readiness.maxAttempts; attempt++) {
      report.readiness.attempts = attempt;
      await renderingFrame(page);
      const before = await takeSnapshot(cdp, config);
      await stableWindow(page, config.readiness.stableWindowMs);
      snapshot = await takeSnapshot(cdp, config);
      report.readiness.samples.push(before.signature, snapshot.signature);
      if (before.signature === snapshot.signature) { report.readiness.stable = true; break; }
    }
    if (!snapshot) throw new Error('CAPTURE_MISSING');
    report.observations = snapshot.observations; report.capturedRules = snapshot.rules;
    if (!report.readiness.stable) report.diagnostics.push({ code: 'UNSTABLE_CAPTURE', message: 'DOM, layout, or font observations changed during every measured window.' });
    if (config.artifacts.screenshots === 'viewport' && options.screenshot && report.readiness.stable) {
      const bytes = await page.screenshot({ fullPage: false, type: 'png', timeout: 10000 });
      if (bytes.length > 10 * 1024 * 1024) report.diagnostics.push({ code: 'SCREENSHOT_SIZE_LIMIT', message: 'Screenshot exceeded 10 MiB and was omitted.' });
      else {
        const after = await takeSnapshot(cdp, config);
        if (after.signature !== snapshot.signature) { report.readiness.stable = false; report.diagnostics.push({ code: 'SCREENSHOT_STATE_CHANGED', message: 'State changed during the viewport screenshot. Image omitted; capture is partial.' }); }
        else { await options.screenshot(bytes); report.artifactManifest.push({ path: 'viewport.png', mediaType: 'image/png', bytes: bytes.length, sha256: hash(bytes), consistent: true }); }
      }
    }
  } catch (error) {
    fatal = true;
    const message = error instanceof Error ? error.message : '';
    const known = ['SELECTOR_OR_DOM_COLLECTION_FAILED', 'PREPARATION_TIMEOUT', 'PREPARATION_EXPORT_MISSING', 'PREPARATION_HOOK_MUST_BE_MJS', 'RENDER_FRAME_TIMEOUT', 'BROWSER_VERSION_MISMATCH'];
    const code = interrupted ? 'INTERRUPTED' : deadline ? 'RUN_TIMEOUT' : known.includes(message) ? message : !browser ? 'BROWSER_UNAVAILABLE' : !cdp || !domainsEnabled ? 'CDP_UNAVAILABLE' : 'CAPTURE_EXECUTION_ERROR';
    report.diagnostics.push({ code, message: code === 'BROWSER_UNAVAILABLE' ? 'Compatible Chromium could not launch. Run fontwitness install-browser; review OS sandbox and browser availability.' : `Capture could not complete (${code}). No complete contract is claimed.` });
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    await cdp?.detach().catch(() => {}); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  }
  const readinessIssues: Diagnostic[] = report.diagnostics.filter(d => ['FONT_READY_TIMEOUT', 'UNSTABLE_CAPTURE', 'SCREENSHOT_STATE_CHANGED'].includes(d.code));
  if (readinessIssues.length) for (const rule of report.capturedRules) for (const element of rule.elements) { element.coverage = 'partial'; element.reasons.push(...readinessIssues); }
  const allElements = [...new Map(report.capturedRules.flatMap(r => r.elements).map(e => [e.id, e])).values()];
  report.coverage.matched = report.capturedRules.reduce((n, r) => n + r.matched, 0);
  report.coverage.measured = report.observations.filter(o => o.measurementStatus === 'measured').length;
  report.coverage.unmeasured = report.observations.length - report.coverage.measured;
  report.coverage.excluded = allElements.reduce((n, e) => n + e.counts.excluded, 0);
  report.coverage.unsupported = allElements.reduce((n, e) => n + e.counts.unsupported, 0);
  const partial = fatal || readinessIssues.length > 0 || report.capturedRules.some(r => r.reasons.length > 0 || r.elements.some(e => e.coverage === 'partial')) || report.observations.length === 0;
  report.coverage.status = partial ? 'partial' : 'complete';
  if (mode === 'audit') {
    report.ruleResults = report.capturedRules.map(r => evaluateRule(r, report.observations));
    const unexpected = report.ruleResults.some(r => r.contractStatus === 'unexpected');
    const verdict = unexpected ? 'unexpected' : partial ? 'unmeasured' : 'expected';
    report.summary = { exitCode: interrupted || options.signal?.aborted ? 130 : fatal ? 2 : unexpected ? 1 : partial ? 3 : 0, partial, contractVerdict: verdict };
  } else report.summary = { exitCode: interrupted || options.signal?.aborted ? 130 : fatal ? 2 : partial ? 3 : 0, partial };
  return report;
}
