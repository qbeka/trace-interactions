import { join } from 'node:path';
import type { Browser } from 'playwright';
import { dependencyVersions, environment, sourceState } from '../src/runner/environment.ts';

/** Fields every saved measurement carries. See the evidence standard in the README. */
export function manifestFor(browser: Browser, root: string, script: string) {
  return {
    schema: 'trace.bench/1',
    command: `tsx ${script} ${process.argv.slice(2).join(' ')}`.trim(),
    source: sourceState(),
    dependencies: dependencyVersions(join(root, 'package.json')),
    environment: environment(browser),
  };
}
