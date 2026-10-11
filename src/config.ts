import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';

const string = z.string().min(1).max(4096);
export const matcherSchema = z.strictObject({
  familyName: string.optional(), postScriptName: string.optional(), isCustomFont: z.boolean().optional()
}).refine(v => Object.keys(v).length > 0, 'A font matcher must specify at least one field');
export const ruleSchema = z.strictObject({
  id: string, selector: string, match: z.literal('all').default('all'),
  scope: z.enum(['direct', 'subtree']).default('subtree'),
  minMatches: z.number().int().min(1).max(2000).default(1),
  keyAttribute: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/).max(200).optional(),
  allowed: z.array(matcherSchema).min(1).max(100).optional(),
  required: z.array(matcherSchema).max(100).default([])
});
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  page: z.strictObject({ id: string, url: z.url().max(8192).refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'Only HTTP(S) pages are supported'), readySelector: string.optional() }),
  browser: z.strictObject({ headless: z.boolean().default(true), viewport: z.strictObject({ width: z.number().int().min(320).max(3840), height: z.number().int().min(200).max(2160) }).default({ width: 1280, height: 800 }), deviceScaleFactor: z.number().min(0.5).max(3).default(1), locale: z.string().min(2).max(100).default('en-US') }).default({ headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US' }),
  readiness: z.strictObject({ navigationTimeoutMs: z.number().int().min(100).max(120000).default(30000), fontTimeoutMs: z.number().int().min(50).max(120000).default(10000), stableWindowMs: z.number().int().min(20).max(5000).default(200), maxAttempts: z.number().int().min(1).max(5).default(3), totalTimeoutMs: z.number().int().min(100).max(300000).default(90000) }).default({ navigationTimeoutMs: 30000, fontTimeoutMs: 10000, stableWindowMs: 200, maxAttempts: 3, totalTimeoutMs: 90000 }),
  limits: z.strictObject({ maxTextNodes: z.number().int().min(1).max(10000).default(2000), maxMatchesPerRule: z.number().int().min(1).max(2000).default(200), maxTextLength: z.number().int().min(16).max(65536).default(16384) }).default({ maxTextNodes: 2000, maxMatchesPerRule: 200, maxTextLength: 16384 }),
  artifacts: z.strictObject({ screenshots: z.enum(['none', 'viewport']).default('none'), includeText: z.boolean().default(false) }).default({ screenshots: 'none', includeText: false }),
  preparation: z.strictObject({ hook: string.refine(v => !/^[a-z][a-z0-9+.-]*:/i.test(v), 'Hook must be an explicit local file'), timeoutMs: z.number().int().min(100).max(60000).default(10000) }).optional(),
  rules: z.array(ruleSchema).min(1).max(100)
}).refine(v => new Set(v.rules.map(r => r.id)).size === v.rules.length, 'Rule IDs must be unique');
export type Config = z.infer<typeof configSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type FontMatcher = z.infer<typeof matcherSchema>;
export function parseConfig(value: unknown, mode: 'audit' | 'inspect' = 'audit'): Config {
  const config = configSchema.parse(value);
  if (mode === 'audit' && config.rules.some(r => !r.allowed)) throw new Error('Every audit rule needs an exhaustive allowed array');
  return config;
}
export async function loadConfig(file: string): Promise<Config> {
  if ((await stat(file)).size > 1024 * 1024) throw new Error('Config exceeds 1 MiB');
  return parseConfig(JSON.parse(await readFile(file, 'utf8')));
}
