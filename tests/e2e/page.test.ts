import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDirectory } from '../../src/runner/static.ts';

const root = resolve(import.meta.dirname, '../..');
let browser: Browser;
let server: Awaited<ReturnType<typeof serveDirectory>>;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await serveDirectory(join(root, 'demo'));
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

interface Options { width?: number; height?: number; reducedMotion?: 'reduce' | 'no-preference' }

async function open({ width = 1280, height = 720, reducedMotion }: Options = {}): Promise<{ page: Page; problems: string[]; external: string[] }> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const problems: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) problems.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) external.push(r.url()); });
  await page.goto(`${server.url}index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  return { page, problems, external };
}

const clock = (page: Page) => page.locator('#clock').textContent();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const playLabel = (page: Page) => page.locator('#play span.on').textContent();
const seek = (page: Page, ms: number) => page.locator('#time').evaluate((el: HTMLInputElement, value) => {
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, ms);

const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);

/** Text against the fill actually under it, walking up through any transparent parents. */
async function contrast(target: Locator): Promise<number> {
  const { color, fills } = await target.evaluate((el) => {
    const list: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) list.push(getComputedStyle(n).backgroundColor);
    return { color: getComputedStyle(el).color, fills: list };
  });
  const parse = (s: string) => {
    const [r, g, b, a = 1] = s.match(/[\d.]+/g)!.map(Number);
    return [r!, g!, b!, a];
  };
  const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
  const fill = fills.reverse().reduce((under, c) => over(parse(c), under), [255, 255, 255]);
  const [a, b] = [luminance(over(parse(color), fill)), luminance(fill)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

describe('project page', () => {
  it('opens on the recorded failure, with no errors and no outside requests', async () => {
    const { page, problems, external } = await open();
    await expect.poll(() => page.locator('#verdict p.on').textContent()).toContain('starts 80 px to the right');
    expect(await page.locator('#label-bottom').textContent()).toBe('Broken build');
    expect(await page.locator('#note-bottom').textContent()).toBe('Started 80 px from Inspect');
    expect(await page.locator('.tag').textContent()).toBe('Recorded replay');
    expect(await page.locator('.title p').textContent()).toBe('Find the part where it broke');
    expect(problems).toEqual([]);
    expect(external).toEqual([]);
    await page.context().close();
  });

  it('holds the failure with the paragraphs hidden', async () => {
    const { page } = await open();
    await page.addStyleTag({ content: 'p, .reading { visibility: hidden !important; }' });
    expect(await page.locator('#pane-bottom .m-label').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('#pane-bottom .m-label').textContent()).toBe('80 px');
    expect(await page.locator('#pane-bottom .m-start').getAttribute('visibility')).toBe('visible');
    await expect.poll(() => page.locator('#note-bottom').isVisible()).toBe(true);
    await page.context().close();
  });

  it('plays from the start, freezes on the jump, then runs to the end', async () => {
    const { page } = await open();
    await page.locator('#play').click();
    expect(Number.parseInt((await clock(page))!, 10)).toBeLessThan(400);
    expect(await playLabel(page)).toBe('Pause');
    await page.waitForFunction(() => document.getElementById('clock')!.textContent === '4000 ms', undefined, { timeout: 9000 });
    await page.waitForTimeout(250);
    expect(await clock(page)).toBe('4000 ms');
    await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 9000 });
    expect(await clock(page)).toBe('5300 ms');
    expect(await page.locator('#verdict p.on').textContent()).toContain('a final screenshot would miss this');
    await page.context().close();
  });

  it('keeps one clock across modes, and the framing does not move', async () => {
    const { page } = await open();
    const box = await page.locator('#pane-bottom .view').boundingBox();
    await seek(page, 4016);
    for (const name of ['Show the four steps', 'Fixed', 'Before']) {
      await button(page, name).click();
      expect(await clock(page)).toBe('4016 ms');
      expect(await button(page, name).getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator('#pane-bottom .view').boundingBox()).toEqual(box);
    }
    await page.context().close();
  });

  it('labels each mode, and never asks for internal build names', async () => {
    const { page } = await open();
    expect(await page.locator('#rail-title').textContent()).toBe('Original session');
    expect(await page.locator('#rail-count').textContent()).toBe('14 steps');
    await button(page, 'Show the four steps').click();
    expect(await page.locator('#rail-title').textContent()).toBe('Reduced');
    expect(await page.locator('#rail-count').textContent()).toBe('4 of 14 steps');
    await button(page, 'Fixed').click();
    expect(await page.locator('#rail-title').textContent()).toBe('Fixed');
    expect(await page.locator('#label-bottom').textContent()).toBe('Fixed build');
    expect(await page.locator('#pane-bottom .m-label').getAttribute('visibility')).toBe('hidden');
    await page.context().close();
  });

  it('draws every recorded attempt and ends on the four kept steps', async () => {
    const { page } = await open({ reducedMotion: 'reduce' });
    await button(page, 'Show the four steps').click();
    expect(await page.locator('.a-column.on').count()).toBe(26);
    expect(await page.locator('.a-column.a-invalid').count()).toBe(13);
    expect(await page.locator('.a-column.a-fails').count()).toBe(6);
    expect(await page.locator('.a-column.a-passes').count()).toBe(5);
    expect(await page.locator('.a-column.a-other-failure').count()).toBe(2);
    const kept = await page.locator('#steps button[aria-disabled="false"] span').allTextContents();
    expect(kept).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    await page.context().close();
  });

  it('ends a replay with reduced motion on the jump, and animates nothing', async () => {
    const { page } = await open({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await button(page, 'Show the four steps').click();
    await page.locator('#play').click();
    expect(await clock(page)).toBe('0 ms');
    await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 9000 });
    expect(await clock(page)).toBe('4000 ms');
    await page.context().close();
  });

  it('keeps a selected control readable in every state', async () => {
    const { page } = await open({ width: 1440, height: 900 });
    for (const name of ['Before', 'Show the four steps', 'Fixed', 'Geometry']) {
      const control = button(page, name);
      if ((await control.getAttribute('aria-pressed')) !== 'true') await control.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(160);
      expect(await contrast(control)).toBeGreaterThan(7);
      await control.hover();
      await page.waitForTimeout(160);
      expect(await contrast(control)).toBeGreaterThan(7);
      await control.focus();
      expect(await contrast(control)).toBeGreaterThan(7);
      await page.mouse.down();
      await page.waitForTimeout(160);
      expect(await contrast(control)).toBeGreaterThan(7);
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    await page.context().close();
  });

  it('keeps focus on a control that turns disabled', async () => {
    const { page } = await open();
    await seek(page, 2000);
    await page.locator('#jump').focus();
    await page.keyboard.press('Enter');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('#jump').getAttribute('aria-disabled')).toBe('true');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('jump');
    await page.context().close();
  });

  it('steps the failure one tick at a time from the keyboard', async () => {
    const { page } = await open();
    await seek(page, 3984);
    await page.locator('#time').focus();
    await page.keyboard.press('ArrowRight');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('#pane-bottom .m-label').getAttribute('visibility')).toBe('visible');
    await page.context().close();
  });

  it('shows the recorded rectangles as Geometry', async () => {
    const { page } = await open();
    await button(page, 'Geometry').click();
    expect(await page.locator('#stage').getAttribute('class')).toContain('is-geometry');
    expect(await page.locator('#pane-bottom .g-panel').getAttribute('visibility')).toBe('visible');
    await page.context().close();
  });

  it('fits a phone with no sideways scroll, and Replay sits beside the result', async () => {
    for (const [width, height] of [[390, 844], [320, 568]] as const) {
      const { page } = await open({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const play = (await page.locator('#play').boundingBox())!;
      expect(play.y + play.height).toBeLessThanOrEqual(height);
      await page.context().close();
    }
  });

  it('quotes the tuned score only with its limit, and keeps the wording rules', async () => {
    const { page } = await open();
    const text = await page.locator('#details').textContent();
    expect(text).toContain('18 of 18 seeded bugs caught');
    expect(text).toContain('also finds all 18');
    expect(text).toContain('on a corpus I wrote');
    expect(text).toContain('6 of 6 seeded bugs caught');
    expect(text).toContain('2 of 295 sessions flagged');
    expect(text).not.toMatch(/independent review|No false alarms/i);
    expect(await page.locator('body').textContent()).not.toMatch(/[–—]/);
    await page.context().close();
  });

  it('links to reports that exist, and keeps every path relative', async () => {
    const { page } = await open();
    const links = await page.locator('#details a').evaluateAll((all) => all.map((a) => a.getAttribute('href')!));
    const local = links.filter((href) => !href.startsWith('http'));
    expect(local).toEqual(['regression/index.html', 'fixed/index.html']);
    for (const href of local) expect(existsSync(join(root, 'demo', href))).toBe(true);
    const html = await page.content();
    expect(html).not.toMatch(/\/Users\/|href="\/|src="\//);
    await page.context().close();
  });
});
