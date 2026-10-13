import { createHash } from 'node:crypto';
import type { Observation } from './model.js';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function sanitizeUrl(value: string): string {
  try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol)) return `[${u.protocol.replace(':', '')} URL omitted]`; u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString().slice(0, 8192); }
  catch { return '[invalid URL]'; }
}
export function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]).finally(() => clearTimeout(timer));
}
export function fontIdentity(font: { familyName: string; postScriptName: string; isCustomFont: boolean }): string {
  return JSON.stringify([font.familyName, font.postScriptName, font.isCustomFont]);
}

/** Index membership once while preserving the original canonical observation order. */
export function indexObservations(observations: Observation[]): (ids: string[]) => Observation[] {
  const entries = new Map<string, Array<{ observation: Observation; position: number }>>();
  observations.forEach((observation, position) => {
    const group = entries.get(observation.id) ?? [];
    group.push({ observation, position }); entries.set(observation.id, group);
  });
  return ids => [...new Set(ids)].flatMap(id => entries.get(id) ?? []).sort((a, b) => a.position - b.position).map(entry => entry.observation);
}
