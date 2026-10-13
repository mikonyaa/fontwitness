import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../../examples/font-loading-site/server.mjs';
import { parseCapture } from '../../dist/capture-input.js';

test('source CLI: real font delivery, equal/change/partial/input errors, missing-browser doctor, and SIGINT JSON', async () => {
  const server = await startDemoServer(); const cwd = await mkdtemp(join(tmpdir(), 'fontwitness-source-cli-'));
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  const configFile = join(cwd, 'config.json');
  const config = { schemaVersion: 1, page: { id: 'source-cli', url: '' }, rules: [{ id: 'copy', selector: '[data-font-check]', keyAttribute: 'data-font-check', allowed: [{ familyName: 'Alegreya Sans' }], required: [{ familyName: 'Alegreya Sans' }] }] };
  const run = (args, expected = 0, env = process.env) => new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args, '--json'], { cwd, env, encoding: 'utf8', timeout: 40000, maxBuffer: 30 * 1024 * 1024 }, (error, stdout, stderr) => {
      try { assert.equal(error?.code ?? 0, expected, stderr + stdout); resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); }
    });
  });
  try {
    for (const [mode, code] of [['correct', 0], ['broken', 1], ['fixed', 0], ['mixed', 3]]) {
      config.page.url = `${server.origin}/${mode}`; await writeFile(configFile, JSON.stringify(config));
      const value = await run(['audit', '--config', configFile, '--out', mode, '--no-open'], code);
      assert.equal(value.summary.exitCode, code); parseCapture(value);
      assert.equal(JSON.parse(await readFile(join(cwd, mode, 'capture.json'), 'utf8')).summary.exitCode, code);
    }
    assert.equal((await run(['compare', 'correct/capture.json', 'fixed/capture.json', '--out', 'equal'])).summary.partial, false);
    assert.equal((await run(['compare', 'broken/capture.json', 'fixed/capture.json', '--out', 'changed'], 1)).summary.changed, 2);
    assert.equal((await run(['compare', 'mixed/capture.json', 'mixed/capture.json', '--out', 'partial'], 3)).summary.partial, true);
    assert.equal((await run(['compare', 'broken/capture.json', 'fixed/capture.json', '--cross-env', '--out', 'descriptive'])).contractVerdict, null);
    const malformed = JSON.parse(await readFile(join(cwd, 'correct/capture.json'), 'utf8')); malformed.observations = [];
    await writeFile(join(cwd, 'malformed.json'), JSON.stringify(malformed));
    assert.equal((await run(['compare', 'malformed.json', 'malformed.json', '--out', 'invalid-capture'], 2)).error.code, 'INVALID_CAPTURE');
    assert.equal((await run(['compare', 'correct/capture.json', 'fixed/capture.json', '--out', 'equal'], 2)).error.code, 'OUTPUT_EXISTS');
    await writeFile(join(cwd, 'invalid.json'), '{}'); assert.equal((await run(['audit', '--config', 'invalid.json', '--out', 'invalid-config'], 2)).error.code, 'INVALID_CONFIG');
    assert.equal((await run(['audit', '--config', 'absent.json', '--out', 'absent'], 2)).exitCode, 2);
    const missing = await run(['doctor'], 2, { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(cwd, 'missing-browser-cache') });
    assert.equal(missing.code, 'BROWSER_MISSING'); assert.match(missing.action, /install-browser/);
    config.page.url = `${server.origin}/deadline`; await writeFile(configFile, JSON.stringify(config));
    const child = spawn(process.execPath, [cli, 'audit', '--config', configFile, '--out', 'interrupted', '--json'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', timer, deadline; child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.once('data', () => { timer = setTimeout(() => child.kill('SIGINT'), 150); });
    const code = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); reject(new Error('Owned source CLI exceeded SIGINT deadline')); }, 40000);
      child.once('close', resolve); child.once('error', reject);
    }).finally(() => { clearTimeout(timer); clearTimeout(deadline); });
    assert.equal(code, 130); assert.equal(parseCapture(JSON.parse(stdout)).summary.exitCode, 130);
  } finally { await server.close(); }
});
