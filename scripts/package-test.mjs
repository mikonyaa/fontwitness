import assert from 'node:assert/strict';
import { spawnSync, spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
const installed = join(consumer, 'node_modules/fontwitness');
assert.equal((await lstat(installed)).isSymbolicLink(), false, 'Consumer must use packed bytes, not workspace links');
assert.equal(run(binary, ['--version'], consumer).stdout.trim(), '0.1.1');
assert.ok(run(binary, ['--help'], consumer).stdout.includes('inspect'));
assert.equal(JSON.parse(run(binary, ['install-browser', '--json'], consumer).stdout).installed, true);
assert.equal(JSON.parse(run(binary, ['doctor', '--json'], consumer).stdout).ok, true);
const demo = JSON.parse(run(binary, ['demo', '--out', './demo', '--json', '--no-open'], consumer).stdout);
assert.equal(demo.selfTest, true); assert.equal(demo.runs.broken.exitCode, 1); assert.equal(demo.runs.fallback.exitCode, 0);
run(binary, ['init', '--dir', './example', '--json'], consumer);
const initializedConfig = await readFile(join(consumer, 'example/fontwitness.config.json'), 'utf8');
run(binary, ['init', '--dir', './example', '--json'], consumer, 2);
assert.equal(await readFile(join(consumer, 'example/fontwitness.config.json'), 'utf8'), initializedConfig);
const publicApi = await import(pathToFileURL(join(installed, 'dist/index.js')).href);
const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
const validateConfig = ajv.compile(JSON.parse(await readFile(join(installed, 'schemas/config-v1.schema.json'), 'utf8')));
assert.equal(validateConfig(JSON.parse(initializedConfig)), true, JSON.stringify(validateConfig.errors));
assert.ok(publicApi.parseConfig(JSON.parse(initializedConfig)));
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

// A separate consumer-owned static page changes delivery at the same URL without changing its contract.
const primaryBytes = await readFile(join(installed, 'fixtures/fonts/AlegreyaSans-Regular.ttf'));
await mkdir(join(consumer, 'own-site'));
await writeFile(join(consumer, 'own-site/primary.ttf'), primaryBytes);
await writeFile(join(consumer, 'own-site/OFL.txt'), await readFile(join(installed, 'fixtures/fonts/alegreyasans-OFL.txt')));
const staticHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Consumer font delivery</title><style>@font-face{font-family:ConsumerAlias;src:url(/fonts/primary.ttf)}body{font:24px ConsumerAlias,monospace}</style></head><body><h1 data-evidence="title">Consumer typography</h1><p data-evidence="copy">Delivery changes; the contract stays fixed.</p></body></html>';
await writeFile(join(consumer, 'own-site/index.html'), staticHtml);
let delivery = true;
const requests = [];
const ownServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fonts/primary.ttf') { const status = delivery ? 200 : 404; requests.push({ path: url.pathname, status }); res.writeHead(status, { 'Content-Type': delivery ? 'font/ttf' : 'text/plain', 'Cache-Control': 'no-store' }); res.end(delivery ? primaryBytes : 'Missing font'); }
  else if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(staticHtml); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => ownServer.listen(0, '127.0.0.1', resolve));
const ownConfig = { schemaVersion: 1, page: { id: 'consumer-owned', url: `http://127.0.0.1:${ownServer.address().port}/` }, rules: [{ id: 'copy', selector: '[data-evidence]', keyAttribute: 'data-evidence', allowed: [{ familyName: 'Alegreya Sans', isCustomFont: true }], required: [{ familyName: 'Alegreya Sans' }] }] };
const ownConfigFile = join(consumer, 'own-config.json'); await writeFile(ownConfigFile, JSON.stringify(ownConfig));
const contractHash = createHash('sha256').update(await readFile(ownConfigFile)).digest('hex');
const ownRuns = {};
try {
  for (const [name, available, expected] of [['correct', true, 0], ['broken', false, 1], ['restored', true, 0]]) {
    delivery = available;
    const captured = JSON.parse((await runAsync(binary, ['audit', '--config', ownConfigFile, '--out', `./own-${name}`, '--json', '--no-open'], consumer, expected)).stdout);
    assert.equal(captured.environment.browser, '156.0.8078.4'); assert.equal(captured.coverage.status, 'complete');
    assert.equal(captured.summary.exitCode, expected); publicApi.parseCapture(captured);
    const fonts = [...new Set(captured.observations.flatMap(o => o.fonts.map(f => f.familyName)))];
    assert.equal(fonts.includes('Alegreya Sans'), available);
    if (!available) assert.ok(captured.networkEvidence.some(r => r.status === 404));
    const html = await readFile(join(consumer, `own-${name}/report.html`), 'utf8');
    assert.ok(html.includes('Content-Security-Policy')); assert.ok(html.includes('SIL OPEN FONT LICENSE'));
    const json = JSON.parse(await readFile(join(consumer, `own-${name}/capture.json`), 'utf8')); assert.equal(json.summary.exitCode, expected); publicApi.parseCapture(json);
    ownRuns[name] = { exitCode: captured.summary.exitCode, fonts, captureId: captured.captureId };
    assert.equal(createHash('sha256').update(await readFile(ownConfigFile)).digest('hex'), contractHash);
  }
  run(binary, ['compare', './own-correct/capture.json', './own-restored/capture.json', '--out', './own-equal', '--json'], consumer);
  run(binary, ['compare', './own-broken/capture.json', './own-restored/capture.json', '--out', './own-change', '--json'], consumer, 1);
  run(binary, ['audit', '--config', ownConfigFile, '--out', './own-correct', '--json'], consumer, 2);
  const damaged = JSON.parse(await readFile(join(consumer, 'own-correct/capture.json'), 'utf8')); damaged.observations = [];
  assert.throws(() => publicApi.compareRuns(damaged, damaged), { code: 'INVALID_CAPTURE' });
  // Exercise exactly the same malformed/comparability cases through the installed binary.
  run(process.execPath, [resolve('scripts/malformed-capture-test.mjs'), join(installed, 'dist/cli.js'), join(consumer, 'own-correct/capture.json'), join(consumer, 'own-broken/capture.json')], process.cwd());
} finally { ownServer.closeAllConnections(); await new Promise(resolve => ownServer.close(resolve)); }
await writeFile(join(consumer, 'own-site/evidence.json'), JSON.stringify({ ownRuns, contractHash, requests }, null, 2) + '\n');
const checksum = createHash('sha256').update(await readFile(pack)).digest('hex');
const evidence = { package: pack.split('/').at(-1), sha256: checksum, node: process.version, platform: process.platform, arch: process.arch, consumer, acceptedExitCodes: [0, 1, 2, 3, 130], tests: 'Installed binary, real Chromium, demo/audit/compare/inspect, offline HTML, SIGINT, input schema, malformed captures, consumer-owned static font delivery/recovery', ownRuns, contractHash, sourceCommit: process.env.GITHUB_SHA ?? null };
await writeFile('artifacts/package/consumer-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
