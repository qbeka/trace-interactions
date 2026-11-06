import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, CDPSession, Locator, Page } from 'playwright';
import type { RecorderConfig } from '../recorder/recorder.ts';
import type { Action, Point, Scenario, Target } from '../scenario/schema.ts';
import { InvalidScenario, staticProblem } from '../scenario/validate.ts';
import { TRACE_SCHEMA, type ClockReport, type PendingEvent, type RunResult, type Screenshot, type TraceEvent } from '../trace/types.ts';
import { evaluate } from '../oracle/oracle.ts';

/** Time sources that neither mode holds still. Reported on every run. */
const UNCONTROLLED = [
  'ResizeObserver and IntersectionObserver delivery (real rendering steps)',
  'React scheduler tasks (MessageChannel)',
  'Web Workers',
  'Compositor-driven scrolling and native smooth scroll',
  'Scroll-driven animation timelines',
  'Media playback',
  'Network',
  'Rasterization',
];

/** Virtual ms spent proving the clock before a run starts. */
const CLOCK_PROBE_MS = 16;
const ACTION_TIMEOUT_MS = 1_000;

const recorderSource = (): string => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'recorder.js');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Installed package layout: recorder.js sits beside cli.js.
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'recorder.js'), 'utf8');
  }
};

export interface RunOptions {
  browser: Browser;
  url: string;
  scenario: Scenario;
  stateAllowlist: string[];
  /** Overrides the scenario's timing mode. */
  mode?: 'controlled' | 'wall';
  /** `stamps` is the low-overhead performance pass. It records no trace. */
  recording?: 'full' | 'stamps';
  /** Saves screenshots to this directory. Never set during a performance pass. */
  screenshots?: { dir: string; prefix: string; times?: number[] };
  /** Disables the idle jump. Used by the test that proves the jump changes nothing. */
  everyTick?: boolean;
}

export interface RunOutput extends RunResult {
  latency: unknown[];
  metrics: Record<string, number> | null;
}

export function browserKind(browser: Browser): string {
  return browser.browserType().name();
}

function locate(page: Page, name: string, targets: Scenario['targets']): Locator {
  const t: Target | undefined = targets[name];
  if (!t) throw new InvalidScenario(`unknown target "${name}"`);
  if (t.role) return page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name, exact: true } : {});
  return page.locator(`[data-trace-id="${t.traceId}"]`);
}

/** A failed selector is a scenario problem. It never counts as a regression. */
async function requireTarget(page: Page, name: string, targets: Scenario['targets'], index: number): Promise<Locator> {
  const loc = locate(page, name, targets);
  const count = await loc.count();
  if (count === 0) throw new InvalidScenario(`target "${name}" is not on the page`, index);
  if (count > 1) throw new InvalidScenario(`target "${name}" matches ${count} elements`, index);
  if (!(await loc.isVisible())) throw new InvalidScenario(`target "${name}" is not visible`, index);
  return loc;
}

async function resolvePoint(page: Page, point: Point, targets: Scenario['targets'], index: number): Promise<{ x: number; y: number }> {
  if (point.space === 'viewport-px') return { x: point.x, y: point.y };
  const box = await (await requireTarget(page, point.target, targets, index)).boundingBox();
  if (!box) throw new InvalidScenario(`target "${point.target}" has no box`, index);
  return { x: box.x + box.width * point.x, y: box.y + box.height * point.y };
}

/** Sends real touch input through CDP so a cancel is a browser cancel. Chromium only. */
class TouchInput {
  private constructor(private cdp: CDPSession) {}
  static async open(page: Page): Promise<TouchInput> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    return new TouchInput(cdp);
  }
  down(p: { x: number; y: number }) {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  }
  move(p: { x: number; y: number }) {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
  }
  up() {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  cancel() {
    return this.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  }
}

function describe(a: Action): string {
  switch (a.type) {
    case 'focus':
    case 'activate':
      return `${a.type} ${a.target}`;
    case 'type':
      return `type ${a.text.length} chars into ${a.target}`;
    case 'press':
      return `press ${a.key}`;
    case 'resize':
      return `resize to ${a.width}x${a.height}`;
    case 'scroll':
      return `scroll ${a.target} to ${a.top}`;
    case 'requestState':
      return `request ${Object.entries(a.state).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    case 'waitFor':
      return `wait for ${Object.entries(a.state).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    default:
      return a.type;
  }
}

export async function runScenario(opts: RunOptions): Promise<RunOutput> {
  const { browser, url, scenario, stateAllowlist } = opts;
  const problem = staticProblem(scenario);
  const mode = opts.mode ?? scenario.timing.mode;
  const recording = opts.recording ?? 'full';
  const uncontrolled = mode === 'controlled' ? UNCONTROLLED : ['All time sources run in real time'];
  const emptyClock: ClockReport = { mode, verified: {}, uncontrolled, used: [] };
  const invalidResult = (reason: string, actionIndex: number | null, events: TraceEvent[] = []): RunOutput => ({
    schema: TRACE_SCHEMA,
    status: 'invalid',
    invalid: { reason, actionIndex },
    events,
    violations: [],
    clock: emptyClock,
    screenshots: [],
    durationMs: 0,
    latency: [],
    metrics: null,
  });
  if (problem) return invalidResult(problem.reason, problem.actionIndex);

  const started = performance.now();
  const kind = browserKind(browser);
  // A real pointer cancel exists only through CDP touch. See docs/RESEARCH.md.
  const useTouch = kind === 'chromium' && scenario.actions.some((a) => a.type === 'pointerCancel');
  const context = await browser.newContext({
    viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
    deviceScaleFactor: scenario.viewport.deviceScaleFactor,
    hasTouch: useTouch,
    // A fixture must never reach the network, so a stray request cannot change a run.
    serviceWorkers: 'block',
  });
  const screenshots: Screenshot[] = [];
  let metrics: Record<string, number> | null = null;
  let cdpMetrics: CDPSession | null = null;

  try {
    // Order matters, and all three go on the context. This script must run before
    // the clock replaces the timing functions, so the recorder keeps a real frame
    // source. On Firefox and WebKit a page-level script runs after the clock.
    await context.addInitScript(
      ({ seed, init }) => {
        const w = window as unknown as Record<string, unknown>;
        w.__traceReal = {
          raf: window.requestAnimationFrame.bind(window),
          setTimeout: window.setTimeout.bind(window),
        };
        w.__traceSeed = seed;
        w.__traceInit = init;
      },
      { seed: scenario.seed, init: scenario.initialState },
    );
    if (mode === 'controlled') {
      await context.clock.install({ time: 0 });
      await context.clock.pauseAt(1000);
    }
    await context.addInitScript({ content: recorderSource() });

    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    await page.route(/^https?:/, (route) => {
      const u = new URL(route.request().url());
      return u.origin === new URL(url).origin ? route.continue() : route.abort();
    });

    await page.goto(url, { waitUntil: 'load' });
    const adapter = await page
      .waitForFunction(() => {
        const a = window.__traceFixture;
        return a ? { id: a.id, version: a.version } : null;
      }, undefined, { timeout: 5_000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (!adapter) return invalidResult('the page has no window.__traceFixture adapter', null);
    if (adapter.id !== scenario.fixture.id || adapter.version !== scenario.fixture.version) {
      return invalidResult(
        `scenario expects fixture ${scenario.fixture.id} v${scenario.fixture.version}, the page is ${adapter.id} v${adapter.version}`,
        null,
      );
    }

    const config: RecorderConfig = {
      mode,
      recording,
      targets: Object.entries(scenario.targets).flatMap(([name, t]) => (t.traceId ? [{ name, traceId: t.traceId }] : [])),
      relations: scenario.requirements.flatMap((r) =>
        r.kind === 'relationship-resolves'
          ? [{ from: r.from, fromTraceId: scenario.targets[r.from]!.traceId!, attribute: r.attribute }]
          : [],
      ),
      stateAllowlist,
    };
    await page.evaluate((c) => window.__trace.configure(c), config);

    // In controlled mode, prove each source obeys the clock before relying on it.
    let verified: Record<string, boolean> = {};
    if (mode === 'controlled') {
      await page.evaluate(() => void window.__trace.clockProbeStart());
      await page.clock.runFor(CLOCK_PROBE_MS);
      verified = await page.evaluate((ms) => window.__trace.clockProbeEnd(ms), CLOCK_PROBE_MS);
      if (Object.values(verified).some((ok) => !ok)) {
        const failed = Object.entries(verified).filter(([, ok]) => !ok).map(([k]) => k).join(', ');
        return { ...invalidResult(`the clock contract failed for: ${failed}`, null), clock: { ...emptyClock, verified } };
      }
    }

    if (kind === 'chromium' && recording !== 'full' || (kind === 'chromium' && mode === 'wall')) {
      cdpMetrics = await context.newCDPSession(page);
      await cdpMetrics.send('Performance.enable');
    }

    const mark = (e: PendingEvent): Promise<void> => page.evaluate((m) => window.__trace.mark(m), e);

    await page.evaluate(() => window.__trace.start());
    await mark({ k: 'viewport', width: scenario.viewport.width, height: scenario.viewport.height });
    await page.evaluate(() => window.__trace.settle());
    // The count before any action. `resources-released` compares against this.
    await page.evaluate(() => window.__trace.checkpoint());

    const stepMs = scenario.timing.stepMs;
    const wallStart = performance.now();
    let now = 0; // scenario time reached so far
    let tick = 0;

    const capture = async (label: string): Promise<void> => {
      if (!opts.screenshots) return;
      const name = `${opts.screenshots.prefix}-${String(screenshots.length).padStart(3, '0')}.png`;
      await page.screenshot({ path: join(opts.screenshots.dir, name), animations: 'allow', caret: 'hide' });
      screenshots.push({ label, tick, t: now, path: name });
    };

    const advanceTo = async (time: number): Promise<void> => {
      if (mode === 'wall') {
        const wait = time - (performance.now() - wallStart);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        now = Math.max(now, time);
        return;
      }
      const stops = opts.screenshots?.times ?? [];
      let activity: { busy: boolean; nextDue: number | null } = { busy: true, nextDue: null };
      while (now < time) {
        // While idle, jump to the next due timer. Nothing else can change the page.
        let step = stepMs;
        if (!activity.busy && !opts.everyTick) {
          const due = activity.nextDue !== null && activity.nextDue > now ? activity.nextDue : Infinity;
          step = Math.max(stepMs, Math.min(due, time) - now);
        }
        step = Math.min(step, time - now);
        const stop = stops.find((t) => t > now && t < now + step);
        if (stop !== undefined) step = stop - now;
        await page.clock.runFor(step);
        now += step;
        tick += 1;
        activity = await page.evaluate(() => window.__trace.tick());
        if (stops.includes(now)) await capture(`at ${now} ms`);
      }
    };

    let touch: TouchInput | null = null;
    let pointer = { x: 0, y: 0 };

    const perform = async (a: Action, index: number): Promise<void> => {
      switch (a.type) {
        case 'focus':
          await (await requireTarget(page, a.target, scenario.targets, index)).focus();
          break;
        case 'type':
          await (await requireTarget(page, a.target, scenario.targets, index)).pressSequentially(a.text);
          break;
        case 'activate':
          await (await requireTarget(page, a.target, scenario.targets, index)).click({ timeout: ACTION_TIMEOUT_MS });
          break;
        case 'press':
          if (a.target) await (await requireTarget(page, a.target, scenario.targets, index)).focus();
          await page.keyboard.press(a.key);
          break;
        case 'pointerDown':
          pointer = await resolvePoint(page, a.point, scenario.targets, index);
          if (useTouch) {
            touch ??= await TouchInput.open(page);
            await touch.down(pointer);
          } else {
            await page.mouse.move(pointer.x, pointer.y);
            await page.mouse.down();
          }
          break;
        case 'pointerMove':
          pointer = await resolvePoint(page, a.point, scenario.targets, index);
          if (touch) await touch.move(pointer);
          else await page.mouse.move(pointer.x, pointer.y);
          break;
        case 'pointerUp':
          if (touch) await touch.up();
          else await page.mouse.up();
          break;
        case 'pointerCancel':
          if (touch) await touch.cancel();
          else {
            // Firefox and WebKit have no input path for a cancel. This fires the
            // event, releases capture as the spec requires, and swallows the
            // following mouse up so a later `pointerup` cannot hide the bug.
            await page.evaluate(() => window.__trace.syntheticCancel());
            await page.mouse.up();
          }
          break;
        case 'resize':
          await page.setViewportSize({ width: a.width, height: a.height });
          await mark({ k: 'viewport', width: a.width, height: a.height });
          break;
        case 'scroll':
          await (await requireTarget(page, a.target, scenario.targets, index)).evaluate((el, top) => {
            el.scrollTop = top;
          }, a.top);
          break;
        case 'requestState':
          await page.evaluate((s) => window.__traceFixture?.request?.(s), a.state);
          break;
        case 'waitFor': {
          const deadline = now + a.timeoutMs;
          const holds = () => page.evaluate((want) => {
            const have = window.__trace.state();
            return Object.entries(want).every(([k, v]) => have[k] === v);
          }, a.state);
          while (!(await holds())) {
            if (now >= deadline) {
              await mark({ k: 'wait-timeout', index });
              break;
            }
            await advanceTo(now + (mode === 'wall' ? 8 : stepMs));
          }
          break;
        }
      }
    };

    const runList = async (actions: Action[], cleanup: boolean, offset: number): Promise<boolean> => {
      for (const [index, a] of actions.entries()) {
        await advanceTo(offset + a.at);
        if (a.requires) {
          const have = await page.evaluate(() => window.__trace.state());
          for (const [key, value] of Object.entries(a.requires)) {
            if (have[key] !== value) {
              throw new InvalidScenario(`requires ${key}=${value}, found ${have[key] ?? 'nothing'}`, index);
            }
          }
        }
        const label = a.note ?? describe(a);
        await mark({ k: 'action', phase: 'start', index, cleanup, type: a.type, label });
        try {
          await perform(a, index);
        } catch (error) {
          throw notActionable(error, index) ?? error;
        }
        await page.evaluate(() => window.__trace.settle());
        for (const r of scenario.requirements) {
          if (r.kind !== 'single-interactive') continue;
          const t = scenario.targets[r.target]!;
          if (!t.role) continue;
          const matches = await locate(page, r.target, scenario.targets).count();
          await mark({ k: 'a11y', target: r.target, matches });
        }
        await mark({ k: 'action', phase: 'end', index, cleanup, type: a.type, label });
        await page.evaluate(() => window.__trace.checkpoint());
        await capture(label);
      }
      return true;
    };

    try {
      await capture('start');
      await runList(scenario.actions, false, 0);
      const mainEnd = (scenario.actions.at(-1)?.at ?? 0) + scenario.timing.settleMs;
      await advanceTo(mainEnd);
      await capture('settled');
      await runList(scenario.cleanup, true, mainEnd);
      await advanceTo(mainEnd + (scenario.cleanup.at(-1)?.at ?? 0) + (scenario.cleanup.length ? scenario.timing.settleMs : 0));
    } catch (error) {
      if (!(error instanceof InvalidScenario)) throw error;
      const invalid = error;
      const partial = await page.evaluate(() => window.__trace.drain());
      return { ...invalidResult(invalid.reason, invalid.actionIndex, partial as TraceEvent[]), clock: { ...emptyClock, verified } };
    }

    await page.evaluate(() => {
      window.__trace.checkpoint();
      window.__trace.stop();
    });
    if (cdpMetrics) {
      const { metrics: raw } = await cdpMetrics.send('Performance.getMetrics');
      metrics = Object.fromEntries(raw.map((m) => [m.name, m.value]));
    }
    const events = (await page.evaluate(() => window.__trace.drain())) as TraceEvent[];
    const latency = await page.evaluate(() => window.__trace.latency());
    const used = await page.evaluate(() => window.__trace.usedChannels());
    return {
      schema: TRACE_SCHEMA,
      status: 'completed',
      invalid: null,
      events,
      violations: recording === 'full' ? evaluate(scenario, events) : [],
      clock: { mode, verified, uncontrolled, used },
      screenshots,
      durationMs: Math.round(performance.now() - started),
      latency,
      metrics,
    };
  } finally {
    await context.close();
  }
}

/** Something covering the target, or a page that never lets it settle, is a scenario problem. */
function notActionable(error: unknown, index: number): InvalidScenario | null {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new InvalidScenario(`not actionable: ${error.message.split('\n')[0]}`, index);
  }
  return null;
}
