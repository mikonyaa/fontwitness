import assert from 'node:assert/strict';
import { spawnSync, spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NO_COLOR: '1', FORCE_COLOR: '0' };
const run = (binary, args, cwd, expected = 0) => {
  console.error(`Consumer check: ${args.slice(0, 3).join(' ')}`);
  const result = spawnSync(binary, args, { cwd, env: environment, encoding: 'utf8', timeout: 120000, shell: false, maxBuffer: 30 * 1024 * 1024 });
  assert.equal(result.status, expected, `${binary} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result;
};
// Audits must be asynchronous while this process owns the synthetic HTTP server.
const runAsync = (binary, args, cwd, expected = 0) => new Promise((resolve, reject) => {
  console.error(`Consumer check: ${args.slice(0, 4).join(' ')}`);
  execFile(binary, args, { cwd, env: environment, encoding: 'utf8', timeout: 120000, shell: false, maxBuffer: 30 * 1024 * 1024 }, (error, stdout, stderr) => {
    try { assert.equal(error ? error.code : 0, expected, `${binary} ${args.join(' ')}\n${stderr}\n${stdout}`); resolve({ stdout, stderr }); }
    catch (failure) { reject(failure); }
  });
});
await mkdir('artifacts/package', { recursive: true });
const supplied = process.argv[2];
const pack = supplied ? resolve(supplied) : resolve('artifacts/package', JSON.parse(run('npm', ['pack', '--json', '--pack-destination', 'artifacts/package'], process.cwd()).stdout)[0].filename);
const list = run('tar', ['-tzf', pack], process.cwd()).stdout;
for (const required of ['package/dist/cli.js', 'package/schemas/config-v1.schema.json', 'package/examples/font-loading-site/server.mjs', 'package/fixtures/fonts/AlegreyaSans-Regular.ttf', 'package/fixtures/fonts/NotoSansCJKjp-Regular.otf', 'package/fixtures/fonts/alegreyasans-OFL.txt', 'package/fixtures/fonts/notosansjp-OFL.txt']) assert.ok(list.includes(required), required);
assert.ok(!/(node_modules|\.git\/|credentials|\.env|artifacts\/|tests\/|src\/)/.test(list));
const consumer = await mkdtemp(join(tmpdir(), 'fontwitness-consumer-'));
await writeFile(join(consumer, 'package.json'), '{"name":"fontwitness-release-consumer","version":"1.0.0","private":true,"type":"module"}\n');
run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', pack], consumer);
const binary = join(consumer, 'node_modules/.bin/fontwitness');
assert.equal(run(binary, ['--version'], consumer).stdout.trim(), '0.1.1');
assert.ok(run(binary, ['--help'], consumer).stdout.includes('inspect'));
assert.equal(JSON.parse(run(binary, ['install-browser', '--json'], consumer).stdout).installed, true);
assert.equal(JSON.parse(run(binary, ['doctor', '--json'], consumer).stdout).ok, true);
const demo = JSON.parse(run(binary, ['demo', '--out', './demo', '--json', '--no-open'], consumer).stdout);
assert.equal(demo.selfTest, true); assert.equal(demo.runs.broken.exitCode, 1); assert.equal(demo.runs.fallback.exitCode, 0);
run(binary, ['init', '--dir', './example', '--json'], consumer);
run(binary, ['init', '--dir', './example', '--json'], consumer, 2);
const { startDemoServer } = await import(pathToFileURL(join(consumer, 'example/server.mjs')).href);
const server = await startDemoServer();
try {
  const config = JSON.parse(await readFile(join(consumer, 'example/fontwitness.config.json'), 'utf8'));
  for (const [mode, expected] of [['correct', 0], ['broken', 1], ['fixed', 0], ['mixed', 3], ['svg-mixed', 3], ['svg-prefixed', 3]]) {
    config.page.url = `${server.origin}/${mode}`;
    const file = join(consumer, `${mode}.json`); await writeFile(file, JSON.stringify(config));
    const result = await runAsync(binary, ['audit', '--config', file, '--out', `./audit-${mode}`, '--json', '--no-open'], consumer, expected);
    assert.equal(JSON.parse(result.stdout).summary.exitCode, expected); assert.ok(!result.stdout.includes('\u001b'));
  }
  const inspect = JSON.parse((await runAsync(binary, ['inspect', `${server.origin}/broken`, '--selector', '[data-font-check]', '--out', './inspect', '--json'], consumer)).stdout); assert.ok(!('contractVerdict' in inspect.summary));
  run(binary, ['compare', './audit-broken/capture.json', './audit-fixed/capture.json', '--out', './compare-change', '--json'], consumer, 1);
  run(binary, ['compare', './audit-correct/capture.json', './audit-fixed/capture.json', '--out', './compare-equal', '--json'], consumer);
  const cross = JSON.parse(run(binary, ['compare', './audit-broken/capture.json', './audit-fixed/capture.json', '--cross-env', '--out', './compare-cross', '--json'], consumer).stdout); assert.equal(cross.contractVerdict, null); assert.equal(cross.summary.exitCode, 0);
  await writeFile(join(consumer, 'invalid.json'), '{}'); assert.equal(JSON.parse(run(binary, ['audit', '--config', 'invalid.json', '--out', './invalid', '--json'], consumer, 2).stdout).exitCode, 2);
  config.page.url = `${server.origin}/deadline`; await writeFile(join(consumer, 'interrupt.json'), JSON.stringify(config));
  const child = spawn(binary, ['audit', '--config', 'interrupt.json', '--out', './interrupt', '--json'], { cwd: consumer, env: environment, stdio: ['ignore','pipe','pipe'] });
  console.error('Consumer check: SIGINT cleanup and JSON');
  let output = ''; child.stdout.on('data', data => output += data);
  let timer; child.stderr.once('data', () => { timer = setTimeout(() => child.kill('SIGINT'), 150); });
  let deadline;
  const code = await new Promise((resolve, reject) => {
    deadline=setTimeout(()=>{child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy();reject(new Error(`SIGINT cleanup exceeded 40 seconds; stdout bytes=${output.length}`));},40000);
    child.once('exit',(code,signal)=>console.error(`SIGINT child exit: code=${code}, signal=${signal}, stdout bytes=${output.length}`));
    child.once('close',resolve);child.once('error',reject);
  }).finally(()=>{clearTimeout(timer);clearTimeout(deadline);});assert.equal(code,130);assert.equal(JSON.parse(output).summary.exitCode,130);
  // Offline UI is verified again using only the installed distribution's browser dependency.
  const browserModule = await import(pathToFileURL(join(consumer, 'node_modules/fontwitness/dist/browser.js')).href);
  console.error('Consumer check: installed offline HTML');
  const browser = await browserModule.chromium.launch({ chromiumSandbox: true });
  try { const context = await browser.newContext(); await context.setOffline(true); const page = await context.newPage(); await page.goto(pathToFileURL(join(consumer, 'demo/broken/report.html')).href); assert.equal(await page.locator('.finding').count(), 2); await page.getByLabel('Status', { exact: true }).selectOption('unexpected'); assert.equal(await page.locator('.finding:visible').count(), 2); }
  finally { await browser.close(); }
} finally { await server.close(); }
const checksum = createHash('sha256').update(await readFile(pack)).digest('hex');
const evidence = { package: pack.split('/').at(-1), sha256: checksum, node: process.version, platform: process.platform, arch: process.arch, consumer, acceptedExitCodes: [0, 1, 2, 3, 130], tests: 'Installed binary, real Chromium, demo/audit/compare/inspect, offline HTML, SIGINT', sourceCommit: process.env.GITHUB_SHA ?? null };
await writeFile('artifacts/package/consumer-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
