import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../dist/browser.js';
import { parseConfig } from '../../dist/config.js';
import { capturePage } from '../../dist/capture.js';
import { renderReport } from '../../dist/report/render.js';
import { startDemoServer } from '../../examples/font-loading-site/server.mjs';

test('real offline HTML: responsive, keyboard, filters, hostile strings, empty/error/partial', async () => {
  const server = await startDemoServer(); const temporary = await mkdtemp(join(tmpdir(), 'fontwitness-html-'));
  const artifactDir = 'artifacts/ui'; await mkdir(artifactDir, { recursive: true });
  let browser;
  try {
    const config = mode => parseConfig({ schemaVersion: 1, page: { id: 'synthetic', url: `${server.origin}/${mode}` }, artifacts: { includeText: true }, rules: [{ id: 'copy', selector: '[data-font-check]', keyAttribute: 'data-font-check', allowed: [{ familyName: 'Alegreya Sans' }], required: [{ familyName: 'Alegreya Sans' }] }] });
    const run = await capturePage(config('last')); assert.equal(run.summary.exitCode, 1);
    const hostile = '</script><script>globalThis.pwned=true</script><img src=x onerror="globalThis.pwned=true">\u2028&';
    run.target.pageId = hostile; run.capturedRules[0].rule.selector = hostile + ' [data-really-long="' + 'selector'.repeat(100) + '"]';
    run.observations[0].fonts[0].familyName = hostile + 'FontName'.repeat(100);
    run.diagnostics.push({ code: 'SYNTHETIC_HOSTILE_STRING', message: hostile });
    const states = [
      ['empty', await capturePage(config('empty'))],
      ['partial', await capturePage(config('mixed'))],
      ['error', await capturePage({ ...config('correct'), rules: [{ ...config('correct').rules[0], selector: '[' }] })]
    ];
    const file = join(temporary, 'report.html'); await writeFile(file, renderReport(run));
    await server.close();
    browser = await chromium.launch({ chromiumSandbox: true }); const context = await browser.newContext(); const page = await context.newPage();
    const external = []; page.on('request', req => { if (/^https?:/.test(req.url())) external.push(req.url()); });
    await context.setOffline(true); await page.goto(pathToFileURL(file).href);
    assert.equal(await page.evaluate(() => globalThis.pwned), undefined); assert.equal(await page.locator('.finding').count(), 3);
    await page.getByLabel('Status', { exact: true }).selectOption('unexpected'); assert.equal(await page.locator('.finding:visible').count(), 1);
    await page.getByRole('button', { name: 'Clear', exact: true }).click(); assert.equal(await page.locator('.finding:visible').count(), 3);
    await page.getByLabel('Search findings').fill('absent-search-query'); assert.equal(await page.locator('.finding:visible').count(), 0);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Search findings').fill('last'); assert.equal(await page.locator('.finding:visible').count(), 1);
    await page.getByRole('button', { name: 'Expand details' }).click(); assert.equal(await page.locator('.finding[open]:visible').count(), 1);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse details' }).click();
    await page.locator('.finding summary').first().focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('.finding').first().evaluate(e => e.open), true);
    const focus = await page.locator('.finding summary').first().evaluate(e => ({ outline: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth })); assert.equal(focus.outline, 'solid'); assert.equal(focus.width, '3px');
    await page.getByLabel('Search findings').focus(); await page.keyboard.press('Tab'); assert.equal(await page.locator('#status').evaluate(e => document.activeElement === e), true);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}`);
      await page.screenshot({ path: `${artifactDir}/report-${width}.png`, fullPage: true });
      const bounds = await page.locator('.controls button, .controls input, .controls select').evaluateAll(elements => elements.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.y, bottom: r.bottom }; }));
      assert.ok(bounds.every(b => b.x >= 0 && b.right <= width));
    }
    const colors = await page.evaluate(() => { const s=getComputedStyle(document.documentElement);return ['--ink','--paper','--pass','--fail','--unknown'].map(k=>s.getPropertyValue(k).trim()); });
    const luminance = hex => { const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722; };
    for (const text of [colors[0], ...colors.slice(2)]) { const a=luminance(text),b=luminance(colors[1]); assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5); }
    assert.deepEqual(external, []); assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    for (const [kind, state] of states) {
      const path = join(temporary, kind+'.html');await writeFile(path,renderReport(state));await page.goto(pathToFileURL(path).href);assert.equal(state.summary.exitCode,kind==='error'?2:3);assert.ok((await page.locator('h1').textContent()).includes('Unmeasured'));await page.screenshot({path:`${artifactDir}/${kind}-390.png`,fullPage:true});
    }
  } finally { await browser?.close(); await server.close(); }
});
