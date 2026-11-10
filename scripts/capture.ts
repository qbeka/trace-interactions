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

// Cover, from the project page, held on the first frame of the failure with motion off.
if (!process.argv.includes('--only')) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${demo.url}index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => { const stage = document.getElementById('stage')!; return stage.dataset.rows === stage.dataset.cells; });
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

/** `--only trace-walkthrough` records that one clip and leaves the cover and the other clip as they are. */
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

async function record(name: string, run: (page: Page) => Promise<void>): Promise<void> {
  if (only && only !== name) return;
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

// The signature interaction, 20 to 30 seconds, on the project page.
await record('trace-demo', async (page) => {
  await page.goto(`${demo.url}index.html`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.waitForFunction(() => { const stage = document.getElementById('stage')!; return stage.dataset.rows === stage.dataset.cells; });
  await pause(page, 2200);
  // Hold the stage on the first frame of the failure, then move the scan line up through the
  // Inspect button and back down, and the cores are cut again.
  await page.locator('#time').focus();
  await page.keyboard.press('f');
  await pause(page, 600);
  const pane = (await page.locator('#pane-bad').boundingBox())!;
  const [, top, , tall] = (await page.locator('#marks-bad').getAttribute('viewBox'))!.split(' ').map(Number);
  const lineY = (row: number) => pane.y + ((row - top!) / tall!) * pane.height;
  const glide = async (x: number, from: number, to: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      await page.mouse.move(x, from + (to - from) * (p * p * (3 - 2 * p)));
      await pause(page, 24);
    }
  };
  await page.mouse.move(pane.x + pane.width * 0.2, lineY(84));
  await page.mouse.down();
  await glide(pane.x + pane.width * 0.2, lineY(84), lineY(34), 38);
  await pause(page, 500);
  await glide(pane.x + pane.width * 0.2, lineY(34), lineY(116), 44);
  await pause(page, 300);
  await glide(pane.x + pane.width * 0.2, lineY(116), lineY(84), 26);
  await page.mouse.up();
  await pause(page, 400);
  // Drag down the broken build's core, which moves through time, and come to rest in the jump.
  const core = (await page.locator('#core-bad').boundingBox())!;
  const rowY = (row: number) => core.y + ((row + 0.5) / 89) * core.height;
  await page.mouse.move(core.x + core.width * 0.3, rowY(0));
  await page.mouse.down();
  await glide(core.x + core.width * 0.3, rowY(0), rowY(88), 70);
  await glide(core.x + core.width * 0.3, rowY(88), rowY(73), 24);
  await page.mouse.up();
  await pause(page, 700);
  await page.getByRole('button', { name: 'Difference', exact: true }).click();
  await pause(page, 1500);
  await page.getByRole('button', { name: 'Geometry', exact: true }).click();
  await pause(page, 1500);
  await page.getByRole('button', { name: 'Screenshots', exact: true }).click();
  await pause(page, 400);
  // The search plays when it is opened, and ends on the four steps that are left.
  await page.getByRole('button', { name: 'The search', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.a-column.on').length === 26, undefined, { timeout: 15000 });
  await pause(page, 900);
  await page.getByRole('button', { name: 'Play the four steps', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#play span.on')!.textContent === 'Replay', undefined, { timeout: 20000 });
  await pause(page, 700);
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
  // Bring the two stages up under the bar at the top, so the caption does not cover them.
  await page.evaluate(() => window.scrollTo({ top: document.querySelector('.deck')!.getBoundingClientRect().top + scrollY - 68, behavior: 'smooth' }));
  await caption(page, 'Both stages open close on the failure, with the recorded rectangles drawn over a screenshot of the same moment');
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
