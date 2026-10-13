import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReport } from '../../dist/report/render.js';
import { writeReport } from '../../dist/artifacts.js';

test('offline artifact ceiling counts UTF-8 bytes, including CJK, before writing oversized HTML', async () => {
  const font = JSON.stringify(['中'.repeat(4000), 'Synthetic-Regular', true]);
  const report = { schemaVersion: 1, kind: 'comparison', toolVersion: '0.1.1', recordedAt: '2026-10-13T00:00:00.000Z', mode: 'strict', contractVerdict: null, before: 'synthetic-size-before', after: 'synthetic-size-after', environmentDifferences: [], diagnostics: [], changes: Array.from({ length: 1000 }, (_, i) => ({ ruleId: 'synthetic-size', key: String(i), before: [font], after: [font], changed: false })), summary: { exitCode: 0, partial: false, changed: 0 } };
  const html = renderReport(report);
  assert.ok(html.length < 25 * 1024 * 1024);
  assert.ok(Buffer.byteLength(html) > 25 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), 'fontwitness-byte-limit-'));
  await assert.rejects(writeReport(directory, report), { message: 'REPORT_SIZE_LIMIT' });
  await assert.rejects(access(join(directory, 'report.html')));
});
