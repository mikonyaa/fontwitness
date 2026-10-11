import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '../dist/browser.js';

const root = resolve('site');
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith('/fontwitness/')) throw new Error('not allowlisted');
    const file = resolve(root, path.slice('/fontwitness/'.length) || 'index.html');
    if (!file.startsWith(root + '/')) throw new Error('outside root');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png', '.txt': 'text/plain' })[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/fontwitness/`;
let browser;
try {
  browser = await chromium.launch({ chromiumSandbox: true }); const page = await browser.newPage();
  const failures=[];page.on('pageerror',e=>failures.push(e.message));
  await page.goto(origin);assert.equal(await page.title(),'FontWitness · Chromium engine evidence');
  for(const width of [1440,1024,390]){await page.setViewportSize({width,height:960});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`artifacts/ui/site-${width}.png`,fullPage:false});}
  const links=await page.locator('a').evaluateAll(elements=>elements.map(e=>e.href).filter(v=>v.startsWith(location.origin)));
  for(const url of links){const response=await page.request.get(url);assert.equal(response.status(),200,url);}
  await page.getByRole('link',{name:'Open report',exact:true}).nth(1).click();assert.equal(await page.locator('h1').textContent(),'Unexpected');await page.getByLabel('Status',{exact:true}).selectOption('unexpected');assert.equal(await page.locator('.finding:visible').count(),2);assert.deepEqual(failures,[]);
  await writeFile('artifacts/site-evidence.json',JSON.stringify({subpath:'/fontwitness/',widths:[1440,1024,390],localLinks:links.length,reportInteraction:true,errors:failures},null,2));
  console.log('Static site verified at /fontwitness/, including nested report navigation, all local links, controls and responsive widths.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
