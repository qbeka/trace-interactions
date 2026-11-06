import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Writes `results/MANIFEST.json`: a hash for every saved result, demo file and
 * asset. With `--check`, recomputes them and names any file that changed.
 */
const root = resolve(import.meta.dirname, '..');
const manifestPath = join(root, 'results/MANIFEST.json');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'screenshots' && dir.includes('results') ? [] : walk(path);
    return e.name === 'MANIFEST.json' || e.name === '.DS_Store' ? [] : [path];
  });
}

const entries = () => Object.fromEntries(
  ['results', 'demo', 'docs/assets'].flatMap((d) => walk(join(root, d))).sort().map((f) => [
    relative(root, f),
    { sha256: createHash('sha256').update(readFileSync(f)).digest('hex'), bytes: statSync(f).size },
  ]),
);

if (process.argv.includes('--check')) {
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8')).files as Record<string, { sha256: string }>;
  const current = entries();
  const changed = [...new Set([...Object.keys(saved), ...Object.keys(current)])].filter((f) => saved[f]?.sha256 !== current[f]?.sha256);
  for (const f of changed) console.error(`changed: ${f}`);
  console.log(changed.length ? `${changed.length} file(s) differ.` : `${Object.keys(current).length} files match the manifest.`);
  process.exitCode = changed.length ? 1 : 0;
} else {
  writeFileSync(manifestPath, JSON.stringify({ schema: 'trace.artifacts/1', files: entries() }, null, 2) + '\n');
  console.log(`Wrote ${manifestPath}`);
}
