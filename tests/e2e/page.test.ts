import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDirectory } from '../../src/runner/static.ts';
import { parseScenario } from '../../src/scenario/validate.ts';

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
const still = { reducedMotion: 'reduce' } as const;
const reelX = (page: Page) => page.locator('#reel').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
/** How many pixels of the viewer are brighter than a level, read from the canvas itself. */
const lit = (page: Page, level: number) => page.locator('#screen').evaluate((el: HTMLCanvasElement, min) => {
  const { data } = el.getContext('2d')!.getImageData(0, 0, el.width, el.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! > min && data[i + 3]! > 0) n += 1;
  return n;
}, level);

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
    const { page, problems, external } = await open(still);
    await expect.poll(() => page.locator('#verdict p.on').textContent()).toContain('starts 80 px to the right');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('.tag').textContent()).toBe('Recorded replay');
    expect(await page.locator('#source').textContent()).toBe('Recorded screenshots');
    expect(await page.locator('.title p').textContent()).toBe('Find the part where it broke');
    expect(await page.locator('.cell.current .cell-ms').textContent()).toBe('4000');
    await page.waitForLoadState('networkidle');
    expect(problems).toEqual([]);
    expect(external).toEqual([]);
    await page.context().close();
  });

  it('holds the failure with the paragraphs hidden', async () => {
    const { page } = await open(still);
    await page.addStyleTag({ content: 'p, .reading { visibility: hidden !important; }' });
    await expect.poll(() => page.locator('#marks .ruler').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('#marks .m-label').textContent()).toBe('80 px');
    expect(await page.locator('#marks .m-outline.bad').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('.peak').textContent()).toBe('80 px');
    expect(await page.locator('.cell.differs').count()).toBe(15);
    await page.context().close();
  });

  it('measures the gap from the recorded rectangles on every frame of the failure', async () => {
    const { page } = await open(still);
    const report = JSON.parse(readFileSync(join(root, 'demo/regression/report.json'), 'utf8'));
    const original = report.cases.find((c: { id: string }) => c.id === 'original');
    const x = (side: string, t: number) => original[side].events.find((e: { k: string; target: string; t: number }) => e.k === 'geometry' && e.target === 'panel' && e.t === t).rect.x;
    for (const t of [4000, 4016, 4064, 4128]) {
      await seek(page, t);
      await expect.poll(() => page.locator('#marks .m-label').textContent()).toBe(`${Math.round(x('candidate', t) - x('baseline', t))} px`);
    }
    await seek(page, 4240);
    await expect.poll(() => page.locator('#marks .ruler').getAttribute('visibility')).toBe('hidden');
    await seek(page, 4016);
    await expect.poll(() => page.locator('#marks .ruler').getAttribute('visibility')).toBe('visible');
    await seek(page, 3600);
    await expect.poll(() => page.locator('#marks .ruler').getAttribute('visibility')).toBe('hidden');
    await page.context().close();
  });

  it('plays from the start, freezes on the jump, then runs to the end', async () => {
    const { page } = await open();
    await page.locator('#play').click();
    expect(Number.parseInt((await clock(page))!, 10)).toBeLessThan(400);
    expect(await playLabel(page)).toBe('Pause');
    await page.waitForFunction(() => document.getElementById('clock')!.textContent === '4000 ms', undefined, { timeout: 12000 });
    await page.waitForTimeout(250);
    expect(await clock(page)).toBe('4000 ms');
    await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 12000 });
    expect(await clock(page)).toBe('4800 ms');
    expect(await page.locator('#verdict p.on').textContent()).toContain('a final screenshot would miss this');
    await page.context().close();
  });

  it('replays the failure while left alone, and hands over at the first touch', async () => {
    const { page } = await open();
    expect(await clock(page)).toBe('4000 ms');
    await page.waitForFunction(() => document.getElementById('clock')!.textContent !== '4000 ms', undefined, { timeout: 9000 });
    for (let i = 0; i < 6; i++) {
      const t = Number.parseInt((await clock(page))!, 10);
      expect(t).toBeGreaterThanOrEqual(4000);
      expect(t).toBeLessThanOrEqual(4240);
      await page.waitForTimeout(200);
    }
    expect(await page.evaluate(() => location.search)).toBe('');
    await page.locator('#time').focus();
    await page.keyboard.press('f');
    await page.waitForFunction(() => document.getElementById('clock')!.textContent === '4000 ms');
    await page.waitForTimeout(3600);
    expect(await clock(page)).toBe('4000 ms');
    expect(await playLabel(page)).toBe('Replay');
    await page.context().close();
  });

  it('keeps one clock across views and sessions, and the framing does not move', async () => {
    const { page } = await open(still);
    const box = await page.locator('#viewer').boundingBox();
    await seek(page, 4016);
    for (const name of ['Swipe', 'Difference', 'Geometry', 'Overlay', 'The 4 that matter', 'All 14 steps']) {
      await button(page, name).click();
      expect(await clock(page)).toBe('4016 ms');
      expect(await button(page, name).getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator('#viewer').boundingBox()).toEqual(box);
    }
    await page.context().close();
  });

  it('shows each view from what was recorded, and says which it is', async () => {
    const { page } = await open(still);
    await page.locator('.cell.ready').nth(20).waitFor();
    await button(page, 'Difference').click();
    await seek(page, 3600);
    await expect.poll(() => page.locator('#readout').textContent()).toBe('No pixel differs in this frame');
    await expect.poll(() => lit(page, 90)).toBe(0);
    await seek(page, 4032);
    expect(await page.locator('#readout').textContent()).toBe('Lit where the two frames differ');
    await expect.poll(() => lit(page, 90)).toBeGreaterThan(500);
    await seek(page, 4800);
    await expect.poll(() => lit(page, 90)).toBe(0);
    await button(page, 'Geometry').click();
    expect(await page.locator('#source').textContent()).toBe('Recorded geometry');
    await expect.poll(() => page.locator('#marks .g-panel.good').getAttribute('visibility')).toBe('visible');
    expect(await lit(page, -1)).toBe(0);
    await seek(page, 4032);
    await expect.poll(() => page.locator('#marks .g-panel.bad').getAttribute('visibility')).toBe('visible');
    // The path starts where the report says the broken panel first appeared.
    expect(await page.locator('#marks .g-fan.bad').getAttribute('d')).toContain('M903.3 16');
    await page.context().close();
  });

  it('moves the swipe divider by pointer and by keyboard', async () => {
    const { page } = await open(still);
    await button(page, 'Swipe').click();
    const divider = page.locator('#divider');
    const start = Number(await divider.getAttribute('aria-valuenow'));
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(start - 2);
    expect(await clock(page)).toBe('4000 ms');
    const box = (await page.locator('#viewer').boundingBox())!;
    await page.mouse.move(box.x + box.width * (start - 2) / 100, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(25);
    await button(page, 'Overlay').click();
    expect(await divider.isVisible()).toBe(false);
    await page.context().close();
  });

  it('labels each session, and never asks for internal build names', async () => {
    const { page } = await open(still);
    expect(await page.locator('#steps button[aria-disabled="false"]').count()).toBe(14);
    expect(await page.locator('.cell').count()).toBe(89);
    await button(page, 'The 4 that matter').click();
    const kept = await page.locator('#steps button[aria-disabled="false"] span').allTextContents();
    expect(kept).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    expect(await page.locator('.cell').count()).toBe(49);
    expect(await page.locator('#verdict p.on').textContent()).toContain('deleted the other 10 steps');
    expect(await page.locator('body').textContent()).not.toMatch(/stale-origin|inspector@|widen/);
    await page.context().close();
  });

  it('draws every recorded attempt and ends on the four kept steps', async () => {
    const { page } = await open(still);
    expect(await page.locator('.a-column.on').count()).toBe(26);
    expect(await page.locator('.a-column.a-invalid').count()).toBe(13);
    expect(await page.locator('.a-column.a-fails').count()).toBe(6);
    expect(await page.locator('.a-column.a-passes').count()).toBe(5);
    expect(await page.locator('.a-column.a-other-failure').count()).toBe(2);
    expect(await page.locator('.a-life.kept').count()).toBe(4);
    expect(await page.locator('#steps .step:not(.gone) span').allTextContents()).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    expect(await page.locator('#attempt-note').textContent()).toBe('26 attempts left 4 steps, and taking any one of them away loses the jump.');
    const attempts = JSON.parse(readFileSync(join(root, 'demo/reduction.attempts.json'), 'utf8')).state.attempts as { kept: number[] }[];
    for (const [i, attempt] of attempts.entries()) expect(await page.locator('.a-column').nth(i).locator('.a-cell').count()).toBe(attempt.kept.length);
    await page.context().close();
  });

  it('scrubs the reduction one attempt at a time', async () => {
    const { page } = await open(still);
    const range = page.locator('#attempt');
    await range.focus();
    await page.keyboard.press('Home');
    expect(await page.locator('.a-column.on').count()).toBe(0);
    expect(await page.locator('#steps .step.gone').count()).toBe(0);
    expect(await page.locator('#attempt-note').textContent()).toContain('All 14 steps reproduce the jump');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    expect(await page.locator('.a-column.on').count()).toBe(4);
    expect(await page.locator('#steps .step.gone').count()).toBe(4);
    expect(await page.locator('#axis-count').textContent()).toBe('Attempt 4 of 26');
    expect(await page.locator('#attempt-note').textContent()).toBe('Attempt 4 ran 10 steps and the panel still jumped, so the 4 steps it left out are gone for good.');
    expect(await clock(page)).toBe('4000 ms');
    await page.context().close();
  });

  it('plays the reduction when asked, and lets the scrubber take over', async () => {
    const { page } = await open();
    await page.waitForFunction(() => document.querySelectorAll('.a-column.on').length === 26, undefined, { timeout: 9000 });
    await page.locator('#reduce-play').click();
    await page.waitForFunction(() => { const n = document.querySelectorAll('.a-column.on').length; return n > 0 && n < 26; });
    await page.locator('#attempt').evaluate((el: HTMLInputElement) => {
      el.value = '9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    expect(await page.locator('.a-column.on').count()).toBe(9);
    await page.context().close();
  });

  it('ends a replay with reduced motion on the jump, and animates nothing', async () => {
    const { page } = await open(still);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.waitForTimeout(3200);
    expect(await clock(page)).toBe('4000 ms');
    await button(page, 'The 4 that matter').click();
    await page.locator('#play').click();
    expect(await clock(page)).toBe('0 ms');
    await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 9000 });
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.context().close();
  });

  it('keeps a selected control readable in every state', async () => {
    const { page } = await open({ width: 1440, height: 900, ...still });
    for (const name of ['Swipe', 'Difference', 'Geometry', 'Overlay', 'The 4 that matter', 'All 14 steps']) {
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
    const { page } = await open(still);
    await seek(page, 2000);
    await page.locator('#jump').focus();
    await page.keyboard.press('Enter');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('#jump').getAttribute('aria-disabled')).toBe('true');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('jump');
    await page.context().close();
  });

  it('steps by frame and by step from the keyboard, never landing between frames', async () => {
    const { page } = await open(still);
    await seek(page, 3600);
    await page.locator('#time').focus();
    await page.keyboard.press('ArrowRight');
    expect(await clock(page)).toBe('4000 ms');
    await expect.poll(() => page.locator('#marks .m-label').textContent()).toBe('80 px');
    await page.keyboard.press('ArrowRight');
    expect(await clock(page)).toBe('4016 ms');
    await page.keyboard.press(']');
    expect(await clock(page)).toBe('4400 ms');
    expect(await page.locator('#steps [aria-current="true"] span').textContent()).toBe('Focus the name');
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    expect(await clock(page)).toBe('3600 ms');
    await page.keyboard.press('Home');
    expect(await clock(page)).toBe('0 ms');
    await page.keyboard.press('End');
    expect(await clock(page)).toBe('4800 ms');
    await button(page, 'Overlay').focus();
    await page.keyboard.press('f');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('#time').getAttribute('aria-valuetext')).toBe('4000 ms, step 12: Reopen, frame 72 of 89');
    await page.context().close();
  });

  it('drags the film under the gate, and a flick keeps its speed after the release', async () => {
    const { page } = await open();
    const film = (await page.locator('#film').boundingBox())!;
    const y = film.y + film.height / 2;
    const x = film.x + film.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 220, y, { steps: 5 });
    expect(await clock(page)).toBe('3440 ms');
    expect(await playLabel(page)).toBe('Play');
    await page.mouse.up();
    await page.waitForTimeout(700);
    expect(await clock(page)).toBe('3440 ms');
    expect(Math.abs((await reelX(page)) % 1)).toBeLessThan(0.01);
    // A fast drag, released while moving, carries on past where the pointer let go.
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 45, y);
    const atRelease = await reelX(page);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const rested = await reelX(page);
    expect(rested - atRelease).toBeGreaterThan(60);
    expect(await page.locator('.cell.current .cell-ms').textContent()).toBe((await clock(page))!.replace(' ms', ''));
    // A press without a drag goes to the frame under the pointer.
    const before = Number.parseInt((await clock(page))!, 10);
    await page.mouse.click(x + 110, y);
    await page.waitForTimeout(700);
    expect(Number.parseInt((await clock(page))!, 10)).toBeGreaterThan(before);
    await page.context().close();
  });

  it('opens a link on the same frame, view and session, and keeps the link current', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${server.url}index.html?t=4032&view=difference&steps=4`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await clock(page)).toBe('4032 ms');
    expect(await button(page, 'Difference').getAttribute('aria-pressed')).toBe('true');
    expect(await button(page, 'The 4 that matter').getAttribute('aria-pressed')).toBe('true');
    expect(await playLabel(page)).toBe('Play');
    await button(page, 'Geometry').click();
    await seek(page, 4064);
    await expect.poll(() => page.evaluate(() => location.search)).toBe('?t=4064&view=geometry&steps=4');
    await button(page, 'Overlay').click();
    await button(page, 'All 14 steps').click();
    await page.locator('#jump').click();
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
    await context.close();
  });

  it('copies the four steps as a scenario Trace accepts, and the README commands', async () => {
    const { page } = await open(still);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#copy').click();
    await expect.poll(() => page.locator('#copy span.on').textContent()).toBe('Copied as a scenario');
    const copied = parseScenario(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())));
    expect(copied.actions.map((a) => a.note)).toEqual(['open', 'close with Escape', 'resize to 920 px', 'reopen']);
    expect(copied.actions.map((a) => a.at)).toEqual([0, 3200, 3600, 4000]);
    expect(await page.locator('#status').textContent()).toContain('clipboard');
    await page.locator('[data-copy="cmd-run"]').click();
    const command = await page.evaluate(() => navigator.clipboard.readText());
    expect(command).toBe('pnpm trace run my.scenario.json --baseline tabs@main --candidate tabs@branch');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(command);
    await page.context().close();
  });

  it('loads the frames behind the first paint, and fills the film as they arrive', async () => {
    const html = readFileSync(join(root, 'demo/index.html'), 'utf8');
    expect(html.match(/frames\/[0-9a-f]+\.webp/g)).toHaveLength(2);
    expect(html.length).toBeLessThan(200_000);
    const { page } = await open(still);
    await expect.poll(() => page.locator('.cell.ready').count(), { timeout: 15000 }).toBe(89);
    await page.context().close();
  });

  it('fits every width with no sideways scroll, and the film and Replay sit beside the result', async () => {
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768], [768, 1024], [390, 844], [320, 568]] as const) {
      const { page } = await open({ width, height, ...still });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const play = (await page.locator('#play').boundingBox())!;
      const viewer = (await page.locator('#viewer').boundingBox())!;
      expect(play.y + play.height).toBeLessThanOrEqual(height);
      expect(viewer.y).toBeGreaterThanOrEqual(0);
      expect(viewer.height).toBeGreaterThan(140);
      await page.context().close();
    }
  });

  it('quotes the tuned score only with its limit, and keeps the wording rules', async () => {
    const { page } = await open(still);
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

  it('links to reports that exist, as folders, and keeps every path relative', async () => {
    const { page } = await open(still);
    const links = await page.locator('main a').evaluateAll((all) => all.map((a) => a.getAttribute('href')!));
    const local = links.filter((href) => !href.startsWith('http') && !href.startsWith('#'));
    expect(local).toEqual(['regression/', 'regression/', 'fixed/']);
    for (const href of local) expect(existsSync(join(root, 'demo', href, 'index.html'))).toBe(true);
    const html = await page.content();
    expect(html).not.toMatch(/\/Users\/|href="\/|src="\/|index\.html/);
    await page.context().close();
  });
});
