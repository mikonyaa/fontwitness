import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './config.js';
import { capturePage } from './capture.js';
import { compareRuns } from './compare.js';
import { writeReport } from './artifacts.js';

interface DemoServer { origin: string; close(): Promise<void>; }
const template = new URL('../examples/font-loading-site/', import.meta.url);
export async function runDemo(dir: string, signal?: AbortSignal): Promise<{ exitCode: number; selfTest: boolean; runs: Record<string, { exitCode: number; actualFonts: string[] }>; comparisonExitCode: number; }> {
  const module: { startDemoServer(): Promise<DemoServer> } = await import(new URL('server.mjs', template).href);
  const server = await module.startDemoServer();
  const configValue = JSON.parse(await readFile(new URL('fontwitness.config.json', template), 'utf8'));
  const runs: Record<string, { exitCode: number; actualFonts: string[] }> = {};
  let broken, fixed;
  try {
    for (const mode of ['correct', 'broken', 'fixed', 'fallback']) {
      if (signal?.aborted) return { exitCode: 130, selfTest: false, runs, comparisonExitCode: 3 };
      const config = parseConfig({ ...configValue, page: { ...configValue.page, url: `${server.origin}/${mode}` }, artifacts: { screenshots: 'viewport', includeText: true }, rules: mode === 'fallback' ? [{ ...configValue.rules[0], allowed: [{ familyName: 'Alegreya Sans', isCustomFont: true }, { familyName: 'Noto Sans CJK JP', isCustomFont: true }], required: [{ familyName: 'Alegreya Sans' }, { familyName: 'Noto Sans CJK JP' }] }] : configValue.rules });
      const runDir = join(dir, mode); await mkdir(runDir);
      let image: Buffer | undefined;
      const run = await capturePage(config, { signal, screenshot: async bytes => { image = bytes; await writeFile(join(runDir, 'viewport.png'), bytes, { flag: 'wx' }); } });
      await writeReport(runDir, run, image);
      runs[mode] = { exitCode: run.summary.exitCode, actualFonts: [...new Set(run.observations.flatMap(o => o.fonts.map(f => f.familyName)))] };
      if (mode === 'broken') broken = run; if (mode === 'fixed') fixed = run;
    }
    const comparison = compareRuns(broken!, fixed!); const compareDir = join(dir, 'comparison'); await mkdir(compareDir); await writeReport(compareDir, comparison);
    const expected = runs.correct.exitCode === 0 && runs.broken.exitCode === 1 && runs.fixed.exitCode === 0 && runs.fallback.exitCode === 0 && comparison.summary.exitCode === 1;
    const summary = { exitCode: expected ? 0 : 2, selfTest: expected, runs, comparisonExitCode: comparison.summary.exitCode };
    await writeFile(join(dir, 'demo.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    return summary;
  } finally { await server.close(); }
}
export async function initExample(dir: string): Promise<void> {
  await mkdir(dir); await mkdir(join(dir, 'fonts'));
  for (const name of ['server.mjs', 'fontwitness.config.json']) await copyFile(fileURLToPath(new URL(name, template)), join(dir, name));
  for (const name of ['AlegreyaSans-Regular.ttf', 'NotoSansCJKjp-Regular.otf', 'alegreyasans-OFL.txt', 'notosansjp-OFL.txt', 'manifest.json']) await copyFile(fileURLToPath(new URL(`../fixtures/fonts/${name}`, import.meta.url)), join(dir, 'fonts', name));
  await writeFile(join(dir, 'README.md'), '# FontWitness example\n\nRun `node server.mjs` in this directory. In another terminal run `fontwitness audit --config fontwitness.config.json --out ./correct`. Change the config page URL to `http://127.0.0.1:3000/broken` and run with a new output directory to see a real font mismatch. Restore `/fixed` to fix delivery.\n', { flag: 'wx' });
}
