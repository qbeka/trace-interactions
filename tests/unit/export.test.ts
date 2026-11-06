import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutLocalPaths } from '../../src/report/export.ts';

const root = resolve(import.meta.dirname, '../..');
const cwd = '/home/ada/work/app';
const home = '/home/ada';
const clean = (value: unknown) => JSON.parse(withoutLocalPaths(JSON.stringify(value), cwd, home));

describe('withoutLocalPaths', () => {
  it('makes paths inside the working directory relative', () => {
    expect(clean({ out: '/home/ada/work/app/.trace/run' })).toEqual({ out: './.trace/run' });
  });

  it('hides the home directory for paths outside the working directory', () => {
    expect(clean({ out: '/home/ada/other/run' })).toEqual({ out: '~/other/run' });
  });

  it('replaces every occurrence in every field and stays valid JSON', () => {
    const value = { command: ['--out', '/home/ada/a', '--x=/home/ada/b'], nested: [{ path: '/home/ada/c' }] };
    expect(clean(value)).toEqual({ command: ['--out', '~/a', '--x=~/b'], nested: [{ path: '~/c' }] });
  });

  it('leaves a sibling folder that only shares a prefix alone', () => {
    expect(clean({ out: '/home/ada2/run', other: '/home/ada/work/app2/run' })).toEqual({ out: '/home/ada2/run', other: '~/work/app2/run' });
  });

  it('handles a Windows path, which JSON escapes', () => {
    const body = JSON.stringify({ out: 'C:\\Users\\ada\\run' });
    const escaped = withoutLocalPaths(body.replaceAll('\\\\', '/'), 'C:/Users/ada/work', 'C:/Users/ada');
    expect(JSON.parse(escaped).out).toBe('~/run');
  });

  it('does not touch anything when home is the filesystem root', () => {
    expect(withoutLocalPaths('{"a":"/etc/hosts"}', '/', '/')).toBe('{"a":"/etc/hosts"}');
  });
});

describe('the published demo', () => {
  it.each(['regression', 'fixed'])('%s holds no path from the machine that built it', (name) => {
    const file = join(root, 'demo', name, 'report.json');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(homedir());
    expect(text).not.toMatch(/\/(Users|home)\/[^/"]+\//);
  });
});
