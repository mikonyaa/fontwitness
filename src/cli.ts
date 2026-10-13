#!/usr/bin/env node
import { Command } from 'commander';
import { ZodError } from 'zod';
import { stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { installBrowser } from './browser.js';
import { runDoctor } from './doctor.js';
import { parseConfig, loadConfig } from './config.js';
import { capturePage } from './capture.js';
import { compareRuns } from './compare.js';
import { TOOL_VERSION, PLAYWRIGHT_VERSION } from './model.js';
import { loadCapture, CaptureInputError } from './capture-input.js';
import { newOutputDirectory, writeReport } from './artifacts.js';
import { runDemo, initExample } from './demo.js';

const program = new Command().name('fontwitness').version(TOOL_VERSION).description('See the fonts Chromium actually renders and enforce typography contracts in CI.').configureOutput({ outputError: str => process.stderr.write(str) }).exitOverride();
const controller = new AbortController();
const interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
let jsonRequested = process.argv.includes('--json');
function emit(value: unknown, text: string, code = 0): void {
  if (controller.signal.aborted && code !== 130) {
    code = 130; text = 'Operation interrupted.'; value = { error: { code: 'INTERRUPTED', message: text }, exitCode: code };
  }
  process.stdout.write(jsonRequested ? JSON.stringify(value) + '\n' : text + '\n'); process.exitCode = code;
}
function reportOptions(command: Command): Command { return command.requiredOption('--out <directory>', 'New output directory (must not already exist)').option('--json', 'Print exactly one JSON document').option('--no-open', 'Explicitly keep the report unopened (default)'); }
async function capture(mode: 'inspect' | 'audit', config: ReturnType<typeof parseConfig>, dir: string, configDir?: string) {
  const out = await newOutputDirectory(dir); let image: Buffer | undefined;
  process.stderr.write(`Capturing Chromium ${mode}…\n`);
  const run = await capturePage(config, { mode, configDir, signal: controller.signal, screenshot: async bytes => { image = bytes; await writeFile(join(out, 'viewport.png'), bytes, { flag: 'wx' }); } });
  await writeReport(out, run, image);
  emit(run, `FontWitness ${mode}: ${run.summary.contractVerdict ?? run.coverage.status} · coverage ${run.coverage.status} · exit ${run.summary.exitCode}\nReport: ${join(out, 'report.html')}`, run.summary.exitCode);
}
program.command('doctor').description('Check Node, pinned Chromium, and real TextNode CDP measurement').option('--json').action(async () => {
  const report = await runDoctor(controller.signal);
  emit(report, `Doctor: ${report.code} · ${report.action}`, report.exitCode);
});
program.command('install-browser').description(`Install Chromium using the bundled Playwright ${PLAYWRIGHT_VERSION} installer`).option('--json').action(async () => { await installBrowser(jsonRequested); emit({ installed: true, playwright: PLAYWRIGHT_VERSION }, `Chromium installed for Playwright ${PLAYWRIGHT_VERSION}.`); });
program.command('init').description('Create a standalone synthetic example without overwriting files').requiredOption('--dir <directory>').option('--json').action(async options => { const dir = resolve(options.dir); await initExample(dir); emit({ directory: dir }, `Example created: ${dir}\nRun node ${join(dir, 'server.mjs')}`); });
reportOptions(program.command('inspect').description('Capture actual fonts without a contract verdict').argument('<URL>').requiredOption('--selector <CSS>', 'CSS selector (repeat for multiple)', (value: string, previous: string[]) => [...previous, value], []).action(async (url, options) => { const config = parseConfig({ schemaVersion: 1, page: { id: 'inspect', url }, rules: options.selector.map((selector: string, i: number) => ({ id: `selection-${i + 1}`, selector })) }, 'inspect'); await capture('inspect', config, options.out); }));
reportOptions(program.command('audit').description('Capture and evaluate every matched element').requiredOption('--config <file>').action(async options => { const config = await loadConfig(options.config); await capture('audit', config, options.out, dirname(resolve(options.config))); }));
reportOptions(program.command('compare').description('Compare stable keys in two saved captures').argument('<before>').argument('<after>').option('--cross-env', 'Descriptive comparison allowing environment differences').action(async (before, after, options) => {
  const a = await loadCapture(before), b = await loadCapture(after); const comparison = compareRuns(a, b, options.crossEnv); const out = await newOutputDirectory(options.out); await writeReport(out, comparison); emit(comparison, `Comparison: ${comparison.summary.changed} font changes · ${comparison.summary.partial ? 'partial' : 'complete'} · exit ${comparison.summary.exitCode}\nReport: ${join(out, 'report.html')}`, comparison.summary.exitCode);
}));
reportOptions(program.command('demo').description('Run real correct, broken, fixed, and allowed-fallback browser checks').action(async options => { const out = await newOutputDirectory(options.out); process.stderr.write('Running synthetic Chromium demo…\n'); const result = await runDemo(out, controller.signal); emit(result, `Demo self-test: ${result.selfTest ? 'passed' : 'failed'}\nCorrect ${result.runs.correct?.exitCode} · Broken ${result.runs.broken?.exitCode} · Fixed ${result.runs.fixed?.exitCode} · Allowed fallback ${result.runs.fallback?.exitCode}\nReports: ${out}`, result.exitCode); }));
program.command('open').description('Explicitly open an existing local report with the OS viewer').argument('<report.html>').action(async path => { await stat(path); const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'; const child = spawn(command, [resolve(path)], { shell: false, stdio: 'ignore' }); await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('OPEN_FAILED'))); }); });
try { await program.parseAsync(); }
catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (!['commander.helpDisplayed', 'commander.version'].includes(code)) {
    jsonRequested ||= process.argv.includes('--json');
    const issues = error instanceof CaptureInputError ? error.issues : error instanceof ZodError ? error.issues.map(i => ({ path: i.path.join('.'), code: i.code, message: i.message })) : undefined;
    const message = error instanceof CaptureInputError ? error.message : issues ? 'Configuration validation failed.' : code === 'EEXIST' ? 'Output directory already exists. Choose a new directory; existing files were preserved.' : error instanceof Error && error.message.startsWith('Every audit rule') ? error.message : 'Invalid input or execution failed. Check paths, permissions, and --help.';
    const reasonCode = error instanceof CaptureInputError ? error.code : issues ? 'INVALID_CONFIG' : code === 'EEXIST' ? 'OUTPUT_EXISTS' : code.startsWith('commander.') ? 'CLI_ARGUMENT_ERROR' : 'CONFIG_OR_EXECUTION_ERROR';
    emit({ error: { code: reasonCode, message, ...(issues ? { issues } : {}) }, exitCode: controller.signal.aborted ? 130 : 2 }, message + (issues ? '\n' + issues.map(i => `${i.path || 'config'}: ${i.message}`).join('\n') : ''), controller.signal.aborted ? 130 : 2);
  }
} finally { process.removeListener('SIGINT', interrupt); }
