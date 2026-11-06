import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/oracle/oracle.ts';
import type { Requirement } from '../../src/scenario/schema.ts';
import { need, scenario, trace } from './helpers.ts';

const box = (x: number, w = 100) => ({ x, y: 0, w, h: 50 });

describe('latest-request-wins', () => {
  const req: Requirement = { kind: 'latest-request-wins', key: 'panel', terminal: ['open', 'closed'] };
  const actions = [
    { type: 'activate', target: 'trigger', at: 0, requests: { panel: 'closed' } },
    { type: 'activate', target: 'trigger', at: 100, requests: { panel: 'open' } },
  ] as never;

  it('passes when transitional values appear between requests', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'activate').state('panel', 'closing').at(100).action(1, 'activate').state('panel', 'opening').at(300).state('panel', 'open');
    expect(evaluate(scenario(need(req, actions)), t.events)).toEqual([]);
  });

  it('flags a stale completion even when the final state is right', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'activate').state('panel', 'closing').at(100).action(1, 'activate').state('panel', 'opening').at(240).state('panel', 'closed').at(340).state('panel', 'open');
    const [v] = evaluate(scenario(need(req, actions)), t.events);
    expect(v?.category).toBe('stale-final-state');
    expect(v?.at.t).toBe(240);
  });

  it('flags a final value that differs from the last request', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'activate').state('panel', 'closing').at(100).action(1, 'activate').state('panel', 'stuck');
    expect(evaluate(scenario(need(req, actions)), t.events)[0]?.category).toBe('stale-final-state');
  });

  it('says nothing when no action requested the key', () => {
    const t = trace().state('panel', 'closed').at(10).state('panel', 'open');
    expect(evaluate(scenario(need(req)), t.events)).toEqual([]);
  });
});

describe('focus', () => {
  const stays: Requirement = { kind: 'focus-stays-on', target: 'input', whileState: { panel: 'open' } };

  it('flags a remount that replaces the focused node', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'focus').focus('input', 1).at(10).focus(null).focus('input', 2);
    expect(evaluate(scenario(need(stays)), t.events)[0]?.sentence).toMatch(/lost focus|remounted/);
  });

  it('flags focus falling to the body with no user action', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'focus').focus('input', 1).at(50).focus(null);
    expect(evaluate(scenario(need(stays)), t.events)[0]?.category).toBe('lost-focus');
  });

  it('allows focus to leave during an action that moves it', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'focus').focus('input', 1).at(50);
    t.add({ k: 'action', phase: 'start', index: 1, cleanup: false, type: 'press', label: 'Tab' }).focus('trigger', 9);
    t.add({ k: 'action', phase: 'end', index: 1, cleanup: false, type: 'press', label: 'Tab' });
    expect(evaluate(scenario(need(stays)), t.events)).toEqual([]);
  });

  it('does not let an earlier action excuse a later focus loss', () => {
    const t = trace().state('panel', 'open').at(0).focus('input', 1).at(400).action(0, 'type').at(800);
    t.add({ k: 'action', phase: 'start', index: 1, cleanup: false, type: 'resize', label: 'resize' }).focus(null);
    t.add({ k: 'action', phase: 'end', index: 1, cleanup: false, type: 'resize', label: 'resize' });
    expect(evaluate(scenario(need(stays)), t.events)[0]?.category).toBe('lost-focus');
  });

  it('allows focus to leave once the state no longer holds, in the same tick', () => {
    const t = trace().state('panel', 'open').at(0).action(0, 'focus').focus('input', 1).at(50).focus(null).state('panel', 'closing');
    expect(evaluate(scenario(need(stays)), t.events)).toEqual([]);
  });

  it('flags focus on a hidden element, whatever the baseline does', () => {
    const t = trace().at(10).focus('clone', 4, { hidden: true });
    expect(evaluate(scenario(need({ kind: 'focus-valid' })), t.events)[0]?.sentence).toMatch(/hidden or inert/);
  });

  it('flags focus on a detached element', () => {
    const t = trace().at(10).focus('gone', 4, { connected: false });
    expect(evaluate(scenario(need({ kind: 'focus-valid' })), t.events)[0]?.sentence).toMatch(/detached/);
  });

  const restored: Requirement = { kind: 'focus-restored', to: 'trigger', whenState: { open: false }, withinMs: 100 };

  it('passes when a close returns focus to the trigger', () => {
    const t = trace().state('open', true).at(0).action(0, 'press').focus('input', 1).at(10).state('open', false).at(20).focus('trigger', 2);
    expect(evaluate(scenario(need(restored)), t.events)).toEqual([]);
  });

  it('fails when a close leaves focus on the body', () => {
    const t = trace().state('open', true).at(0).action(0, 'press').focus('input', 1).at(10).state('open', false).at(20).focus(null);
    expect(evaluate(scenario(need(restored)), t.events)[0]?.category).toBe('lost-focus');
  });

  it('fails when focus returns to a trigger that is hidden', () => {
    const t = trace().state('open', true).at(0).action(0, 'press').focus('input', 1).at(10).state('open', false).at(20).focus('trigger', 2, { hidden: true });
    expect(evaluate(scenario(need(restored)), t.events)[0]?.category).toBe('lost-focus');
  });

  it('accepts focus moving on when the state stops holding inside the window', () => {
    const t = trace().state('open', true).at(0).action(0, 'press').focus('input', 1).at(10).state('open', false).focus('trigger', 2).at(60).state('open', true).focus('input', 3);
    expect(evaluate(scenario(need(restored)), t.events)).toEqual([]);
  });

  it('still fails when focus is wrong while the state holds, even if it reopens later', () => {
    const t = trace().state('open', true).at(0).action(0, 'press').focus('input', 1).at(10).state('open', false).focus(null).at(60).state('open', true).focus('input', 3);
    expect(evaluate(scenario(need(restored)), t.events)[0]?.category).toBe('lost-focus');
  });

  it('does not treat the first render as a close', () => {
    const t = trace().state('open', false).at(0).action(0, 'press');
    expect(evaluate(scenario(need(restored)), t.events)).toEqual([]);
  });
});

describe('geometry', () => {
  it('flags a jump above the limit between two samples', () => {
    const t = trace().at(0).rect('panel', box(0)).at(16).rect('panel', box(300));
    const req: Requirement = { kind: 'geometry-continuous', target: 'panel', maxStepPx: 100 };
    expect(evaluate(scenario(need(req)), t.events)[0]?.category).toBe('geometry-discontinuity');
  });

  it('allows a jump caused by a resize', () => {
    const t = trace().at(0).rect('panel', box(0)).at(16).action(0, 'resize').rect('panel', box(300)).at(32).rect('panel', box(300));
    const req: Requirement = { kind: 'geometry-continuous', target: 'panel', maxStepPx: 100 };
    expect(evaluate(scenario(need(req)), t.events)).toEqual([]);
  });

  it('does not compare two different nodes', () => {
    const t = trace().at(0).rect('panel', box(0), 1).at(16).rect('panel', box(300), 2);
    const req: Requirement = { kind: 'geometry-continuous', target: 'panel', maxStepPx: 100 };
    expect(evaluate(scenario(need(req)), t.events)).toEqual([]);
  });

  const origin: Requirement = { kind: 'geometry-origin', target: 'panel', anchor: 'trigger', tolerancePx: 4 };

  it('passes a panel that grows from its anchor', () => {
    const t = trace().at(0).rect('trigger', box(500)).rect('panel', box(500)).at(16).rect('panel', box(400, 200));
    expect(evaluate(scenario(need(origin)), t.events)).toEqual([]);
  });

  it('passes a panel that does not move at all, such as a fade', () => {
    const t = trace().at(0).rect('trigger', box(500)).rect('panel', box(100, 300)).at(16).rect('panel', box(100, 300));
    expect(evaluate(scenario(need(origin)), t.events)).toEqual([]);
  });

  it('flags a panel that starts somewhere else and then moves', () => {
    const t = trace().at(0).rect('trigger', box(500)).rect('panel', box(200)).at(16).rect('panel', box(300, 200));
    expect(evaluate(scenario(need(origin)), t.events)[0]?.category).toBe('geometry-discontinuity');
  });

  it('does not count a later resize as motion of the entrance', () => {
    // A fade: appears at its resting place, then a resize moves it.
    const t = trace().at(0).rect('trigger', box(500)).at(1).action(0, 'activate').rect('panel', box(100, 300)).at(400).action(1, 'resize').rect('panel', box(40, 300));
    expect(evaluate(scenario(need(origin)), t.events)).toEqual([]);
  });

  const fits: Requirement = { kind: 'geometry-fits', target: 'panel', insetPx: 8, tolerancePx: 2 };

  it('flags a panel left outside the viewport after a resize', () => {
    const panel = { x: 500, y: 20, w: 280, h: 50 };
    const t = trace().viewport(800, 600).at(10).rect('panel', panel).at(20).viewport(600, 600).action(0, 'resize');
    // Right edge 780 against a limit of 600 - (8 - 2) = 594.
    expect(evaluate(scenario(need(fits)), t.events)[0]?.sentence).toMatch(/by 186 px/);
  });

  it('passes a panel that follows the viewport', () => {
    const t = trace().viewport(800, 600).at(10).rect('panel', { x: 500, y: 20, w: 280, h: 50 }).at(20).viewport(600, 600).rect('panel', { x: 300, y: 20, w: 280, h: 50 }).action(0, 'resize');
    expect(evaluate(scenario(need(fits)), t.events)).toEqual([]);
  });
});

describe('duplicates', () => {
  it('flags two live copies of a target', () => {
    const t = trace().at(0).rect('panel', box(0), 1, 2);
    expect(evaluate(scenario(need({ kind: 'single-interactive', target: 'panel' })), t.events)[0]?.category).toBe('duplicate-interactive');
  });

  it('allows an inert clone next to the live one', () => {
    const t = trace().add({ k: 'geometry', target: 'panel', rect: box(0), node: 1, count: 2, interactive: 1 });
    expect(evaluate(scenario(need({ kind: 'single-interactive', target: 'panel' })), t.events)).toEqual([]);
  });

  const rel: Requirement = { kind: 'relationship-resolves', from: 'trigger', attribute: 'aria-controls', to: 'panel' };

  it('flags an id that matches two elements', () => {
    const t = trace().add({ k: 'relation', from: 'trigger', attribute: 'aria-controls', id: 'p', matches: 2, resolved: 'panel' });
    expect(evaluate(scenario(need(rel)), t.events)[0]?.category).toBe('duplicate-interactive');
  });

  it('flags an id that resolves to the wrong element', () => {
    const t = trace().add({ k: 'relation', from: 'trigger', attribute: 'aria-controls', id: 'p', matches: 1, resolved: 'other' });
    expect(evaluate(scenario(need(rel)), t.events)[0]?.category).toBe('duplicate-interactive');
  });

  it('allows an id with nothing to point at while the panel is closed', () => {
    const t = trace().add({ k: 'relation', from: 'trigger', attribute: 'aria-controls', id: 'p', matches: 0, resolved: null });
    expect(evaluate(scenario(need(rel)), t.events)).toEqual([]);
  });
});

describe('cleanup', () => {
  const cleared: Requirement = { kind: 'transient-cleared', after: 'pointerCancel', state: { dragging: false } };

  it('flags a drag that stays active after a cancel', () => {
    const t = trace().state('dragging', true).at(10).action(0, 'pointerCancel').at(20);
    expect(evaluate(scenario(need(cleared)), t.state('other', 1).events)[0]?.category).toBe('incomplete-cleanup');
  });

  it('passes when the cancel clears the drag', () => {
    const t = trace().state('dragging', true).at(10).state('dragging', false).action(0, 'pointerCancel');
    expect(evaluate(scenario(need(cleared)), t.events)).toEqual([]);
  });

  const released: Requirement = { kind: 'resources-released', key: 'mounted', removedValue: false };

  it('flags a listener left behind after removal', () => {
    const t = trace().state('mounted', false).resources({ 'document:selectionchange': 1 }).at(10).state('mounted', true).at(20).state('mounted', false).resources({ 'document:selectionchange': 1, 'window:pointermove': 1 });
    const [v] = evaluate(scenario(need(released)), t.events);
    expect(v?.sentence).toMatch(/window:pointermove/);
  });

  it('passes when counts return to the level before mount', () => {
    const t = trace().state('mounted', false).resources({ a: 1 }).at(10).state('mounted', true).resources({ a: 2 }).at(20).state('mounted', false).resources({ a: 1 });
    expect(evaluate(scenario(need(released)), t.events)).toEqual([]);
  });

  it('ignores a key the scenario lists as ambient', () => {
    const t = trace().state('mounted', false).resources({}).at(20).resources({ 'timer:frame': 1 });
    const req: Requirement = { kind: 'resources-released', key: 'mounted', removedValue: false, ignore: ['timer:frame'] };
    expect(evaluate(scenario(need(req)), t.events)).toEqual([]);
  });
});

describe('acknowledgements', () => {
  const actions = [{ type: 'press', key: 'Escape', at: 0, ack: { key: 'panel', withinMs: 50 } }] as never;

  it('passes when the state changes in time', () => {
    const t = trace().at(0).action(0, 'press').at(16).state('panel', 'closing');
    expect(evaluate(scenario({ actions }), t.events)).toEqual([]);
  });

  it('fails when the state never changes', () => {
    const t = trace().at(0).action(0, 'press').at(300);
    expect(evaluate(scenario({ actions }), t.events)[0]?.category).toBe('missed-ack');
  });

  it('fails when the state changes too late', () => {
    const t = trace().at(0).action(0, 'press').at(300).state('panel', 'closing');
    expect(evaluate(scenario({ actions }), t.events)[0]?.category).toBe('missed-ack');
  });

  it('accepts any listed value', () => {
    const list = [{ type: 'press', key: 'Escape', at: 0, ack: { key: 'panel', oneOf: ['closing', 'closed'], withinMs: 50 } }] as never;
    const t = trace().at(0).action(0, 'press').at(16).state('panel', 'closed');
    expect(evaluate(scenario({ actions: list }), t.events)).toEqual([]);
  });

  it('rejects a change to an unlisted value', () => {
    const list = [{ type: 'press', key: 'Escape', at: 0, ack: { key: 'panel', oneOf: ['closing'], withinMs: 50 } }] as never;
    const t = trace().at(0).action(0, 'press').at(16).state('panel', 'stuck');
    expect(evaluate(scenario({ actions: list }), t.events)[0]?.category).toBe('missed-ack');
  });

  it('fails when a declared wait timed out', () => {
    const t = trace().add({ k: 'wait-timeout', index: 0 });
    expect(evaluate(scenario(), t.events)[0]?.category).toBe('missed-ack');
  });
});

describe('ordering', () => {
  it('returns the earliest violation first', () => {
    const t = trace().at(5).focus('x', 1, { hidden: true }).at(10).focus('y', 2, { connected: false });
    const s = scenario({ requirements: [{ kind: 'focus-valid' }] });
    expect(evaluate(s, t.events)[0]?.at.t).toBe(5);
  });

  it('keeps a fingerprint stable across runs of one failure', () => {
    const a = trace().at(5).focus('x', 1, { hidden: true });
    const b = trace().at(900).focus('x', 77, { hidden: true });
    const s = scenario({ requirements: [{ kind: 'focus-valid' }] });
    expect(evaluate(s, a.events)[0]?.fingerprint).toBe(evaluate(s, b.events)[0]?.fingerprint);
  });
});
