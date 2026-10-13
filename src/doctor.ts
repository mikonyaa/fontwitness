import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Browser, BrowserServer } from 'playwright';
import { chromium, installedPlaywrightVersion, closeOwnedServer } from './browser.js';
import { CHROMIUM_VERSION, PLAYWRIGHT_VERSION, type FontUsage } from './model.js';
import { bounded } from './util.js';

export type DoctorCode = 'READY' | 'BROWSER_MISSING' | 'VERSION_MISMATCH' | 'BROWSER_LAUNCH_DENIED' | 'BROWSER_LAUNCH_FAILED' | 'CDP_MEASUREMENT_FAILED' | 'BROWSER_CLEANUP_FAILED' | 'INTERRUPTED';
export interface DoctorReport {
  ok: boolean; code: DoctorCode; action: string; exitCode: 0 | 2 | 130;
  node: string; playwright: string; chromium?: string;
  expected: { nodeMajor: 24; playwright: string; chromium: string };
  mechanism?: 'CSS.getPlatformFontsForNode'; fonts?: FontUsage[];
}
const actions: Record<DoctorCode, string> = {
  READY: 'Ready to run FontWitness captures.',
  BROWSER_MISSING: 'Run fontwitness install-browser to install the pinned Chromium.',
  VERSION_MISMATCH: 'Use Node 24 and the exact bundled Playwright/Chromium pair; reinstall the pinned package and browser if needed.',
  BROWSER_LAUNCH_DENIED: 'Chromium is installed but launch was denied. Use a sandbox-capable environment with the required OS permissions; keep the sandbox enabled.',
  BROWSER_LAUNCH_FAILED: 'Chromium is installed but could not start. Check required OS libraries and browser execution support.',
  CDP_MEASUREMENT_FAILED: 'Chromium launched but TextNode CDP measurement failed. Check CDP support and the pinned browser pair.',
  BROWSER_CLEANUP_FAILED: 'The owned browser could not be closed within its deadline. Check browser process permissions.',
  INTERRUPTED: 'Doctor was interrupted. Rerun it when ready.'
};

export function doctorVersionsMatch(node: string, playwright: string, browser?: string): boolean {
  return /^v?24\./.test(node) && playwright === PLAYWRIGHT_VERSION && (browser === undefined || browser === CHROMIUM_VERSION);
}
export function classifyDoctorFailure(error: unknown, stage: 'launch' | 'measurement', interrupted = false): DoctorCode {
  if (interrupted) return 'INTERRUPTED';
  if (stage === 'measurement') return 'CDP_MEASUREMENT_FAILED';
  // Inspect locally, emit only the safe code/action. Raw browser logs can include paths and secrets.
  const message = error instanceof Error ? error.message : '';
  if (/executable doesn't exist/i.test(message)) return 'BROWSER_MISSING';
  return /sandbox|operation not permitted|permission denied|access is denied|EPERM|EACCES|launch denied|not allowed/i.test(message) ? 'BROWSER_LAUNCH_DENIED' : 'BROWSER_LAUNCH_FAILED';
}

export async function runDoctor(signal?: AbortSignal): Promise<DoctorReport> {
  const result = (code: DoctorCode, browser?: Browser, fonts?: FontUsage[]): DoctorReport => ({
    ok: code === 'READY', code, action: actions[code], exitCode: code === 'READY' ? 0 : code === 'INTERRUPTED' ? 130 : 2,
    node: process.version, playwright: installedPlaywrightVersion, ...(browser ? { chromium: browser.version() } : {}),
    expected: { nodeMajor: 24, playwright: PLAYWRIGHT_VERSION, chromium: CHROMIUM_VERSION },
    ...(fonts ? { mechanism: 'CSS.getPlatformFontsForNode', fonts } : {})
  });
  if (signal?.aborted) return result('INTERRUPTED');
  if (!doctorVersionsMatch(process.version, installedPlaywrightVersion)) return result('VERSION_MISMATCH');
  try { await access(chromium.executablePath(), constants.X_OK); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return result(signal?.aborted ? 'INTERRUPTED' : code === 'ENOENT' || code === 'ENOTDIR' ? 'BROWSER_MISSING' : 'BROWSER_LAUNCH_DENIED');
  }
  let server: BrowserServer | undefined;
  let browser: Browser | undefined;
  let stage: 'launch' | 'measurement' = 'launch';
  let report: DoctorReport;
  const stop = () => { void server?.kill().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) throw new Error('INTERRUPTED');
    server = await chromium.launchServer({ headless: true, chromiumSandbox: true, handleSIGINT: false, host: '127.0.0.1', timeout: 30000 });
    if (signal?.aborted) throw new Error('INTERRUPTED');
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 30000 });
    if (!doctorVersionsMatch(process.version, installedPlaywrightVersion, browser.version())) report = result('VERSION_MISMATCH', browser);
    else {
      stage = 'measurement';
      const context = await browser.newContext(); const page = await context.newPage();
      await page.setContent('<p>FontWitness doctor text</p>');
      const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); await cdp.send('DOM.getDocument', { depth: 0 });
      const { result: remote } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("p").firstChild' });
      if (!remote.objectId) throw new Error('TEXT_NODE_UNAVAILABLE');
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: remote.objectId });
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      if (node.nodeType !== 3) throw new Error('NODE_TYPE_MISMATCH');
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      if (!fonts.length) throw new Error('EMPTY_FONT_OBSERVATION');
      report = result(signal?.aborted ? 'INTERRUPTED' : 'READY', browser, fonts);
    }
  } catch (error) { report = result(classifyDoctorFailure(error, stage, signal?.aborted), browser); }
  finally {
    if (server) {
      try { await closeOwnedServer(server); }
      catch { report = result(signal?.aborted ? 'INTERRUPTED' : 'BROWSER_CLEANUP_FAILED', browser); }
    }
    await bounded(browser?.close().catch(() => {}) ?? Promise.resolve(), 2000, 'CLIENT_CLOSE_TIMEOUT').catch(() => {});
    signal?.removeEventListener('abort', stop);
  }
  return signal?.aborted ? result('INTERRUPTED', browser) : report;
}
