import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { InvalidScenario } from '../scenario/validate.ts';
import { serveDirectory } from './static.ts';

const Build = z.union([
  z.strictObject({ dir: z.string() }),
  z.strictObject({ url: z.string() }),
  // Runs a command the user wrote in their own registered manifest, and nothing else.
  z.strictObject({ command: z.array(z.string()).min(1), url: z.string(), cwd: z.string().optional() }),
]);

export const FixtureManifest = z.strictObject({
  schema: z.literal('trace.fixture/1'),
  id: z.string(),
  version: z.string(),
  /** State keys the recorder may keep. Everything else stays in the page. */
  stateAllowlist: z.array(z.string()),
  clock: z.strictObject({ channels: z.array(z.enum(['timers', 'frames', 'animations', 'date', 'performance'])) }),
  source: z.string().optional(),
  builds: z.record(z.string(), Build),
});
export type FixtureManifest = z.infer<typeof FixtureManifest>;

export const Registry = z.strictObject({
  schema: z.literal('trace.registry/1'),
  fixtures: z.array(z.strictObject({ id: z.string(), manifest: z.string() })),
});

export const REGISTRY_FILE = 'trace.fixtures.json';

export interface LoadedFixture {
  manifest: FixtureManifest;
  root: string;
}

export function loadFixture(manifestPath: string): LoadedFixture {
  const path = resolve(manifestPath);
  const manifest = FixtureManifest.parse(JSON.parse(readFileSync(path, 'utf8')));
  // Build paths in a repository manifest are relative to the repository root.
  const root = manifest.source ? path.slice(0, -`${manifest.source}/fixture.json`.length) || dirname(path) : dirname(path);
  return { manifest, root };
}

export function loadRegistry(file: string): Map<string, LoadedFixture> {
  const out = new Map<string, LoadedFixture>();
  if (!existsSync(file)) return out;
  const registry = Registry.parse(JSON.parse(readFileSync(file, 'utf8')));
  const base = dirname(resolve(file));
  for (const entry of registry.fixtures) {
    out.set(entry.id, loadFixture(isAbsolute(entry.manifest) ? entry.manifest : resolve(base, entry.manifest)));
  }
  return out;
}

/** Trace drives a browser at a URL, so it refuses anything off this machine. */
export function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new InvalidScenario(`refusing ${host}: Trace only tests builds served from this machine`);
  }
}

export interface ServedBuild {
  label: string;
  url: string;
  stop(): Promise<void>;
}

/** Resolves `fixture@build` to a running local URL. */
export async function serveBuild(fixture: LoadedFixture, build: string): Promise<ServedBuild> {
  const entry = fixture.manifest.builds[build];
  const label = `${fixture.manifest.id}@${build}`;
  if (!entry) throw new InvalidScenario(`fixture ${fixture.manifest.id} has no build "${build}"`);
  if ('dir' in entry) {
    const dir = resolve(fixture.root, entry.dir);
    if (!existsSync(dir)) throw new InvalidScenario(`${label} is not built. Expected ${dir}`);
    const server = await serveDirectory(dir);
    return { label, url: server.url, stop: server.close };
  }
  assertLoopback(entry.url);
  if ('url' in entry && !('command' in entry)) return { label, url: entry.url, stop: async () => {} };
  const child = launch(entry.command, entry.cwd ? resolve(fixture.root, entry.cwd) : fixture.root);
  await waitForUrl(entry.url, child);
  return {
    label,
    url: entry.url,
    stop: async () => {
      child.kill('SIGTERM');
    },
  };
}

function launch(command: string[], cwd: string): ChildProcess {
  const [bin, ...args] = command;
  return spawn(bin!, args, { cwd, stdio: 'ignore' });
}

async function waitForUrl(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the launch command exited with code ${child.exitCode}`);
    const ok = await fetch(url).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`${url} did not answer within 30 s`);
}

/** Splits `inspector@correct`. A URL is passed through for `--baseline-url` style use. */
export function parseBuildRef(ref: string): { fixture: string; build: string } {
  const at = ref.indexOf('@');
  if (at < 1) throw new InvalidScenario(`expected fixture@build, got "${ref}"`);
  return { fixture: ref.slice(0, at), build: ref.slice(at + 1) };
}
