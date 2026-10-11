import { chromium } from '../dist/browser.js';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const font = await readFile(new URL('../fixtures/fonts/AlegreyaSans-Regular.ttf', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/primary.ttf') { res.setHeader('Content-Type', 'font/ttf'); res.end(font); return; }
  if (req.url === '/missing.ttf') { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>@font-face{font-family:WitnessAlias;src:url(${req.url === '/broken' ? '/missing.ttf' : '/primary.ttf'})}body{font-family:WitnessAlias,monospace}</style><div class="root" data-key="one">First <section><div><p><span>Four levels</span></p></div></section> sibling</div><div class="root" data-key="last">Last text</div><div id="empty"></div>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const results = [];
  for (const mode of ['fixed', 'broken']) {
    await page.goto(`${origin}/${mode}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { result } = await cdp.send('Runtime.evaluate', { expression: `(() => {const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const a=[];let n;while(n=w.nextNode())if(n.textContent.trim())a.push(n);return a})()`, objectGroup: 'feasibility' });
    const { result: props } = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    const observations = [];
    for (const prop of props.filter(p => /^\d+$/.test(p.name))) {
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: prop.value.objectId });
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.length, 'Real TextNode font evidence');
      observations.push({ text: node.nodeValue, fonts });
    }
    const doc = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.root' });
    const container = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const { nodeId: emptyId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#empty' });
    const empty = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: emptyId });
    assert.equal(empty.fonts.length, 0);
    assert.equal(observations.length, 4);
    assert.equal(await page.locator('.root').count(), 2);
    results.push({ mode, computed: await page.locator('.root').first().evaluate(el => getComputedStyle(el).fontFamily), observations, container, empty });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'feasibility' });
  }
  assert.equal(results[0].computed, results[1].computed);
  assert.ok(results[0].observations.every(o => o.fonts.some(f => f.familyName === 'Alegreya Sans' && f.isCustomFont)));
  assert.ok(results[1].observations.every(o => o.fonts.every(f => f.familyName !== 'Alegreya Sans')));
  const evidence = { playwright: '1.64.0', chromium: browser.version(), platform: process.platform, arch: process.arch, results };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/feasibility.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
