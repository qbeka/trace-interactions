import AxeBuilder from '@axe-core/playwright';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { serveDirectory, type StaticServer } from '../../src/runner/static.ts';
import { ROOT } from './helpers.ts';

const exec = promisify(execFile);
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli.ts');
const WIDTHS = [320, 390, 768, 1440];

let browser: Browser;
let failing: StaticServer;
let passing: StaticServer;
let failingDir: string;

async function report(baseline: string, candidate: string, scenario: string, reduce: boolean): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'trace-viewer-'));
  await exec(TSX, [CLI, 'run', scenario, '--baseline', baseline, '--candidate', candidate, '--out', out], { cwd: ROOT }).catch(() => {});
  if (reduce) await exec(TSX, [CLI, 'reduce', out, '--confirm-runs', '1', '--reproduction-runs', '2'], { cwd: ROOT });
  return join(out, 'report');
}

beforeAll(async () => {
  browser = await chromium.launch();
  failingDir = await report('inspector@correct', 'inspector@stale-origin', 'fixtures/inspector/scenarios/long-session.json', true);
  failing = await serveDirectory(failingDir);
  passing = await serveDirectory(await report('overlay@correct', 'overlay@legit-restyle', 'fixtures/overlay/scenarios/open-and-cancel.json', false));
});

afterAll(async () => {
  await failing.close();
  await passing.close();
  await browser.close();
});

async function open(url: string, width = 1280, options: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 800 }, ...options });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('heading', { level: 1 }).waitFor();
  expect(errors).toEqual([]);
  return page;
}

const time = async (page: Page): Promise<number> => parseInt((await page.locator('output.time').textContent()) ?? '0', 10);

describe('portable report', () => {
  it('opens from a static server with no network beyond its own folder', async () => {
    const page = await open(failing.url);
    const origins = new Set<string>();
    page.on('request', (r) => origins.add(new URL(r.url()).origin));
    await page.reload();
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect([...origins]).toEqual([new URL(failing.url).origin]);
    await page.context().close();
  });

  it('opens from a file with no server', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'trace-file-'));
    cpSync(failingDir, copy, { recursive: true });
    const page = await open(`file://${copy}/index.html`);
    await expect(page.getByRole('heading', { level: 1 }).textContent()).resolves.toMatch(/panel appeared/);
    await page.context().close();
  });

  it('states the verdict in one sentence and shows the failure', async () => {
    const page = await open(failing.url);
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toMatch(/panel appeared 80 px away from trigger/);
    expect(await page.locator('.verdict').textContent()).toBe('Regression');
    expect(await time(page)).toBe(4000);
    await page.context().close();
  });

  it('names the requirement that failed and draws the measured gap on the build that failed', async () => {
    const page = await open(failing.url);
    expect(await page.locator('.broken-rule .broken-text').textContent()).toBe('panel appears at trigger or at its final position (within 4 px)');
    expect(await page.locator('.broken-rule code').textContent()).toBe('geometry-origin');
    const stages = page.locator('figure.stage');
    expect(await stages.nth(0).locator('.stage-outcome').textContent()).toBe('Holds');
    expect(await stages.nth(1).locator('.stage-outcome').textContent()).toBe('Fails here');
    expect(await stages.nth(1).locator('.gap-text').textContent()).toBe('80 px');
    expect(await stages.nth(0).locator('.gap-text').count()).toBe(0);
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('.gap-text').count()).toBe(0);
    await page.locator('.checks tr.is-broken .link').click();
    expect(await time(page)).toBe(4000);
    expect(await page.locator('.gap-text').count()).toBe(1);
    await page.context().close();
  });

  it('opens close on the failure, over the screenshot of that moment', async () => {
    const page = await open(failing.url, 1280, { reducedMotion: 'reduce' });
    const stages = page.locator('figure.stage');
    const box = async (i: number) => (await stages.nth(i).locator('svg').getAttribute('viewBox'))!.split(' ').map(Number);
    const close = await box(1);
    expect(close[2]).toBeLessThan(400);
    expect(await box(0)).toEqual(close);
    // Both builds have a screenshot taken just after the action at the failure, and each stage shows its own.
    expect(await stages.nth(0).locator('image').getAttribute('href')).toMatch(/^screenshots\/reduced-baseline-\d+\.png$/);
    expect(await stages.nth(1).locator('image').getAttribute('href')).toMatch(/^screenshots\/reduced-candidate-\d+\.png$/);
    expect(await stages.nth(1).locator('.stage-source dd').textContent()).toBe('screenshot at 4000 ms');
    const height = (await page.locator('.deck').boundingBox())!.height;
    // One sample on there is no screenshot, and the frame opens out to the whole action.
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('ArrowRight');
    expect(await stages.locator('image').count()).toBe(0);
    expect(await stages.nth(1).locator('.stage-source dd').textContent()).toBe('recorded rectangles');
    const action = await box(1);
    expect(action[2]).toBeGreaterThan(close[2]! + 100);
    expect(action[2]).toBeLessThan(900);
    expect(await box(0)).toEqual(action);
    // The frame holds still through the rest of the action.
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    expect(await box(1)).toEqual(action);
    await page.getByRole('button', { name: 'Show the whole window' }).click();
    expect((await box(1))[2]).toBe(1280);
    await page.getByRole('button', { name: 'Frame the tracked elements' }).click();
    expect(await box(1)).toEqual(action);
    expect((await page.locator('.deck').boundingBox())!.height).toBe(height);
    await page.context().close();
  });

  it('steps along the screenshots, and marks the one that shows the failure', async () => {
    const page = await open(failing.url);
    const frames = page.locator('.film .frame');
    expect(await frames.count()).toBeGreaterThan(4);
    expect(await page.locator('.film .frame[aria-current="true"] .frame-name').textContent()).toBe('failure');
    const names = await frames.locator('.frame-name').allTextContents();
    expect(names).toContain('resize to 920 × 640');
    // The screenshot taken as the clock reached the failure came before the action, and says so.
    expect(names.indexOf('before reopen')).toBe(names.indexOf('failure') - 1);
    expect(names.filter((n) => n === 'failure')).toHaveLength(1);
    await frames.nth(2).click();
    expect(await time(page)).toBe(3200);
    expect(await frames.nth(2).getAttribute('aria-current')).toBe('true');
    const hrefs = await page.locator('.film .crop image').evaluateAll((els) => els.map((el) => el.getAttribute('href')!));
    expect(hrefs.length).toBe(await frames.count());
    for (const href of hrefs) expect((await page.request.get(new URL(href, failing.url).href)).headers()['content-type']).toBe('image/png');
    // Under the tables, the pair of screenshots is the pair that shows the failure, with the whole window a click away.
    const pair = await page.locator('.shots .crop image').evaluateAll((els) => els.map((el) => el.getAttribute('href')!));
    expect(pair[1]).toBe(hrefs[names.indexOf('failure')]);
    expect(await page.locator('.shots a').first().getAttribute('href')).toBe(pair[0]);
    await page.context().close();
  });

  it('never shows a label that describes another session', async () => {
    const page = await open(failing.url);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    expect(await page.locator('main').textContent()).not.toMatch(/widen/);
    expect(await page.locator('.kept li').count()).toBe(14);
    expect(await page.locator('.kept .is-kept').allTextContents()).toEqual(['Kept: open', 'Kept: close with Escape', 'Kept: resize to 920 × 640', 'Kept: reopen']);
    await page.context().close();
  });

  it('changes the replay speed from a row of buttons', async () => {
    const page = await open(failing.url);
    expect(await page.getByRole('button', { name: '0.25x', pressed: true }).count()).toBe(1);
    await page.getByRole('button', { name: '1x', exact: true }).click();
    expect(await page.getByRole('button', { name: '1x', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await page.getByRole('button', { name: '0.25x' }).getAttribute('aria-pressed')).toBe('false');
    await page.context().close();
  });

  it('prints every fixed one-line string as one sentence with no closing period', async () => {
    const ends = /[.!?]\s*$/;
    for (const url of [failing.url, passing.url]) {
      const page = await open(url);
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
      const lines = await page.evaluate(() => {
        const own = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
        const whole = [...document.querySelectorAll('.lede, .note, .broken-text, .film-title, .legend li, .stage-outcome, .frame-name, .framing, .stage-source dd, .shots a, th, h2, .button, .facts dt')].map((el) => (el.textContent ?? '').trim());
        const cells = [...document.querySelectorAll('.checks td:first-child')].map(own);
        const labels = [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '');
        return [...whole, ...cells, ...labels].filter(Boolean);
      });
      expect(lines.length).toBeGreaterThan(40);
      expect(lines.filter((line) => ends.test(line))).toEqual([]);
      await page.context().close();
    }
    const page = await open(failing.url);
    expect(await page.locator('.lede').textContent()).toMatch(/, 4 actions, reduced from 14 and reproduced in 2 of 2 runs$/);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    expect(await page.locator('.note').allTextContents()).toEqual(expect.arrayContaining([
      'Supporting evidence from a separate diagnostic pass that did not decide the verdict',
      'The raw evidence is in report.json, and trace report regenerates this page from it',
    ]));
    expect(await page.locator('figure.stage svg').first().getAttribute('aria-label')).toBe('Baseline at 4000 ms, where panel is opening and focus is on name-input');
    await page.context().close();
  });

  it('makes a passing run as readable as a failure', async () => {
    const page = await open(passing.url);
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toMatch(/^Both builds met /);
    await expect(page.getByRole('columnheader', { name: 'Requirement' }).count()).resolves.toBe(1);
    expect(await page.locator('td.status-held').count()).toBeGreaterThan(0);
    expect(await page.locator('td.status-broken').count()).toBe(0);
    expect(await page.locator('.broken-rule').count()).toBe(0);
    expect(await page.locator('.stage-outcome').count()).toBe(0);
    await expect(page.getByRole('button', { name: 'Go to failure' }).count()).resolves.toBe(0);
    await page.context().close();
  });
});

describe('keyboard transport', () => {
  it('steps by action, jumps to the failure, and switches sequence', async () => {
    const page = await open(failing.url);
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('[');
    expect(await time(page)).toBe(3600);
    await page.keyboard.press('[');
    expect(await time(page)).toBe(3200);
    await page.keyboard.press(']');
    expect(await time(page)).toBe(3600);
    await page.keyboard.press('f');
    expect(await time(page)).toBe(4000);
    await page.keyboard.press('ArrowLeft');
    expect(await time(page)).toBe(3984);
    await page.keyboard.press('r');
    await page.getByRole('button', { name: /^Original \d+ actions$/, pressed: true }).waitFor();
    await page.context().close();
  });

  it('plays with Space and pauses with Space', async () => {
    const page = await open(failing.url);
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('[');
    const before = await time(page);
    await page.keyboard.press(' ');
    await page.waitForTimeout(400);
    await page.keyboard.press(' ');
    const after = await time(page);
    expect(after).toBeGreaterThan(before);
    await page.waitForTimeout(150);
    expect(await time(page)).toBe(after);
    await page.context().close();
  });

  it('leaves Space on a button to that button', async () => {
    const page = await open(failing.url);
    await page.getByRole('button', { name: 'Previous action' }).focus();
    const before = await time(page);
    await page.keyboard.press(' ');
    expect(await time(page)).toBeLessThan(before);
    await expect(page.getByRole('button', { name: 'Pause' }).count()).resolves.toBe(0);
    await page.context().close();
  });

  it('shows a visible focus indicator', async () => {
    const page = await open(failing.url);
    await page.getByRole('button', { name: 'Next action' }).focus();
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).toBe('solid');
    await page.context().close();
  });
});

describe('layout', () => {
  it.each(WIDTHS)('has no horizontal page scroll at %i px', async (width) => {
    const page = await open(failing.url, width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it('stays usable at 200 percent zoom, which is half the CSS width', async () => {
    const page = await open(failing.url, 640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Go to failure' }).click();
    await page.context().close();
  });

  it('stacks the two stages on a phone', async () => {
    const page = await open(failing.url, 390);
    const boxes = await page.locator('figure.stage').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(boxes[1]).toBeGreaterThan(boxes[0]! + 100);
    await page.context().close();
  });

  it('handles a tall touch target on the transport', async () => {
    const page = await open(failing.url, 390, { hasTouch: true });
    const height = await page.getByRole('button', { name: 'Next action' }).evaluate((e) => e.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(34);
    await page.getByRole('button', { name: 'Next action' }).tap();
    await page.context().close();
  });
});

describe('long labels and dense data', () => {
  it('survives very long names at 320 px, and a long original trace', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'trace-long-'));
    cpSync(failingDir, copy, { recursive: true });
    const { readFileSync, writeFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(join(copy, 'report.json'), 'utf8'));
    const long = 'a-rather-long-build-name-from-a-real-monorepo-package-scope-without-any-spaces-at-all';
    for (const c of data.cases) {
      c.baseline.label = long;
      c.candidate.label = `${long}-candidate`;
      c.scenario.id = long;
      c.comparison.sentence = `${long} ${c.comparison.sentence}`;
      for (const a of c.scenario.actions) a.note = long;
    }
    writeFileSync(join(copy, 'report.data.js'), `window.__TRACE_REPORT__=${JSON.stringify(data)};`);
    const server = await serveDirectory(copy);
    const page = await open(server.url, 320);
    await page.keyboard.press('r');
    await page.getByRole('button', { name: /^Original \d+ actions$/, pressed: true }).waitFor();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await page.locator('table').count()).toBeGreaterThanOrEqual(3);
    await page.context().close();
    await server.close();
  });
});

describe('reduced motion', () => {
  it('never starts on its own and says so', async () => {
    const page = await open(failing.url, 1280, { reducedMotion: 'reduce' });
    const before = await time(page);
    await page.waitForTimeout(300);
    expect(await time(page)).toBe(before);
    expect(await page.locator('.keys .keys-note').textContent()).toBe('Reduced motion is on, so nothing plays until you press Play');
    await page.context().close();
  });
});

describe('empty and error states', () => {
  it('explains an empty report and recovers from a bad file', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'trace-empty-'));
    cpSync(failingDir, empty, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(empty, 'report.data.js'), '');
    writeFileSync(join(empty, 'report.json'), '{"schema":"trace.report/1","cases":[]}');
    const server = await serveDirectory(empty);
    const page = await open(server.url);
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('No report loaded');
    await page.locator('input[type=file]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"nope"}') });
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toMatch(/not a Trace report/);
    const { readFileSync } = await import('node:fs');
    await page.locator('input[type=file]').setInputFiles({ name: 'r.json', mimeType: 'application/json', buffer: readFileSync(join(failingDir, 'report.json')) });
    await page.getByRole('heading', { level: 1, name: /panel appeared/ }).waitFor();
    await page.context().close();
    await server.close();
  });
});

describe('automated accessibility checks', () => {
  it.each([['failing', () => failing.url], ['passing', () => passing.url]] as const)('finds no serious issues on the %s report', async (_n, url) => {
    const page = await open(url());
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
    await page.context().close();
  });
});
