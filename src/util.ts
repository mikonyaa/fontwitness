import { createHash } from 'node:crypto';
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
