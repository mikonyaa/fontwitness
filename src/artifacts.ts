import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import type { Report } from './model.js';
import { renderReport } from './report/render.js';
import { hash } from './util.js';

export async function newOutputDirectory(dir: string): Promise<string> {
  const destination = resolve(dir);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  return destination;
}
export async function writeReport(dir: string, report: Report, screenshot?: Buffer): Promise<void> {
  const html = renderReport(report, screenshot);
  if (html.length > 25 * 1024 * 1024) throw new Error('REPORT_SIZE_LIMIT');
  if (report.kind === 'capture') report.artifactManifest.push({ path: 'report.html', mediaType: 'text/html', bytes: Buffer.byteLength(html), sha256: hash(html), consistent: true });
  // The manifest lives in the JSON; an HTML cannot contain its own checksum.
  await writeFile(join(dir, 'report.html'), html, { flag: 'wx' });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (json.length > 25 * 1024 * 1024) throw new Error('REPORT_SIZE_LIMIT');
  await writeFile(join(dir, 'capture.json'), json, { flag: 'wx' });
}
