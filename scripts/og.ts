import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveDirectory } from '../src/runner/static.ts';

/**
 * Draws the share card, `demo/og.png`: the name, the one sentence, and the two
 * slit scans of the recorded session, cut from the real frames. Run `pnpm page`
 * first, since the card reads the page's own data block.
 */
const root = resolve(import.meta.dirname, '..');
const demo = resolve(process.argv[2] ?? join(root, 'demo'));
const page = readFileSync(join(demo, 'index.html'), 'utf8');
const data = /<script id="trace-data" type="application\/json">(.*?)<\/script>/s.exec(page)?.[1];
const sentence = /<meta name="description" content="([^"]*)">/.exec(page)?.[1];
if (!data || !sentence) throw new Error('Build the page first: pnpm page');

const script = await build({ entryPoints: [join(root, 'site/og.ts')], bundle: true, format: 'iife', target: 'es2022', write: false, logLevel: 'warning' });
const server = await serveDirectory(demo);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@font-face { font-family: 'Geist Serif'; src: url('${server.url}fonts/GeistSerif-Regular.woff2') format('woff2'); }
@font-face { font-family: 'Geist'; src: url('${server.url}fonts/Geist-Regular.woff2') format('woff2'); }
* { box-sizing: border-box; }
html, body { margin: 0; width: 1200px; height: 630px; background: #ffffff; color: #111511; -webkit-font-smoothing: antialiased; }
body { display: grid; grid-template-columns: 470px 1fr; padding: 60px 64px 60px 72px; column-gap: 40px; }
.words { display: flex; flex-direction: column; justify-content: center; padding-bottom: 20px; }
h1 { margin: 0; font: 400 164px/150px 'Geist Serif', serif; letter-spacing: -0.04em; }
p { margin: 22px 0 0; font: 400 50px/58px 'Geist Serif', serif; letter-spacing: -0.015em; color: #444944; text-wrap: balance; }
.art { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto 1fr; gap: 12px 18px; min-height: 0; }
.name { display: flex; align-items: center; gap: 12px; font: 400 26px/32px 'Geist', sans-serif; color: #111511; }
.name i { width: 22px; border-top: 4px solid #1d3a2a; }
.name.bad i { border-color: #b4561a; }
.core { position: relative; min-height: 0; border-radius: 12px; overflow: hidden; background: repeating-linear-gradient(135deg, transparent 0 9px, #1115110a 9px 11px), #efede7; box-shadow: inset 0 0 0 1.5px #1115112e; }
.core canvas, .core svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; image-rendering: pixelated; }
.core::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1.5px #1115112e; }
.ghost { fill: none; stroke: #1d3a2a; stroke-width: 2.5; stroke-dasharray: 6 5; }
.edge { fill: none; stroke: #b4561a; stroke-width: 3.5; }
.span { fill: none; stroke: #b4561a; stroke-width: 4; }
</style></head><body>
<div class="words"><h1>Trace</h1><p>${sentence}</p></div>
<div class="art">
  <span class="name"><i></i>Last good build</span><span class="name bad"><i></i>Broken build</span>
  <div class="core"><canvas id="good"></canvas></div>
  <div class="core"><canvas id="bad"></canvas><svg id="marks"></svg></div>
</div>
<script>const __OG__ = { data: ${data}, base: ${JSON.stringify(server.url)} };</script>
<script>${script.outputFiles[0]!.text.replace(/<\/script/g, '<\\/script')}</script>
</body></html>`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const tab = await context.newPage();
// The card is laid out on the demo's own origin, so its script may read the frames.
await tab.route(`${server.url}og-card`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
await tab.goto(`${server.url}og-card`);
await tab.evaluate(() => document.fonts.ready);
await tab.waitForFunction(() => document.body.dataset.ready !== undefined, undefined, { timeout: 60_000 });
const ready = await tab.evaluate(() => document.body.dataset.ready);
if (ready !== 'true') throw new Error(`The card could not be drawn: ${ready}`);
writeFileSync(join(demo, 'og.png'), await tab.screenshot({ type: 'png' }));
await browser.close();
await server.close();
console.log(`Share card written to ${join(demo, 'og.png')}`);
