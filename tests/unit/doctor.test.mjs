import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, classifyDoctorFailure, doctorVersionsMatch } from '../../dist/doctor.js';
import { chromium } from '../../dist/browser.js';
import { CHROMIUM_VERSION, PLAYWRIGHT_VERSION } from '../../dist/model.js';

function mockBrowser(t, { launchError, cdpError, empty, version = CHROMIUM_VERSION, controller } = {}) {
  let killed = 0, closed = 0, launched = 0;
  t.mock.method(chromium, 'executablePath', () => process.execPath);
  t.mock.method(chromium, 'launchServer', async options => {
    launched++; assert.equal(options.chromiumSandbox, true); assert.equal(options.handleSIGINT, false); assert.equal(options.host, '127.0.0.1');
    if (launchError) throw launchError;
    return { wsEndpoint: () => 'ws://127.0.0.1/owned-test', close: async () => closed++, kill: async () => killed++ };
  });
  t.mock.method(chromium, 'connect', async () => ({
    version: () => version, close: async () => {}, newContext: async () => ({
      newPage: async () => ({ setContent: async () => {} }),
      newCDPSession: async () => ({ send: async method => {
        if (cdpError) throw cdpError;
        if (method === 'Runtime.evaluate') return { result: { objectId: 'text' } };
        if (method === 'DOM.requestNode') return { nodeId: 7 };
        if (method === 'DOM.describeNode') return { node: { nodeType: 3 } };
        if (method === 'CSS.getPlatformFontsForNode') { controller?.abort(); return { fonts: empty ? [] : [{ familyName: 'Primary', postScriptName: 'Primary-Regular', isCustomFont: true, glyphCount: 23 }] }; }
        return {};
      } })
    })
  }));
  return () => ({ killed, closed, launched });
}
test('doctor accepts only Node 24 and the exact browser/Playwright pair', () => {
  assert.equal(doctorVersionsMatch('v24.21.0', PLAYWRIGHT_VERSION, CHROMIUM_VERSION), true);
  for (const args of [['v26.9.0', PLAYWRIGHT_VERSION], ['v24.21.0', '1.63.0'], ['v24.21.0', PLAYWRIGHT_VERSION, '155.0']]) assert.equal(doctorVersionsMatch(...args), false);
});
test('missing browser has install action and never attempts launch', async t => {
  const state = mockBrowser(t); t.mock.method(chromium, 'executablePath', () => '/nonexistent/fontwitness-owned-test-browser');
  const report = await runDoctor(); assert.equal(report.code, 'BROWSER_MISSING'); assert.equal(report.exitCode, 2);
  assert.match(report.action, /install-browser/); assert.equal(state().launched, 0);
});
test('installed browser with sandbox/permission failure is denied, without raw logs or reinstall advice', async t => {
  mockBrowser(t, { launchError: new Error('sandbox: Operation not permitted /private/secret?token=secret-token') });
  const report = await runDoctor(); assert.equal(report.code, 'BROWSER_LAUNCH_DENIED'); assert.equal(report.exitCode, 2);
  assert.doesNotMatch(report.action, /install-browser/); assert.match(report.action, /keep the sandbox enabled/);
  assert.doesNotMatch(JSON.stringify(report), /secret-token|\/private\/secret/);
});
test('other installed-browser launch errors have OS support action', async t => {
  mockBrowser(t, { launchError: new Error('missing shared library') });
  const report = await runDoctor(); assert.equal(report.code, 'BROWSER_LAUNCH_FAILED'); assert.match(report.action, /OS libraries/);
});
test('launched mismatched Chromium returns version reason and closes its owned server', async t => {
  const state = mockBrowser(t, { version: '155.0.0.0' });
  const report = await runDoctor(); assert.equal(report.code, 'VERSION_MISMATCH'); assert.equal(report.chromium, '155.0.0.0'); assert.equal(state().closed, 1);
});
for (const [name, options] of [['CDP failure', { cdpError: new Error('CDP token=secret') }], ['empty font observation', { empty: true }]]) test(`doctor distinguishes ${name} from missing browser`, async t => {
  const state = mockBrowser(t, options); const report = await runDoctor();
  assert.equal(report.code, 'CDP_MEASUREMENT_FAILED'); assert.equal(report.exitCode, 2); assert.equal(state().closed, 1);
  assert.doesNotMatch(JSON.stringify(report), /token=secret/);
});
test('successful doctor reports raw CDP glyph counts and closes only its owned browser', async t => {
  const state = mockBrowser(t); const report = await runDoctor();
  assert.equal(report.ok, true); assert.equal(report.code, 'READY'); assert.equal(report.exitCode, 0);
  assert.equal(report.fonts[0].glyphCount, 23); assert.equal(report.mechanism, 'CSS.getPlatformFontsForNode'); assert.equal(state().closed, 1);
});
test('interruption takes priority, retains exit 130, and kills the owned server', async t => {
  const controller = new AbortController(); const state = mockBrowser(t, { controller }); const report = await runDoctor(controller.signal);
  assert.equal(report.code, 'INTERRUPTED'); assert.equal(report.exitCode, 130); assert.equal(report.ok, false); assert.equal(state().killed, 1);
});
test('pre-aborted doctor does not launch and safe failure classification preserves interruption', async t => {
  const state = mockBrowser(t); const controller = new AbortController(); controller.abort();
  assert.equal((await runDoctor(controller.signal)).exitCode, 130); assert.equal(state().launched, 0);
  assert.equal(classifyDoctorFailure(new Error('sandbox error'), 'measurement'), 'CDP_MEASUREMENT_FAILED');
  assert.equal(classifyDoctorFailure(new Error('sandbox error'), 'launch', true), 'INTERRUPTED');
});
