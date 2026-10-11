import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '../dist/browser.js';
import { startDemoServer } from '../examples/font-loading-site/server.mjs';

await mkdir('artifacts', { recursive: true }); await mkdir('docs/assets', { recursive: true });
const dir = await mkdtemp(resolve('artifacts/recording-'));
const server = await startDemoServer(); let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: dir, shell: false, stdio: ['ignore','pipe','pipe'] }); let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));
});
try {
  const config = JSON.parse(await readFile(new URL('../examples/font-loading-site/fontwitness.config.json',import.meta.url),'utf8'));config.page.url=server.origin+'/broken';config.artifacts={screenshots:'viewport',includeText:true};await writeFile(join(dir,'demo.json'),JSON.stringify(config,null,2));
  const terminal = join(dir,'terminal.html');await writeFile(terminal,'<!doctype html><html lang="en"><meta charset="utf-8"><title>FontWitness real CLI demo</title><style>body{margin:0;background:#202a2d;color:#f4f5f1;font:22px/1.8 monospace;padding:70px}h1{font:16px monospace;color:#9bbaad}pre{white-space:pre-wrap;overflow-wrap:anywhere}footer{font:14px monospace;color:#9bbaad;margin-top:60px}</style><h1>FontWitness / real CLI capture</h1><pre id="terminal"></pre><footer>Own synthetic fixture · actual command output · primary-font contract unchanged</footer></html>');
  browser=await chromium.launch({chromiumSandbox:true});const context=await browser.newContext({viewport:{width:1280,height:800},recordVideo:{dir:join(dir,'video'),size:{width:1280,height:800}}});const page=await context.newPage();
  await page.goto(server.origin+'/broken');await pause(3500);
  await page.goto(pathToFileURL(terminal).href);
  const args=['../../dist/cli.js','audit','--config','demo.json','--out','./broken','--no-open'];
  await page.locator('#terminal').evaluate((e,args)=>{e.textContent='$ node '+args.join(' ');},args);
  const broken=await command(args);assert.equal(broken.code,1);
  await page.locator('#terminal').evaluate((e,result)=>{e.textContent+='\n\n'+result.stderr.trim()+'\n'+result.stdout.split('\n')[0]+'\nExit code: '+result.code;},broken);await pause(1800);
  await page.goto(pathToFileURL(join(dir,'broken/report.html')).href);await page.locator('.finding summary').first().click();await page.locator('.evidence').first().scrollIntoViewIfNeeded();await pause(4200);
  await page.goto(pathToFileURL(terminal).href);await page.locator('#terminal').evaluate(e=>{e.textContent='// Restore the synthetic primary font endpoint\nserver.repairDelivery()';});server.repairDelivery();const status=(await fetch(server.origin+'/missing.ttf')).status;assert.equal(status,200);
  await page.locator('#terminal').evaluate((e,status)=>{e.textContent+='\nGET /missing.ttf → '+status+'\n\nContract: Alegreya Sans (unchanged)';},status);await pause(2000);
  const fixedArgs=['../../dist/cli.js','audit','--config','demo.json','--out','./fixed','--no-open'];const fixed=await command(fixedArgs);assert.equal(fixed.code,0);
  await page.locator('#terminal').evaluate((e,result)=>{e.textContent+='\n\n$ node '+result.args.join(' ')+'\n'+result.stdout.split('\n')[0]+'\nExit code: '+result.code;},{...fixed,args:fixedArgs});await pause(2000);
  await page.goto(pathToFileURL(join(dir,'fixed/report.html')).href);await pause(3800);
  const video=page.video();await context.close();const videoPath=await video.path();
  const result=spawnSync('ffmpeg',['-y','-i',videoPath,'-c:v','libx264','-preset','medium','-crf','25','-pix_fmt','yuv420p','-movflags','+faststart','-an',resolve('docs/assets/demo.mp4')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const a=JSON.parse(await readFile(join(dir,'broken/capture.json'),'utf8')),b=JSON.parse(await readFile(join(dir,'fixed/capture.json'),'utf8'));assert.equal(a.observations[0].requestedCSS.fontFamily,b.observations[0].requestedCSS.fontFamily);assert.notDeepEqual(a.observations[0].fonts,b.observations[0].fonts);
  await writeFile('docs/assets/demo-provenance.json',JSON.stringify({synthetic:true,commands:[args,fixedArgs],observedExitCodes:[broken.code,fixed.code],fontEndpointAfterRepair:status,playwright:a.environment.playwright,chromium:a.environment.browser,contractChanged:false},null,2)+'\n');
  const screenshotContext=await browser.newContext();const screenshots=await screenshotContext.newPage();
  for(const width of [1440,1024,390]){await screenshots.setViewportSize({width,height:960});await screenshots.goto(pathToFileURL(join(dir,'broken/report.html')).href);await screenshots.screenshot({path:`docs/assets/report-${width}.png`,fullPage:false});assert.ok(await screenshots.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await screenshots.goto(pathToFileURL(join(dir,'broken/report.html')).href);await screenshots.setViewportSize({width:1440,height:960});await screenshots.screenshot({path:'docs/assets/report-desktop.png',fullPage:false});await screenshotContext.close();
  console.log('Recorded real broken → restored font delivery → fixed audit, with exits 1 → 0.');
}finally{await browser?.close();await server.close();}
