import { chromium, type Browser, type Page } from 'playwright';
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

async function open(path: string, width = 1280): Promise<{ page: Page; problems: string[]; external: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  const problems: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) external.push(r.url()); });
  await page.goto(`${server.url}${path}`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  return { page, problems, external };
}

const clock = (page: Page) => page.locator('#clock').textContent();

describe('project page', () => {
  it('opens on the recorded failure, with no errors and no outside requests', async () => {
    const { page, problems, external } = await open('index.html');
    expect(await page.locator('#verdict').textContent()).toMatch(/Panel appeared 80 px away from trigger at 4000 ms/);
    expect(await page.locator('.stage').count()).toBe(2);
    expect(problems).toEqual([]);
    expect(external).toEqual([]);
    await page.context().close();
  });

  it('plays from the start, and the opening still does not skip the setup', async () => {
    const { page } = await open('index.html');
    await page.locator('#speed').selectOption('1');
    await page.locator('#play').click();
    expect(await page.locator('#play').textContent()).toBe('Pause');
    await page.waitForFunction(() => document.getElementById('play')!.textContent === 'Replay', undefined, { timeout: 8000 });
    expect(await clock(page)).toMatch(/^4240 ms of 4240 ms$/);
    await page.context().close();
  });

  it('switches recordings, and each action seeks', async () => {
    const { page } = await open('index.html');
    await page.getByRole('button', { name: /Original, 14 actions/ }).click();
    expect(await page.locator('#steps button').count()).toBe(14);
    await page.locator('#steps button').first().click();
    expect(await clock(page)).toMatch(/^0 ms of/);
    await page.getByRole('button', { name: 'Go to the failure' }).click();
    expect(await clock(page)).toMatch(/^4048 ms of/);
    await page.getByRole('button', { name: 'After the fix' }).click();
    expect(await page.locator('#verdict').getAttribute('class')).toContain('good');
    expect(await page.locator('.stage.is-failing figcaption').textContent()).toContain('Baseline');
    await page.context().close();
  });

  it('reads its numbers from saved runs', async () => {
    const { page } = await open('index.html');
    const tiles = await page.locator('.tile b').allTextContents();
    expect(tiles).toEqual(['18 of 18', '0 of 13', '1 of 4', '14 to 4']);
    await page.context().close();
  });

  it('fits a phone with no sideways scroll', async () => {
    const { page } = await open('index.html', 360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.context().close();
  });

  it('links to reports that exist, with or without a trailing slash', async () => {
    const { page } = await open('index.html');
    const links = await page.locator('footer a').evaluateAll((all) => all.map((a) => a.getAttribute('href')!));
    const local = links.filter((href) => !href.startsWith('http'));
    expect(local).toHaveLength(2);
    for (const href of local) {
      const name = href.replace(/^.*\/(regression|fixed)\//, '$1/');
      expect(existsSync(join(root, 'demo', name))).toBe(true);
    }
    await page.context().close();
  });
});
