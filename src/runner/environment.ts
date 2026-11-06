import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, relative } from 'node:path';
import type { Browser } from 'playwright';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hashes file paths and contents, so a renamed file changes the result. */
export function hashDirectory(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  const hash = createHash('sha256');
  for (const f of files) hash.update(relative(dir, f)).update(readFileSync(f));
  return hash.digest('hex');
}

function quiet(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Source state of this checkout. Saved results do not count as source changes. */
export function sourceState(): { commit: string | null; dirty: boolean | null } {
  const commit = quiet('git', ['rev-parse', 'HEAD']);
  if (!commit) return { commit: null, dirty: null };
  return { commit, dirty: (quiet('git', ['status', '--porcelain', '--', '.', ':!results']) ?? '') !== '' };
}

export function powerSource(): string | null {
  if (platform() !== 'darwin') return null;
  return quiet('pmset', ['-g', 'ps'])?.split('\n')[0]?.replace(/^Now drawing from /, '').replace(/'/g, '') ?? null;
}

export function environment(browser: Browser) {
  const cpu = cpus();
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    hardware: { cpu: cpu[0]?.model ?? 'unknown', cores: cpu.length, memoryGb: Math.round(totalmem() / 1024 ** 3) },
    power: powerSource(),
    node: process.version,
    browser: { name: browser.browserType().name(), version: browser.version() },
  };
}

export function dependencyVersions(packageJson: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
  return { ...pkg.dependencies, ...pkg.devDependencies };
}
