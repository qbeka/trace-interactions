# Writing scenarios

A scenario is a JSON file that says what a user does and what must stay true. Check one
with `trace validate <file>`. The format is defined in `src/scenario/schema.ts`.

```json
{
  "schema": "trace.scenario/1",
  "id": "reopen-during-close",
  "fixture": { "id": "inspector", "version": "1" },
  "seed": 1,
  "initialState": {},
  "viewport": { "width": 900, "height": 640, "deviceScaleFactor": 1 },
  "timing": { "mode": "controlled", "stepMs": 16, "settleMs": 500 },
  "targets": {
    "trigger": { "role": "button", "name": "Inspect", "traceId": "trigger" },
    "panel": { "traceId": "panel" }
  },
  "requirements": [
    { "kind": "latest-request-wins", "key": "panel", "terminal": ["open", "closed"] }
  ],
  "actions": [
    { "at": 0, "type": "activate", "target": "trigger", "requests": { "panel": "open" } }
  ],
  "cleanup": []
}
```

## Targets

Actions find elements by `role` and `name`, through the accessibility tree. Anything a
requirement observes also needs a `traceId`, which is a `data-trace-id` attribute. The
recorder samples inside the page on every tick, and working out accessible names there
would be slow and approximate.

## Actions

Every action has `at`, the time in ms. Two actions may share a time, and the list order
decides. The trace keeps both the time and a sequence number.

| Type | Fields | Does |
|---|---|---|
| `focus` | `target` | Moves focus |
| `type` | `target`, `text` | Types keys one at a time |
| `activate` | `target` | Clicks |
| `press` | `key`, optional `target` | Presses one key or chord |
| `pointerDown`, `pointerMove` | `point` | Starts or moves a gesture |
| `pointerUp`, `pointerCancel` | none | Ends or cancels a gesture |
| `resize` | `width`, `height` | Changes the viewport |
| `scroll` | `target`, `top` | Sets scroll position |
| `requestState` | `state` | Calls the fixture's `request` function |
| `waitFor` | `state`, `timeoutMs` | Waits for a declared state |

Optional fields on any action:

- `requests`: the semantic state this action asks for. `latest-request-wins` reads it.
- `requires`: state that must hold first, or the scenario is invalid.
- `ack`: a state change that proves the page received the action.
- `setup`: the reducer must keep this action.
- `note`: a short label for reports.

Coordinates exist only for pointer gestures, and each `point` names its space:
`viewport-px`, or `target-fraction` with a target and 0 to 1 values.

**Keep `ack` loose.** Without `oneOf`, any change of the key counts. Pinning a value such
as `closing` or `35` fails a legitimate change, such as removing an exit animation or
using finer steps. That mistake caused 3 false alarms in the first corpus run.

## Requirements

Requirements do not depend on the baseline. Each maps to one failure category.

| Kind | Category | Checks |
|---|---|---|
| `latest-request-wins` | stale-final-state | A key never reaches a terminal value other than the latest request's |
| `focus-stays-on` | lost-focus | The target keeps focus, on the same node, while a state holds |
| `focus-restored` | lost-focus | Focus lands on the target when a state starts to hold |
| `focus-valid` | lost-focus | Focus is never on a hidden, inert or detached element |
| `geometry-continuous` | geometry-discontinuity | Edges move at most `maxStepPx` between samples |
| `geometry-origin` | geometry-discontinuity | A target appears at its anchor, or at rest |
| `geometry-fits` | geometry-discontinuity | The target stays inside the viewport after a resize settles |
| `single-interactive` | duplicate-interactive | At most one live copy exists |
| `relationship-resolves` | duplicate-interactive | An ARIA reference resolves to one element, the right one |
| `transient-cleared` | incomplete-cleanup | State is clear after a gesture ends |
| `resources-released` | incomplete-cleanup | Listeners, observers, timers and frames return to the count before mount |

An action `ack` and a timed-out `waitFor` report as `missed-ack`.

`transient-cleared` judges just before the next action. If a state settles over time, set
`settledMs`, or a fast next action will read it too early. `geometry-fits` also takes
`settledMs`, with a default of 100.

Each requirement ends as `held`, `broken` or `not exercised`. The last means the run never
reached what it checks, such as a focus requirement on a target that never had focus, or a
leak check with no count from before mount. The status covers the whole requirement: one
judged occurrence makes it `held`, even if another was skipped. To test for leaks, start with
`"initialState": { "mounted": false }` and mount with `requestState`, or there is nothing
to compare against. A state key the page never publishes makes the scenario invalid, so a
typo cannot pass as `held`.

## Valid, invalid, diverged

A failed selector or an unsupported command is never a regression.

- `invalid`: the scenario could not run on the baseline. Fix the scenario.
- `diverged`: it ran on the baseline and could not finish on the candidate. The report
  names the action. Read it: a removed control is sometimes the real bug, but Trace does
  not claim that.

## Registering a fixture

A fixture is any page that sets `window.__traceFixture`:

```js
window.__traceFixture = {
  id: 'tabs',
  version: '1',
  getState: () => ({ tab }),
  subscribe(callback) { /* call it after each state change */ return () => {}; },
  request(state) { /* optional, for requestState */ },
};
```

Then write a manifest and register it:

```json
{
  "schema": "trace.fixture/1",
  "id": "tabs",
  "version": "1",
  "stateAllowlist": ["tab"],
  "clock": { "channels": ["timers", "frames"] },
  "builds": {
    "main": { "dir": "dist-main" },
    "branch": { "url": "http://127.0.0.1:4173/" },
    "served": { "command": ["pnpm", "preview"], "url": "http://127.0.0.1:4174/" }
  }
}
```

```bash
trace fixtures add path/to/fixture.json
```

Only state keys in `stateAllowlist` are recorded, and only short primitives. Choose them
with care: a key holding a search query is typed text, and it will be saved. The recorder
itself keeps no text, input values or labels, but reports include the scenario's typed
text and unmasked screenshots, so use synthetic data. Commands run only from the registry
you point at, never from a saved run folder, and URLs must be on this machine.
