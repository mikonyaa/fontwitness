import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export async function startDemoServer(options = {}) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const fontDir = options.fontDir ?? await readFile(join(dir, 'fonts/AlegreyaSans-Regular.ttf')).then(() => join(dir, 'fonts')).catch(() => join(dir, '../../fixtures/fonts'));
  const primary = await readFile(join(fontDir, 'AlegreyaSans-Regular.ttf'));
  const japanese = await readFile(join(fontDir, 'NotoSansCJKjp-Regular.otf'));
  const timers = new Set();
  let brokenDeliveryRestored = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/missing.ttf' && !brokenDeliveryRestored) { res.writeHead(404); res.end('Synthetic missing font'); return; }
    if ((url.pathname.endsWith('.ttf') || url.pathname.endsWith('.otf'))) {
      const send = () => { if (!res.destroyed) { res.setHeader('Content-Type', url.pathname.endsWith('.otf') ? 'font/otf' : 'font/ttf'); res.end(url.pathname === '/japanese.otf' ? japanese : primary); } };
      if (url.pathname === '/late.ttf' || url.pathname === '/deadline.ttf') { const timer = setTimeout(() => { timers.delete(timer); send(); }, url.pathname === '/late.ttf' ? 450 : 3000); timers.add(timer); } else send();
      return;
    }
    const mode = url.pathname.slice(1) || 'correct';
    const source = mode === 'broken' ? '/missing.ttf' : mode === 'late' ? '/late.ttf' : mode === 'deadline' ? '/deadline.ttf' : '/primary.ttf';
    let content = '<h1 data-font-check="heading">Font delivery is part of your UI.</h1><p data-font-check="body">The CSS request stays the same. The rendered font can change.</p>';
    let extra = '';
    if (mode === 'fallback') content = '<h1 data-font-check="heading" class="multilingual">Hello 日本語</h1>';
    if (mode === 'nested') content = '<div data-font-check="one">First <section><div><p><span data-nested="deep">Four levels</span></p></div></section> sibling</div><div data-font-check="last">Last text</div>';
    if (mode === 'last') content = '<p data-font-check="first">First text</p><p data-font-check="second">Second text</p><p data-font-check="last" style="font-family:monospace">Last defect</p>';
    if (mode === 'mixed') content = '<p data-font-check="mixed">Visible <span style="display:none">Hidden text</span></p>';
    if (mode === 'hidden') content = '<p data-font-check="hidden" style="display:none">Hidden text</p>';
    if (mode === 'empty') content = '<p data-font-check="empty"></p>';
    if (mode === 'unsupported') content = '<div data-font-check="unsupported">Visible text <canvas>Canvas alternative</canvas><input value="Outside light DOM"><svg><text>Outside policy</text></svg><x-test></x-test></div>';
    if (mode === 'aliases') content = '<p data-font-check="a">First alias</p><p data-font-check="b" style="font-family:SecondAlias,monospace">Second alias</p>';
    if (mode === 'bytes') extra = `<script>const f=new FontFace('WitnessAlias',new Uint8Array([${[...primary].join(',')}]).buffer);f.load().then(font=>document.fonts.add(font));</script>`;
    if (mode === 'unstable') extra = '<script>setInterval(()=>{document.querySelector("[data-font-check]").textContent=String(Date.now())},30)</script>';
    if (mode === 'unsupported') extra = '<script>document.querySelector("x-test").attachShadow({mode:"open"}).innerHTML="Shadow text"</script>';
    if (mode === 'lazy') extra = '<div style="height:1600px"></div><script>addEventListener("scroll",()=>{document.querySelector("[data-font-check]").textContent="Changed after scroll"})</script>';
    if (mode === 'hostile') content = '<p data-font-check="hostile">&lt;/script&gt;&lt;script&gt;globalThis.pwned=true&lt;/script&gt;</p>';
    const bytesFace = mode === 'bytes' ? '' : `@font-face{font-family:WitnessAlias;src:url(${source});font-display:swap}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FontWitness · font delivery fixture</title><style>${bytesFace}@font-face{font-family:SecondAlias;src:url(/primary.ttf)}@font-face{font-family:JapaneseAlias;src:url(/japanese.otf)}*{box-sizing:border-box}body{margin:0;background:#f4f5f1;color:#202a2d;font-family:WitnessAlias,monospace}header{padding:24px;border-bottom:1px solid #ccd3cf;font:14px monospace}main{max-width:1040px;margin:80px auto;padding:0 24px}h1{font-size:64px;line-height:1.1;font-weight:400;max-width:900px}p{font-size:27px;line-height:1.5;max-width:800px}.multilingual{font-family:WitnessAlias,JapaneseAlias,monospace}nav{margin-top:60px;display:flex;gap:24px;flex-wrap:wrap}a{color:#185c50;font:14px monospace}footer{font:12px monospace;color:#526166;margin-top:60px}section,div,p,span{font-weight:400}@media(max-width:700px){main{margin:44px auto}h1{font-size:42px}p{font-size:23px}}</style><header>FontWitness / real browser fixture</header><main data-app-ready>${content}<nav><a href="/correct">Correct delivery</a><a href="/broken">Broken URL</a><a href="/fixed">Fixed delivery</a><a href="/fallback">Allowed language fallback</a></nav><footer>Own synthetic content · Alegreya Sans & Noto Sans CJK JP · SIL OFL 1.1</footer></main>${extra}</html>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, repairDelivery: () => { brokenDeliveryRestored = true; }, close: async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startDemoServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Synthetic font site: ${server.origin}`);
  const close = async () => { await server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
