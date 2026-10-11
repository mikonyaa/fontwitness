import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { PLAYWRIGHT_VERSION } from './model.js';
import type { BrowserServer } from 'playwright';
import { bounded } from './util.js';

// A dedicated cache also prevents the installer pruning browsers owned by other tools.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), '.cache', 'fontwitness', `playwright-${PLAYWRIGHT_VERSION}`);
export const { chromium } = await import('playwright');
export const installedPlaywrightVersion: string = createRequire(import.meta.url)('playwright/package.json').version;
export async function closeOwnedServer(server: BrowserServer, graceMs = 2000): Promise<boolean> {
  try { await bounded(server.close(), graceMs, 'BROWSER_CLOSE_TIMEOUT'); return false; }
  catch { await bounded(server.kill(), 5000, 'BROWSER_KILL_TIMEOUT'); return true; }
}
export async function installBrowser(json = false): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(require.resolve('playwright/package.json'), '..', 'cli.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { shell: false, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1', ...(json ? { CI: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stderr.write(d)); child.stderr.on('data', d => process.stderr.write(d));
    const abort = () => child.kill('SIGINT'); process.once('SIGINT', abort);
    child.once('error', reject);
    child.once('exit', code => { process.removeListener('SIGINT', abort); if (code === 0) resolve(); else reject(new Error('BROWSER_INSTALL_FAILED')); });
  });
}
