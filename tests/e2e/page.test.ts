import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveDirectory } from '../../src/runner/static.ts';
import { parseScenario } from '../../src/scenario/validate.ts';
import { lineProblem } from '../../site/lines.ts';

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
const stageData = (page: Page, key: string) => page.locator('#stage').evaluate((el: HTMLElement, k) => el.dataset[k] ?? '', key);
/** Where a line or needle sits, from the transform the page gave it. */
const offsetY = (page: Page, id: string) => page.locator(id).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
/** The rows of a core where the two builds' pictures are not the same, read from the canvases themselves. */
const differingRows = (page: Page) => page.evaluate(() => {
  const read = (id: string) => {
    const c = document.getElementById(id) as HTMLCanvasElement;
    return { w: c.width, h: c.height, px: new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer) };
  };
  const a = read('scan-good');
  const b = read('scan-bad');
  const rows: number[] = [];
  for (let r = 0; r < a.h; r++) for (let x = 0; x < a.w; x++) if (a.px[r * a.w + x] !== b.px[r * b.w + x]) { rows.push(r); break; }
  return rows;
});
/** The rows of a canvas that hold any pixel that is not black. */
const litRows = (page: Page, id: string) => page.locator(id).evaluate((c: HTMLCanvasElement) => {
  const px = new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
  const rows: number[] = [];
  for (let r = 0; r < c.height; r++) for (let x = 0; x < c.width; x++) if ((px[r * c.width + x]! & 0xffffff) !== 0) { rows.push(r); break; }
  return rows;
});
const scanned = (page: Page, rows: number) => expect.poll(() => stageData(page, 'rows'), { timeout: 20000 }).toBe(String(rows));
/** How many pixels of the viewer are brighter than a level, read from the canvas itself. */
const lit = (page: Page, level: number, canvas = '#glow') => page.locator(canvas).evaluate((el: HTMLCanvasElement, min) => {
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
    expect(await page.locator('#source').textContent()).toBe('Recorded screenshots');
    expect(await page.locator('.title p').count()).toBe(0);
    expect(await page.locator('#now').textContent()).toBe('12Reopen');
    expect(await button(page, 'The jump').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#search').isVisible()).toBe(false);
    await page.waitForLoadState('networkidle');
    await scanned(page, 89);
    expect(problems).toEqual([]);
    expect(external).toEqual([]);
    await page.context().close();
  });

  it('holds the failure with the paragraphs hidden', async () => {
    const { page } = await open(still);
    await page.addStyleTag({ content: 'p, .story { visibility: hidden !important; }' });
    await expect.poll(() => page.locator('#marks-bad .ruler').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('#marks-bad .m-label').textContent()).toBe('80 px');
    expect(await page.locator('#marks-bad .m-outline.bad').getAttribute('visibility')).toBe('visible');
    // The last good build outlines its own panel, and has nothing to measure.
    expect(await page.locator('#marks-good .m-outline.good').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('#marks-good .m-label').getAttribute('visibility')).toBe('hidden');
    expect(await page.locator('#marks-good .m-span').getAttribute('visibility')).toBe('hidden');
    // One note on the broken build's core says how far off the panel opened, for how long and on which step.
    expect(await page.locator('#core-bad .c-call-text').allTextContents()).toEqual(['Opens 80 px to the right', 'for 240 ms, at Reopen']);
    expect(await page.locator('#core-good .c-call-text').count()).toBe(0);
    // The time axis is named on the other core.
    expect(await page.locator('#core-good .c-axis').allTextContents()).toEqual(['Start', 'End']);
    await page.context().close();
  });

  it('measures the gap from the recorded rectangles on every frame of the failure', async () => {
    const { page } = await open(still);
    const report = JSON.parse(readFileSync(join(root, 'demo/regression/report.json'), 'utf8'));
    const original = report.cases.find((c: { id: string }) => c.id === 'original');
    const x = (side: string, t: number) => original[side].events.find((e: { k: string; target: string; t: number }) => e.k === 'geometry' && e.target === 'panel' && e.t === t).rect.x;
    for (const t of [4000, 4016, 4064, 4128]) {
      await seek(page, t);
      await expect.poll(() => page.locator('#marks-bad .m-label').textContent()).toBe(`${Math.round(x('candidate', t) - x('baseline', t))} px`);
    }
    await seek(page, 4240);
    await expect.poll(() => page.locator('#marks-bad .ruler').getAttribute('visibility')).toBe('hidden');
    // Once the builds agree, nothing of the ruler or the outlines is left on either frame.
    for (const part of ['#marks-bad .m-outline.bad', '#marks-bad .m-outline.good', '#marks-bad .m-label', '#marks-bad .m-pill', '#marks-good .m-outline.good']) expect(await page.locator(part).isVisible()).toBe(false);
    await seek(page, 4016);
    await expect.poll(() => page.locator('#marks-bad .ruler').getAttribute('visibility')).toBe('visible');
    await seek(page, 3600);
    await expect.poll(() => page.locator('#marks-bad .ruler').getAttribute('visibility')).toBe('hidden');
    await page.context().close();
  });

  it('opens close on the start of the failure, and opens out as the panel grows', async () => {
    const { page } = await open(still);
    const crop = JSON.parse((await page.locator('#trace-data').textContent())!).crop as { x: number; y: number; w: number; h: number };
    const view = async (side = 'bad') => (await page.locator(`#marks-${side}`).getAttribute('viewBox'))!.split(' ').map(Number);
    await expect.poll(async () => (await view())[2]).toBeLessThan(300);
    const close = await view();
    // Inspect and both places the panel starts are inside the frame, with room under them for the ruler.
    expect(close[0]).toBeLessThan(823.3 - 30);
    expect(close[0]! + close[2]!).toBeGreaterThanOrEqual(984);
    expect(close[1]! + close[3]!).toBeGreaterThan(52 + 30);
    expect(await view('good')).toEqual(close);
    // The 80 px between them is the widest thing drawn: more than a quarter of the frame.
    expect(80 / close[2]!).toBeGreaterThan(0.25);
    expect(await page.locator('#marks-good .m-outline.good').getAttribute('visibility')).toBe('visible');
    // Each frame on, the view is wider, until it is the usual one.
    const widths: number[] = [];
    for (const t of [4016, 4032, 4048, 4064, 4128]) {
      await seek(page, t);
      widths.push((await view())[2]!);
    }
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]!);
    expect(widths[0]).toBeGreaterThan(close[2]!);
    expect(await view()).toEqual([crop.x, crop.y, crop.w, crop.h]);
    await seek(page, 3600);
    expect(await view()).toEqual([crop.x, crop.y, crop.w, crop.h]);
    await page.context().close();
    // With motion on, the frame moves there over a few frames and comes to rest on the same view.
    const moving = await open();
    await moving.page.locator('#time').focus();
    await moving.page.keyboard.press('End');
    await expect.poll(async () => (await moving.page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number)[2], { timeout: 5000 }).toBe(crop.w);
    await moving.page.keyboard.press('f');
    // On the way it is somewhere between the two views.
    await expect.poll(async () => { const w = (await moving.page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number)[2]!; return w > close[2]! && w < crop.w; }, { interval: 20 }).toBe(true);
    await expect.poll(async () => (await moving.page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number), { timeout: 5000 }).toEqual(close);
    await moving.page.context().close();
  });

  it('outlines where the panel starts and ends over a screenshot, and its whole path in Geometry', async () => {
    const { page } = await open(still);
    const path = async (side: string) => (await page.locator(`#marks-${side} .m-path`).getAttribute('d'))!;
    // Close on the start there is no room for the end, so nothing but the two dashed outlines is drawn.
    await expect.poll(() => page.locator('#marks-bad .ruler').getAttribute('visibility')).toBe('visible');
    expect(await page.locator('#marks-bad .m-path').getAttribute('visibility')).toBe('hidden');
    await seek(page, 4096);
    await expect.poll(() => page.locator('#marks-bad .m-path').getAttribute('visibility')).toBe('visible');
    expect((await path('bad')).match(/M/g)).toHaveLength(2);
    expect((await path('good')).match(/M/g)).toHaveLength(2);
    // The broken build's first rectangle is where the report says the panel first appeared.
    expect(await path('bad')).toMatch(/^M903\.3 16h/);
    expect(await path('good')).toMatch(/^M823\.3 16h/);
    await button(page, 'Geometry').click();
    await seek(page, 4000);
    expect(await page.locator('#marks-bad .m-path').getAttribute('visibility')).toBe('visible');
    expect((await path('bad')).match(/M/g)).toHaveLength(16);
    expect((await path('good')).match(/M/g)).toHaveLength(16);
    await seek(page, 3600);
    await expect.poll(() => page.locator('#marks-bad .m-path').getAttribute('visibility')).toBe('hidden');
    await seek(page, 4240);
    expect(await page.locator('#marks-good .m-path').getAttribute('visibility')).toBe('hidden');
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

  it('arrives in under 700 ms and then holds still, and does not arrive at all with reduced motion', async () => {
    const { page } = await open();
    const arriving = () => page.evaluate(() => document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'arrive').map((a) => Number(a.effect!.getComputedTiming().endTime)));
    const ends = await arriving();
    expect(ends.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...ends)).toBeLessThanOrEqual(700);
    await page.waitForTimeout(800);
    expect(await arriving()).toEqual([]);
    expect(await page.locator('#stage').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.context().close();
    const calm = await open(still);
    expect(await calm.page.evaluate(() => document.getAnimations().length)).toBe(0);
    await calm.page.context().close();
  });

  it('keeps one clock across views and sessions, and the framing does not move', async () => {
    const { page } = await open(still);
    const box = await page.locator('#pane-bad').boundingBox();
    const stage = await page.locator('#stage').boundingBox();
    await seek(page, 4016);
    for (const name of ['Difference', 'Geometry', 'Screenshots', 'The 4 that matter', 'All 14 steps']) {
      await button(page, name).click();
      expect(await clock(page)).toBe('4016 ms');
      expect(await button(page, name).getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator('#pane-bad').boundingBox()).toEqual(box);
    }
    // The search takes the whole stage, and the stage keeps its size.
    await button(page, 'The search').click();
    expect(await page.locator('#stage').boundingBox()).toEqual(stage);
    await button(page, 'The jump').click();
    expect(await page.locator('#pane-bad').boundingBox()).toEqual(box);
    expect(await clock(page)).toBe('4016 ms');
    await page.context().close();
  });

  it('cuts each core from the recorded frames, one row for each, and the two differ only in the jump', async () => {
    const { page } = await open(still);
    await scanned(page, 89);
    const size = await page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    expect(size[1]).toBe(89);
    expect(size[0]).toBeGreaterThan(300);
    // Rows 71 to 85 are the fifteen frames where the builds differ. The first is above the opening scan line.
    const rows = await differingRows(page);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.every((r) => r >= 71 && r <= 85)).toBe(true);
    expect(rows).not.toContain(71);
    // The page under the scan line is the page in the frame: a row of the picture matches that line of the screenshot.
    const match = await page.evaluate(async () => {
      const data = JSON.parse(document.getElementById('trace-data')!.textContent!);
      const name = data.runs['original-candidate'].frames.findLast((f: { t: number }) => f.t <= 4240).f;
      const img = new Image();
      img.src = `frames/${name}.webp`;
      await img.decode();
      const frame = document.createElement('canvas');
      frame.width = img.naturalWidth;
      frame.height = img.naturalHeight;
      const fc = frame.getContext('2d')!;
      fc.drawImage(img, 0, 0);
      const s = data.frame.scale;
      const line = fc.getImageData(data.crop.x * s, data.scanY * s, data.crop.w * s, 1).data;
      const core = document.getElementById('scan-bad') as HTMLCanvasElement;
      const row = core.getContext('2d')!.getImageData(0, 86, core.width, 1).data;
      // Compare the two where the line is flat, well inside the panel and well outside it.
      const at = (px: number) => { const x = Math.round(((px - data.crop.x) / data.crop.w) * core.width); const sx = Math.round((px - data.crop.x) * s); return [[row[x * 4], row[x * 4 + 1], row[x * 4 + 2]], [line[sx * 4], line[sx * 4 + 1], line[sx * 4 + 2]]]; };
      return [at(700), at(478), at(915)];
    });
    for (const [core, frame] of match) expect(core).toEqual(frame);
    expect(match[0]![0]).toEqual([255, 255, 255]);
    await button(page, 'The 4 that matter').click();
    await scanned(page, 49);
    expect(await page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.height)).toBe(49);
    expect((await differingRows(page)).every((r) => r >= 33 && r <= 47)).toBe(true);
    await page.context().close();
  });

  it('moves the scan line by pointer and by keyboard, and cuts the cores again along it', async () => {
    const { page } = await open(still);
    await scanned(page, 89);
    const line = page.locator('#scanline');
    expect(await line.getAttribute('aria-valuenow')).toBe('84');
    expect(await line.getAttribute('aria-valuetext')).toBe('84 px from the top of the page');
    const before = await page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const y0 = await offsetY(page, '#scanline');
    await line.focus();
    await page.keyboard.press('ArrowUp');
    expect(await line.getAttribute('aria-valuenow')).toBe('82');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await line.getAttribute('aria-valuenow')).toBe('98');
    expect(await page.locator('#scan-y').textContent()).toBe('Row 98');
    expect(await offsetY(page, '#scanline')).toBeGreaterThan(y0);
    await expect.poll(() => page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before);
    expect(await clock(page)).toBe('4000 ms');
    // Through the Inspect button the panel is under the line from its first frame, so the first row of the jump differs too.
    const pane = (await page.locator('#pane-bad').boundingBox())!;
    const [, top, , tall] = (await page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number);
    const rowY = (row: number) => pane.y + ((row - top!) / tall!) * pane.height;
    await page.mouse.move(pane.x + 60, rowY(98));
    await page.mouse.down();
    await page.mouse.move(pane.x + 60, rowY(34), { steps: 5 });
    await page.mouse.up();
    expect(await line.getAttribute('aria-valuenow')).toBe('34');
    await expect.poll(() => differingRows(page)).toContain(71);
    await expect.poll(() => page.evaluate(() => location.search)).toBe('?row=34');
    // The line stays inside the frame.
    await line.focus();
    await page.keyboard.press('Home');
    expect(Number(await line.getAttribute('aria-valuenow'))).toBe(Number(await line.getAttribute('aria-valuemin')));
    await page.keyboard.press('End');
    expect(Number(await line.getAttribute('aria-valuenow'))).toBe(Number(await line.getAttribute('aria-valuemax')));
    expect(Number(await line.getAttribute('aria-valuemax'))).toBeLessThan(320);
    await page.context().close();
  });

  it('scrubs time from the cores, with the needle on the row of the frame on show', async () => {
    const { page } = await open(still);
    await scanned(page, 89);
    const core = (await page.locator('#core-bad').boundingBox())!;
    const bench = (await page.locator('#bench').boundingBox())!;
    const row = core.height / 89;
    const needleRow = async () => ((await offsetY(page, '#needle')) - (core.y - bench.y)) / row - 0.5;
    expect(await needleRow()).toBeCloseTo(71, 1);
    // A press goes to the row under the pointer, and a drag carries on from there.
    await page.mouse.move(core.x + 40, core.y + row * 19.5);
    await page.mouse.down();
    expect(await clock(page)).toBe('1200 ms');
    expect(await playLabel(page)).toBe('Play');
    await page.mouse.move(core.x + 40, core.y + row * 54.5, { steps: 4 });
    expect(await clock(page)).toBe('3200 ms');
    expect(await stageData(page, 'frame')).toBe('54');
    expect(await needleRow()).toBeCloseTo(54, 1);
    // Past either end the needle stops on the first or last frame.
    await page.mouse.move(core.x + 40, core.y + core.height + 200, { steps: 2 });
    expect(await clock(page)).toBe('4800 ms');
    await page.mouse.up();
    // The needle itself can be taken hold of, on either core.
    const good = (await page.locator('#core-good').boundingBox())!;
    await page.mouse.move(good.x + 30, good.y + row * 88.5);
    await page.mouse.down();
    await page.mouse.move(good.x + 30, good.y + row * 71.5, { steps: 4 });
    await page.mouse.up();
    expect(await clock(page)).toBe('4000 ms');
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
    await page.context().close();
  });

  it('shows each view from what was recorded, and says which it is', async () => {
    const { page } = await open(still);
    await scanned(page, 89);
    await button(page, 'Difference').click();
    await seek(page, 3600);
    await expect.poll(() => page.locator('#readout').textContent()).toBe('No pixel differs in this frame');
    await expect.poll(() => lit(page, 0)).toBe(0);
    await seek(page, 4032);
    expect(await page.locator('#readout').textContent()).toBe('Lit where the two frames differ');
    await expect.poll(() => lit(page, 40)).toBeGreaterThan(500);
    // The broken build's core is black wherever the two builds agree, which is everywhere but the jump.
    await expect.poll(async () => (await litRows(page, '#scan-bad')).length).toBeGreaterThanOrEqual(10);
    expect((await litRows(page, '#scan-bad')).every((r) => r >= 71 && r <= 85)).toBe(true);
    expect((await litRows(page, '#scan-good')).length).toBe(89);
    await seek(page, 4800);
    await expect.poll(() => lit(page, 0)).toBe(0);
    await button(page, 'Geometry').click();
    expect(await page.locator('#source').textContent()).toBe('Recorded geometry');
    expect(await page.locator('#core-note').textContent()).toBe('Time runs down these two pictures, and each row shows where the recorded rectangles sat under the line a moment later');
    await expect.poll(() => page.locator('#marks-good .g-panel').getAttribute('visibility')).toBe('visible');
    expect(await lit(page, -1, '#shot-bad')).toBe(0);
    expect(await page.locator('#glow').isVisible()).toBe(false);
    await seek(page, 4032);
    await expect.poll(() => page.locator('#marks-bad .g-ghost').getAttribute('visibility')).toBe('visible');
    // The path starts where the report says the broken panel first appeared.
    expect(await page.locator('#marks-bad .g-fan').getAttribute('d')).toContain('M903.3 16');
    // In Geometry the cores are drawn here from the rectangles, one row for each frame.
    expect(await page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.height)).toBe(89);
    await button(page, 'Screenshots').click();
    // Nothing of the drawing is left over the screenshot.
    for (const part of ['.g-panel', '.g-node', '.g-name', '.g-fan', '.g-view']) await expect.poll(() => page.locator(`#marks-bad ${part}`).first().isVisible()).toBe(false);
    await expect.poll(() => lit(page, 200, '#shot-bad')).toBeGreaterThan(1000);
    expect(await page.locator('#core-note').textContent()).toBe('Time runs down these two pictures, with each row showing the strip of page under the line a moment later, so the shaded shape is the panel opening and closing');
    await page.context().close();
  });

  it('shows the whole frame at one press, and the framed part again at the next', async () => {
    const { page } = await open(still);
    await scanned(page, 89);
    const crop = JSON.parse((await page.locator('#trace-data').textContent())!).crop as { x: number; w: number; h: number };
    const view = async () => (await page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number);
    // Away from the failure the frames show the part of the window where the panel opens.
    await seek(page, 3600);
    expect(await view()).toEqual([crop.x, 0, crop.w, crop.h]);
    expect(crop.w).toBeLessThan(600);
    const box = await page.locator('#pane-bad').boundingBox();
    const whole = page.locator('#whole');
    expect(await whole.getAttribute('aria-label')).toBe('Show the whole frame');
    const before = await page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await whole.click();
    expect(await whole.getAttribute('aria-pressed')).toBe('true');
    expect(await whole.getAttribute('aria-label')).toBe('Show the part where the panel opens');
    expect((await view())[0]).toBe(0);
    expect((await view())[2]).toBe(1000);
    expect(await page.locator('#pane-bad').boundingBox()).toEqual(box);
    await expect.poll(() => page.locator('#scan-bad').evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before);
    await expect.poll(() => page.evaluate(() => location.search)).toBe('?t=3600&frame=whole');
    // The whole frame stays whole on the failure too.
    await seek(page, 4000);
    expect((await view())[2]).toBe(1000);
    await seek(page, 3600);
    await page.keyboard.press('w');
    expect(await view()).toEqual([crop.x, 0, crop.w, crop.h]);
    await page.context().close();
  });

  it('names every step of a session beside the row where it starts, and never asks for internal build names', async () => {
    const { page } = await open(still);
    // The names are placed once the stage has been measured, a frame after it appears.
    await expect.poll(() => page.locator('#steps .step').count()).toBe(14);
    expect(await stageData(page, 'cells')).toBe('89');
    expect(await page.locator('#steps [aria-current="true"] span').textContent()).toBe('Reopen');
    // A name goes to its step.
    await page.locator('#steps .step', { hasText: 'Close with Escape' }).click();
    expect(await clock(page)).toBe('3200 ms');
    expect(await page.locator('#now').textContent()).toBe('10Close with Escape');
    await button(page, 'The 4 that matter').click();
    expect(await page.locator('#steps .step span').allTextContents()).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    expect(await stageData(page, 'cells')).toBe('49');
    await seek(page, 4000);
    expect(await page.locator('#verdict p.on').textContent()).toContain('deleted the other 10 steps');
    expect(await page.locator('body').textContent()).not.toMatch(/stale-origin|inspector@|widen/);
    // No two names sit on top of each other.
    await button(page, 'All 14 steps').click();
    const tops = await page.locator('#steps .step').evaluateAll((all) => all.map((el) => el.getBoundingClientRect().top));
    for (let i = 1; i < tops.length; i++) expect(tops[i]! - tops[i - 1]!).toBeGreaterThanOrEqual(11.5);
    await page.context().close();
  });

  it('draws every recorded attempt of the search and ends on the four kept steps', async () => {
    const { page } = await open(still);
    await button(page, 'The search').click();
    expect(await page.locator('#bench').isVisible()).toBe(false);
    await expect.poll(() => page.locator('.a-column.on').count()).toBe(26);
    expect(await page.locator('.a-column.a-invalid').count()).toBe(13);
    expect(await page.locator('.a-column.a-fails').count()).toBe(6);
    expect(await page.locator('.a-column.a-passes').count()).toBe(5);
    expect(await page.locator('.a-column.a-other-failure').count()).toBe(2);
    expect(await page.locator('.a-end').count()).toBe(4);
    expect(await page.locator('#rows li:not(.gone) span').allTextContents()).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    expect(await page.locator('#result-steps li span').allTextContents()).toEqual(['Open', 'Close with Escape', 'Resize to 920 px', 'Reopen']);
    expect(await page.locator('#result-count').textContent()).toBe('4of 14 steps are needed');
    expect(await page.locator('#keys li').allTextContents()).toEqual(['6kept the failure', '5lost it', '13could not run', '2failed in another way']);
    expect(await page.locator('#attempt-note').textContent()).toBe('26 attempts left 4 steps, and taking any one of them away loses the jump');
    const attempts = JSON.parse(readFileSync(join(root, 'demo/reduction.attempts.json'), 'utf8')).state.attempts as { kept: number[] }[];
    for (const [i, attempt] of attempts.entries()) expect(await page.locator('.a-column').nth(i).locator('.a-cell').count()).toBe(attempt.kept.length);
    // A band runs the whole way across for a kept step, and stops short for a dropped one.
    const widths = await page.locator('.a-alive').evaluateAll((all) => all.map((el) => Number(el.getAttribute('width'))));
    const full = Math.max(...widths);
    expect(widths.filter((w) => w === full)).toHaveLength(4);
    expect([0, 9, 10, 11].every((i) => widths[i] === full)).toBe(true);
    await page.context().close();
  });

  it('scrubs the search one attempt at a time, from the keyboard and on the grid', async () => {
    const { page } = await open(still);
    await button(page, 'The search').click();
    await expect.poll(() => page.locator('.a-column.on').count()).toBe(26);
    const range = page.locator('#attempt');
    await range.focus();
    await page.keyboard.press('Home');
    expect(await page.locator('.a-column.on').count()).toBe(0);
    expect(await page.locator('#rows li.gone').count()).toBe(0);
    expect(await page.locator('#result-count').textContent()).toBe('14of 14 steps still in play');
    expect(await page.locator('#attempt-note').textContent()).toContain('All 14 steps reproduce the jump');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    expect(await page.locator('.a-column.on').count()).toBe(4);
    expect(await page.locator('#rows li.gone').count()).toBe(4);
    expect(await page.locator('#axis-count').textContent()).toBe('Attempt 4 of 26');
    expect(await page.locator('#result-count').textContent()).toBe('10of 14 steps still in play');
    expect(await page.locator('#attempt-note').textContent()).toBe('Attempt 4 ran 10 steps and the panel still jumped, so the 4 steps it left out are gone for good');
    const grid = (await page.locator('#attempts').boundingBox())!;
    const pitch = grid.width / 27;
    await page.mouse.move(grid.x + pitch * 8.5, grid.y + 40);
    await page.mouse.down();
    expect(await page.locator('.a-column.on').count()).toBe(9);
    await page.mouse.move(grid.x + pitch * 15.5, grid.y + 60, { steps: 3 });
    await page.mouse.up();
    expect(await page.locator('#axis-count').textContent()).toBe('Attempt 16 of 26');
    expect(await range.inputValue()).toBe('16');
    await page.context().close();
  });

  it('plays the search the first time it is opened, lets the scrubber take over, and plays the four steps from there', async () => {
    const { page } = await open();
    await button(page, 'The search').click();
    await page.waitForFunction(() => { const n = document.querySelectorAll('.a-column.on').length; return n > 0 && n < 26; });
    await page.waitForFunction(() => document.querySelectorAll('.a-column.on').length === 26, undefined, { timeout: 9000 });
    await page.locator('#reduce-play').click();
    await page.waitForFunction(() => { const n = document.querySelectorAll('.a-column.on').length; return n > 0 && n < 26; });
    await page.locator('#attempt').evaluate((el: HTMLInputElement) => {
      el.value = '9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    expect(await page.locator('.a-column.on').count()).toBe(9);
    await button(page, 'Play the four steps').click();
    expect(await button(page, 'The jump').getAttribute('aria-pressed')).toBe('true');
    expect(await button(page, 'The 4 that matter').getAttribute('aria-pressed')).toBe('true');
    expect(await playLabel(page)).toBe('Pause');
    expect(await page.locator('#bench').isVisible()).toBe(true);
    expect(await stageData(page, 'cells')).toBe('49');
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
    await button(page, 'The search').click();
    await expect.poll(() => page.locator('.a-column.on').count()).toBe(26);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    // With nothing to arrive, the story is simply there.
    expect(await page.locator('.reveal').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.context().close();
  });

  it('keeps a selected control readable in every state', async () => {
    const { page } = await open({ width: 1440, height: 900, ...still });
    for (const name of ['Difference', 'Geometry', 'Screenshots', 'The 4 that matter', 'All 14 steps', 'The search', 'The jump']) {
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
    await expect.poll(() => page.locator('#marks-bad .m-label').textContent()).toBe('80 px');
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
    await button(page, 'Screenshots').focus();
    await page.keyboard.press('f');
    expect(await clock(page)).toBe('4000 ms');
    expect(await page.locator('#time').getAttribute('aria-valuetext')).toBe('4000 ms, step 12: Reopen, frame 72 of 89');
    // Anywhere else on the stage, up and down move the scan line and leave the clock alone.
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#scanline').getAttribute('aria-valuenow')).toBe('88');
    expect(await clock(page)).toBe('4000 ms');
    await page.context().close();
  });

  it('lists its keys at a press of the question mark, and every key in the list does what it says', async () => {
    const { page } = await open(still);
    const help = page.locator('#help');
    expect(await help.evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
    await page.locator('#play').focus();
    await page.keyboard.press('?');
    expect(await help.evaluate((d: HTMLDialogElement) => d.open)).toBe(true);
    expect(await help.locator('dd').allTextContents()).toEqual(['Play or pause', 'One recorded frame', 'One step', 'Go to the jump', 'Move the scan line', 'Whole frame', 'The jump or the search', 'This list']);
    // While the list is open the stage does not take keys.
    await page.keyboard.press('2');
    expect(await button(page, 'The search').getAttribute('aria-pressed')).toBe('false');
    await page.keyboard.press('Escape');
    expect(await help.evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
    await page.locator('#help-open').click();
    expect(await help.evaluate((d: HTMLDialogElement) => d.open)).toBe(true);
    await help.getByRole('button', { name: 'Close' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('help-open');
    await page.keyboard.press('2');
    expect(await button(page, 'The search').getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.press('1');
    expect(await button(page, 'The jump').getAttribute('aria-pressed')).toBe('true');
    await page.context().close();
  });

  it('opens a link on the same frame, view, session and scan line, and keeps the link current', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${server.url}index.html?t=4032&view=difference&steps=4&row=120`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await clock(page)).toBe('4032 ms');
    expect(await button(page, 'Difference').getAttribute('aria-pressed')).toBe('true');
    expect(await button(page, 'The 4 that matter').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#scanline').getAttribute('aria-valuenow')).toBe('120');
    expect(await playLabel(page)).toBe('Play');
    await button(page, 'Geometry').click();
    await seek(page, 4064);
    await expect.poll(() => page.evaluate(() => location.search)).toBe('?t=4064&view=geometry&steps=4&row=120');
    await button(page, 'The search').click();
    await expect.poll(() => page.evaluate(() => location.search)).toBe('?t=4064&view=geometry&steps=4&row=120&act=search');
    await page.reload();
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await button(page, 'The search').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('.a-column.on').count()).toBe(26);
    await button(page, 'The jump').click();
    await button(page, 'Screenshots').click();
    await button(page, 'All 14 steps').click();
    await page.locator('#scanline').focus();
    for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowUp');
    await page.locator('#jump').click();
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
    // A view the page no longer has opens on the screenshots.
    await page.goto(`${server.url}index.html?view=swipe`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await button(page, 'Screenshots').getAttribute('aria-pressed')).toBe('true');
    await context.close();
  });

  it('copies the four steps as a scenario Trace accepts, and the README commands', async () => {
    const { page } = await open(still);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await button(page, 'The search').click();
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
    await expect.poll(() => page.locator('[data-copy="cmd-run"] span.on').textContent()).toBe('Copied');
    await page.context().close();
  });

  it('loads the frames behind the first paint, reads them in a worker, and fills the cores as they arrive', async () => {
    const html = readFileSync(join(root, 'demo/index.html'), 'utf8');
    expect(html.match(/frames\/[0-9a-f]+\.webp/g)).toHaveLength(2);
    expect(html.length).toBeLessThan(215_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname));
    // Hold every frame but the two on show, so the page has to stand up without them.
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const first = html.match(/frames\/[0-9a-f]+\.webp/g)!;
    await page.route('**/frames/*.webp', async (route) => {
      if (!first.some((f) => route.request().url().endsWith(f))) await held;
      await route.continue();
    });
    await page.goto(`${server.url}index.html`, { waitUntil: 'commit' });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await expect.poll(() => lit(page, 200, '#shot-bad')).toBeGreaterThan(1000);
    expect(await clock(page)).toBe('4000 ms');
    await expect.poll(() => stageData(page, 'rows')).toBe('1');
    release();
    await scanned(page, 89);
    expect(asked.filter((p) => p.endsWith('/scan.js'))).toHaveLength(1);
    await context.close();
  });

  it('says when a frame did not load, and gets it the next time the needle comes to it', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const frames = JSON.parse(readFileSync(join(root, 'demo/frames/index.json'), 'utf8')).runs['original-candidate'] as { t: number; f: string }[];
    const lost = frames.find((f) => f.t === 4064)!.f;
    let block = true;
    await page.route('**/frames/*.webp', (route) => (block && route.request().url().includes(lost) ? route.abort() : route.continue()));
    await page.goto(`${server.url}index.html?t=4064`);
    await expect.poll(() => page.locator('#pane-bad').getAttribute('class')).toContain('is-failed');
    expect(await page.locator('#pane-bad').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"This frame did not load"');
    expect(await clock(page)).toBe('4064 ms');
    // The row of the frame that did not load is left clear, and every other row is there.
    await scanned(page, 88);
    block = false;
    await page.locator('#time').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.locator('#pane-bad').getAttribute('class')).toBe('pane bad');
    await scanned(page, 89);
    await context.close();
  });

  it('still cuts the cores where a worker cannot start', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.route('**/scan.js', (route) => route.abort());
    await page.goto(`${server.url}index.html`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await scanned(page, 89);
    const rows = await differingRows(page);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.every((r) => r >= 71 && r <= 85)).toBe(true);
    expect(problems).toEqual([]);
    await context.close();
  });

  it('fits every width with no sideways scroll, and the frame, the cores and Replay share a screen', async () => {
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768], [768, 1024], [390, 844], [320, 568]] as const) {
      const { page } = await open({ width, height, ...still });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const pane = (await page.locator('#pane-bad').boundingBox())!;
      const core = (await page.locator('#core-bad').boundingBox())!;
      const play = (await page.locator('#play').boundingBox())!;
      expect(pane.height).toBeGreaterThan(100);
      expect(core.height).toBeGreaterThanOrEqual(150);
      // Where the two frames sit side by side over the steps, they are the larger half of the pair.
      if (width >= 920) expect(pane.height).toBeGreaterThan(core.height);
      // One line between them says what the pictures under the frames are, at every width.
      expect(await page.locator('#core-note').isVisible()).toBe(true);
      // The frame and the needle that moves it are on one screen, and from 720 px tall so is Replay.
      expect(core.y + core.height - pane.y).toBeLessThanOrEqual(height);
      if (height >= 720) expect(play.y + play.height).toBeLessThanOrEqual(height);
      // The frame and its core share a left and a right edge, so a place on one is the same place on the other.
      expect(Math.abs(pane.x + pane.width - (core.x + core.width))).toBeLessThan(1);
      expect(await page.locator('#pane-good').isVisible()).toBe(width >= 600);
      expect(await page.locator('#steps').isVisible()).toBe(width >= 920);
      await button(page, 'The search').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.locator('#attempts').boundingBox())!.width).toBeGreaterThan(150);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.context().close();
    }
  });

  it('ends no status line, hint, caption or label in a full stop, at any frame, view or attempt', async () => {
    const { page } = await open(still);
    const lines = new Set<string>();
    const collect = async () => {
      const seen = await page.evaluate(() => {
        const text = [...document.querySelectorAll('#stage #verdict p, #attempt-note, #readout, #core-note, #source, #now, #axis-count, #result-count, #scan-y, .chip, .tag, #keys li, #result-steps li, #rows li, #stage button, #help dd, #help h2, #help button, .c-call-text, .c-axis, .story h2, .story h3, .story figcaption, .story .cap, .story th, .story .mark, .story small, .story dt, .story .big span, .limits-list li, .next b, .next span, #ends-say, #ends-time, #make-n')].map((el) => el.textContent ?? '');
        const labels = [...document.querySelectorAll('[aria-label], [aria-valuetext], [title]')].flatMap((el) => ['aria-label', 'aria-valuetext', 'title'].map((a) => el.getAttribute(a) ?? ''));
        const before = [getComputedStyle(document.getElementById('pane-bad')!, '::before').content];
        return [...text, ...labels, ...before, document.getElementById('status')!.textContent ?? ''];
      });
      for (const line of seen) if (line.trim()) lines.add(line.trim());
    };
    for (const view of ['Screenshots', 'Difference', 'Geometry']) {
      await button(page, view).click();
      for (const t of [0, 3600, 4000, 4032, 4800]) {
        await seek(page, t);
        await collect();
      }
    }
    await page.locator('#whole').click();
    await collect();
    await page.locator('#scanline').focus();
    await page.keyboard.press('ArrowUp');
    await collect();
    await button(page, 'The 4 that matter').click();
    await collect();
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 9000 });
    await collect();
    await button(page, 'The search').click();
    const range = page.locator('#attempt');
    await range.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i <= 26; i++) {
      await collect();
      await page.keyboard.press('ArrowRight');
    }
    await page.locator('#reduce-play').click();
    await collect();
    // The figure under the stage says something for each frame it can show.
    await page.locator('#ends').scrollIntoViewIfNeeded();
    await page.locator('.ends-cell').nth(17).waitFor();
    for (const i of [0, 1, 8, 15, 16, 17]) {
      await page.locator('#ends-range').evaluate((el: HTMLInputElement, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, i);
      await collect();
    }
    expect(lines.size).toBeGreaterThan(170);
    expect([...lines].filter((line) => lineProblem(line))).toEqual([]);
    await page.context().close();
  });

  it('shows that the last frames match and where the builds part, from the recorded frames', async () => {
    const { page } = await open({ width: 1280, height: 900, ...still });
    await page.locator('#ends').scrollIntoViewIfNeeded();
    const cells = page.locator('.ends-cell');
    await cells.nth(17).waitFor();
    expect(await cells.count()).toBe(18);
    expect(await page.locator('.ends-cell.differs').count()).toBe(15);
    expect(await cells.last().getAttribute('class')).toBe('ends-cell on');
    expect(await page.locator('#ends-sign').textContent()).toBe('=');
    expect(await page.locator('#ends-time').textContent()).toBe('4800 ms');
    expect(await page.locator('#ends-say').textContent()).toBe('The last frame of each build is the same frame');
    // The two large pictures are the same pixels.
    const same = () => page.evaluate(() => {
      const url = (id: string) => (document.getElementById(id) as HTMLCanvasElement).toDataURL();
      return url('ends-good') === url('ends-bad');
    });
    await expect.poll(() => lit(page, 200, '#ends-bad')).toBeGreaterThan(1000);
    expect(await same()).toBe(true);
    // Moving across the frames, without pressing, shows the frame under the pointer.
    const strip = (await page.locator('#ends-strip').boundingBox())!;
    await page.mouse.move(strip.x + (strip.width / 18) * 1.5, strip.y + 20);
    expect(await page.locator('#ends-time').textContent()).toBe('4016 ms');
    expect(await page.locator('#ends-sign').textContent()).toBe('≠');
    expect(await page.locator('#ends-say').textContent()).toBe('The broken build is 58 px to the right');
    await expect.poll(same).toBe(false);
    await page.mouse.move(strip.x + (strip.width / 18) * 15.5, strip.y + 20);
    expect(await page.locator('#ends-time').textContent()).toBe('4240 ms');
    expect(await page.locator('#ends-say').textContent()).toBe('Both builds show the same frame');
    // Leaving puts the last frame back, and the keyboard moves through the frames too.
    await page.mouse.move(strip.x + 10, strip.y - 120);
    expect(await page.locator('#ends-time').textContent()).toBe('4800 ms');
    await page.locator('#ends-range').focus();
    await page.keyboard.press('Home');
    expect(await page.locator('#ends-time').textContent()).toBe('4000 ms');
    expect(await page.locator('#ends-say').textContent()).toBe('The broken build is 80 px to the right');
    expect(await page.locator('#ends-range').getAttribute('aria-valuetext')).toBe('4000 ms, The broken build is 80 px to the right');
    await page.context().close();
  });

  it('builds a slit scan one row at a time, from the first frames of the recording', async () => {
    const { page } = await open({ width: 1280, height: 900, ...still });
    await page.locator('#make').scrollIntoViewIfNeeded();
    // With reduced motion the picture is whole, on the last frame of the first opening.
    await expect.poll(() => page.locator('#make-n').textContent()).toBe('Frame 16 of 16, at 240 ms');
    expect(await page.locator('#make-core').evaluate((c: HTMLCanvasElement) => c.height / 16)).toBe(12);
    await expect.poll(async () => (await litRows(page, '#make-core')).length, { timeout: 15000 }).toBe(16 * 12);
    // Each row is one colour from top to bottom, because it is one line of the frame.
    const flat = await page.locator('#make-core').evaluate((c: HTMLCanvasElement) => {
      const px = new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
      for (let row = 0; row < 16; row++) for (let y = 1; y < 12; y++) for (let x = 0; x < c.width; x += 7) if (px[(row * 12 + y) * c.width + x] !== px[row * 12 * c.width + x]) return false;
      return true;
    });
    expect(flat).toBe(true);
    await page.locator('#make-range').focus();
    await page.keyboard.press('Home');
    expect(await page.locator('#make-n').textContent()).toBe('Frame 1 of 16, at 0 ms');
    expect(await page.locator('#make').evaluate((el) => el.style.getPropertyValue('--row'))).toBe('0');
    const rows = (await page.locator('#make-rows').boundingBox())!;
    await page.mouse.move(rows.x + 30, rows.y + (rows.height / 16) * 6.5);
    expect(await page.locator('#make-n').textContent()).toBe('Frame 7 of 16, at 96 ms');
    // The thread runs from the line on the frame to the row it became.
    expect(await page.locator('#make-link').getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+C/);
    await page.context().close();
    const moving = await open({ width: 1280, height: 900 });
    await moving.page.locator('#make').scrollIntoViewIfNeeded();
    await expect.poll(() => moving.page.locator('#make-n').textContent()).toMatch(/^Frame [2-9] of 16/);
    await expect.poll(() => moving.page.locator('#make-n').textContent(), { timeout: 8000 }).toBe('Frame 16 of 16, at 240 ms');
    await moving.page.context().close();
  });

  it('judges each build against the same list, and draws each result as marks that add up', async () => {
    const { page } = await open(still);
    const report = JSON.parse(readFileSync(join(root, 'demo/regression/report.json'), 'utf8'));
    const original = report.cases.find((c: { id: string }) => c.id === 'original');
    const rows = page.locator('.rules tbody tr');
    expect(await rows.count()).toBe(original.scenario.requirements.length);
    // Each row carries the requirement exactly as the scenario states it.
    const code = await rows.locator('code').allTextContents();
    expect(code.map((c) => JSON.parse(c))).toEqual(original.scenario.requirements);
    expect(await page.locator('.rules tr.broke').count()).toBe(1);
    expect(await page.locator('.rules tr.broke td').allTextContents()).toEqual([expect.stringContaining('geometry-origin'), 'Held', 'Broken, 80 px off at 4000 ms']);
    expect(await page.locator('.rules .mark.broken').count()).toBe(1);
    expect(await page.locator('.verdicts b').allTextContents()).toEqual(['Pass', 'Regression', 'Fixed', 'Shared failure']);
    expect(await page.locator('.verdicts .here b').textContent()).toBe('Regression');
    expect(await page.locator('.verdicts a').getAttribute('href')).toBe('fixed/');
    // The held-out figure shows the six caught and the one clean build wrongly flagged, side by side.
    const tally = (n: number) => page.locator('.measure').nth(n).locator('.tally > div');
    expect(await tally(0).nth(0).locator('.dot:not(.none)').count()).toBe(6);
    expect(await tally(0).nth(1).locator('.dot.none').count()).toBe(3);
    expect(await tally(0).nth(1).locator('.dot.wrong').count()).toBe(1);
    expect(await page.locator('.measure').nth(0).locator('.big').textContent()).toBe('6 of 6seeded bugs caught1 of 4clean builds wrongly flagged');
    // The tuned score is never drawn without the comparison that matches it.
    expect(await tally(1).nth(0).locator('.dot').count()).toBe(18);
    expect(await tally(1).nth(1).locator('.dot').count()).toBe(18);
    expect(await tally(2).nth(0).locator('.dot').count()).toBe(14);
    expect(await tally(2).nth(0).locator('.dot:not(.none)').count()).toBe(4);
    expect(await tally(2).nth(1).locator('.dot').count()).toBe(18);
    expect(await tally(2).nth(2).locator('.dot:not(.none)').count()).toBe(10);
    expect(await tally(2).nth(3).locator('.dot.none').count()).toBe(3);
    expect(await page.locator('.field i').count()).toBe(295);
    expect(await page.locator('.field i.wrong').count()).toBe(2);
    await page.context().close();
  });

  it('brings the story in as it is scrolled to, and it is all there without scripts', async () => {
    const { page } = await open();
    const chapters = page.locator('.chapter.reveal');
    expect(await chapters.count()).toBe(7);
    await expect.poll(() => chapters.last().evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await chapters.last().scrollIntoViewIfNeeded();
    await expect.poll(() => chapters.last().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.context().close();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, javaScriptEnabled: false });
    const plain = await context.newPage();
    await plain.goto(`${server.url}index.html`);
    expect(await plain.locator('.chapter').last().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await plain.locator('.limits-list li').count()).toBe(6);
    expect(await plain.locator('noscript').count()).toBe(1);
    await context.close();
  });

  it('quotes the tuned score only with its limit, and keeps the wording rules', async () => {
    const { page } = await open(still);
    const text = (await page.locator('#details').textContent())!;
    expect(text).toContain('18 of 18for Trace, and for a plain comparison');
    expect(text).toContain('also finds all 18');
    expect(text).toContain('on a corpus I wrote');
    expect(text).toContain('seeded bugs');
    expect(text).toContain('It ran once on an earlier oracle'.slice(7));
    expect(text).toContain('2 of 295sessions on correct builds flagged');
    expect(text).toContain('10 of 10 fresh runs and 0 of 3 baseline runs');
    expect(text).not.toMatch(/independent review|No false alarms|INP of/i);
    // Every 18 of 18 on the page sits in the figure that draws the comparison beside it.
    expect(text.match(/18 of 18/g)).toHaveLength(1);
    expect(await page.locator('body').textContent()).not.toMatch(/[–—]/);
    await page.context().close();
  });

  it('links to reports that exist, as folders, keeps every path relative, and carries a share card and a tab icon', async () => {
    const { page } = await open(still);
    const links = await page.locator('main a').evaluateAll((all) => all.map((a) => a.getAttribute('href')!));
    const local = links.filter((href) => !href.startsWith('http') && !href.startsWith('#'));
    expect(local).toEqual(['regression/', 'fixed/', 'regression/', 'fixed/']);
    for (const href of local) expect(existsSync(join(root, 'demo', href, 'index.html'))).toBe(true);
    const html = await page.content();
    expect(html).not.toMatch(/\/Users\/|href="\/|src="\/|index\.html/);
    const meta = (name: string) => page.locator(`meta[property="${name}"], meta[name="${name}"]`).getAttribute('content');
    expect(await meta('og:title')).toBe('Trace');
    expect(await meta('og:description')).toBe('Find the part where it broke');
    expect(await meta('og:url')).toBe('https://www.qendrimbeka.com/projects/trace/');
    expect(await meta('og:image')).toBe('https://www.qendrimbeka.com/projects/trace/og.png');
    expect(await meta('twitter:card')).toBe('summary_large_image');
    expect(await meta('twitter:image')).toBe('https://www.qendrimbeka.com/projects/trace/og.png');
    const card = readFileSync(join(root, 'demo/og.png'));
    expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('./favicon.svg');
    expect(readFileSync(join(root, 'demo/favicon.svg'), 'utf8')).toContain('<svg');
    await page.context().close();
  });
});
