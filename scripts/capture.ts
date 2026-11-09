import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { serveDirectory } from '../src/runner/static.ts';

/**
 * Captures the cover and two screen recordings from the real demo.
 * Run `pnpm demo` first. Needs ffmpeg for the mp4 files. Captions on the
 * walkthrough exist only in this script, never in the product. Each caption is
 * one whole sentence with no closing period, and the check below holds them to it.
 */
const root = resolve(import.meta.dirname, '..');
const assets = join(root, 'docs/assets');
mkdirSync(assets, { recursive: true });
const demo = await serveDirectory(join(root, 'demo'));
const fixture = await serveDirectory(join(root, '.build/fixtures/inspector/stale-origin'));
const browser = await chromium.launch();
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function seek(page: Page, ms: number): Promise<void> {
  await page.locator('input[type=range]').evaluate((el: HTMLInputElement, value) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, ms);
}

// Cover, from the project page, held two frames into the failure with motion off.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${demo.url}index.html?t=4032`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelectorAll('.cell.ready').length === document.querySelectorAll('.cell').length);
  await pause(page, 400);
  await page.screenshot({ path: join(assets, 'cover.png') });
  await context.close();
}
if (process.argv.includes('--cover')) {
  await browser.close();
  await demo.close();
  await fixture.close();
  process.exit(0);
}

async function record(name: string, run: (page: Page) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-video-'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  await run(page);
  await context.close();
  const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))!);
  copyFileSync(file, join(assets, `${name}.webm`));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-movflags', '+faststart', join(assets, `${name}.mp4`)]);
}

async function caption(page: Page, text: string): Promise<void> {
  // A full stop, a question mark or an exclamation mark anywhere means more than one sentence, or a closing mark.
  if (/[.!?]/.test(text.replace(/\d+\.\d+/g, ''))) throw new Error(`A caption must be one sentence with no closing period: ${text}`);
  await page.evaluate((t) => {
    let el = document.getElementById('capture-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'capture-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:880px;padding:10px 18px;background:#121412;color:#fff;font:17px/1.4 Geist Serif,Georgia,serif;border-radius:10px;z-index:99;text-align:center';
      document.body.append(el);
    }
    el.textContent = t;
  }, text);
}

// The signature interaction, 15 to 25 seconds, on the project page.
await record('trace-demo', async (page) => {
  await page.goto(`${demo.url}index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await pause(page, 2600);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 20000 });
  await pause(page, 500);
  await page.getByRole('button', { name: 'Difference', exact: true }).click();
  await page.locator('#jump').click();
  await pause(page, 1500);
  // Drag the film through the failure by hand, there and back.
  const film = (await page.locator('#film').boundingBox())!;
  const y = film.y + film.height / 2;
  const x = film.x + film.width / 2;
  await page.mouse.move(x + 300, y);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(x + 300 - i * 14, y);
    await pause(page, 30);
  }
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(x - 540 + i * 12, y);
    await pause(page, 30);
  }
  await pause(page, 200);
  await page.mouse.up();
  await pause(page, 900);
  await page.getByRole('button', { name: 'Geometry', exact: true }).click();
  await pause(page, 1600);
  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await page.locator('#reduce-play').click();
  await pause(page, 4200);
});

// The technical walkthrough, 60 to 90 seconds, with captions and no voice.
await record('trace-walkthrough', async (page) => {
  await page.goto(fixture.url);
  await page.waitForLoadState('load');
  await caption(page, 'This small inspector panel looks right when you open it, close it, resize the window and open it again');
  await pause(page, 3500);
  await page.getByRole('button', { name: 'Inspect' }).click();
  await pause(page, 1500);
  await page.getByRole('button', { name: 'Done' }).click();
  await pause(page, 1000);
  await page.setViewportSize({ width: 1100, height: 720 });
  await pause(page, 800);
  await page.getByRole('button', { name: 'Inspect' }).click();
  await caption(page, 'The bug is in the first frames of that last open, so the final screenshot looks fine');
  await pause(page, 5000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${demo.url}regression/index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await caption(page, 'Trace replayed 14 actions on two builds and says what broke in plain words at the top of the report');
  await pause(page, 7000);
  await page.evaluate(() => window.scrollTo({ top: 170, behavior: 'smooth' }));
  await caption(page, 'Both stages are drawn from recorded rectangles on one virtual clock, with the same actions at the same times');
  await pause(page, 7000);
  await page.getByRole('button', { name: '0.1x' }).click();
  await seek(page, 3990);
  await page.getByRole('button', { name: /Play|Replay/ }).click();
  await caption(page, 'The trail shows the path the panel took, and the candidate starts 80 px away from its trigger');
  await pause(page, 7000);
  await page.getByRole('button', { name: 'Go to failure' }).click();
  await caption(page, 'The requirement is written in the scenario, so a bug that both builds share still fails');
  await pause(page, 6000);
  await page.locator('h2', { hasText: 'What was checked' }).scrollIntoViewIfNeeded();
  await caption(page, 'Each requirement names what held, and nothing is compared to an old screenshot');
  await pause(page, 7000);
  await page.locator('h2', { hasText: 'Reduction' }).scrollIntoViewIfNeeded();
  await caption(page, 'The reducer only deletes actions, keeps the same failure, confirms it and checks that the baseline still passes');
  await pause(page, 8000);
  await page.keyboard.press('r');
  await pause(page, 300);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await caption(page, 'R switches to the original 14 action session, and the report is still one static folder');
  await pause(page, 6000);
  await page.goto(`${demo.url}fixed/index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await caption(page, 'After the fix, the same reduced scenario reports the bug as gone');
  await pause(page, 6000);
});

await browser.close();
await demo.close();
await fixture.close();
console.log(`Captured to ${assets}`);
