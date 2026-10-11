import type { Page } from 'playwright';
import { bounded } from './util.js';

export async function waitFonts(page: Page, ms: number): Promise<boolean> {
  return bounded(page.evaluate(() => document.fonts.ready.then(() => true)), ms, 'FONT_READY_TIMEOUT').catch(() => false);
}
export async function renderingFrame(page: Page): Promise<void> {
  await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 5000, 'RENDER_FRAME_TIMEOUT');
}
export async function stableWindow(page: Page, ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
  await renderingFrame(page);
}
