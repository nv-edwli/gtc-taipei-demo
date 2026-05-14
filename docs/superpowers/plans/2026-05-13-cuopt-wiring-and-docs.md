# cuOpt UI Wiring + Docs Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the cuOpt envelope into the demo UI (metric bars, score, map, new per-node capacity chart) with a graceful mock-fallback for every failure mode; reconcile repo docs (AGENTS/CLAUDE/SKILL.md/README/integration-plan/demo-script) so they describe the running code; add `npm test` gates against future drift.

**Architecture:** Pure parsing + transformation functions live in a new `app-cuopt.mjs` module, unit-testable via Node's built-in `node:test` runner. `app.js` imports them and handles DOM-affecting beat dispatch. The two cuopt normalizers gain a stage hint each. A new capacity panel renders horizontal bars overlaying baseline + optimized per node. Failure modes (script error, parse error, missing fields, agent skipped, background-mode preamble) all route through one `applyCuoptResult` commit-point with a single sticky `cuoptResolved` flag.

**Tech Stack:** Vanilla ES modules (no bundler), Node `node:test` runner for unit tests, plain HTML/CSS/JS frontend.

**Spec reference:** `docs/superpowers/specs/2026-05-13-cuopt-wiring-and-docs-design.md`.

---

## File map

| File | Action | Why |
|---|---|---|
| `app-cuopt.mjs` | Create | Pure parsing + transformation; unit-testable |
| `tests/cuopt-parser.test.mjs` | Create | Node `node:test` unit tests for app-cuopt.mjs |
| `app.js` | Modify | Import cuopt-parser, add state, add handlers, add render functions |
| `index.html` | Modify | Add capacity-panel block inside canvas-cuopt |
| `styles.css` | Modify | Capacity-panel + capacity-row styling |
| `server/normalize-claude.mjs` | Modify | Add `cuopt` to STAGE_HINTS |
| `server/normalize-codex.mjs` | Modify | Add `cuopt` to STAGE_HINTS |
| `data/supply-chain.json` | Modify | Add cuopt to `skillMap`; comment about fallback role |
| `scripts/check.mjs` | Modify | Add doc-equality gate, system-prime smoke test |
| `package.json` | Modify | Add `test:unit` script |
| `CLAUDE.md` | Modify | Correct event-kind list, document cuopt fallback rule |
| `AGENTS.md` | Replace | Byte-identical copy of corrected CLAUDE.md |
| `skills/aiq-research/SKILL.md` | Rewrite | Demo-correct `research "<q>" shallow_researcher` flow only |
| `README.md` | Modify | Reflect live state; cuopt-fallback path |
| `docs/integration-plan.md` | Rewrite | Live-flow doc, real event names |
| `docs/demo-script.md` | Modify | Pre-flight, capacity-chart talk track, fallback line |

---

## Phase 1 — Pure functions (TDD)

### Task 1: Bootstrap the test runner and module scaffold

**Files:**
- Create: `app-cuopt.mjs`
- Create: `tests/cuopt-parser.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing smoke test**

Create `tests/cuopt-parser.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as cuopt from "../app-cuopt.mjs";

test("module exports the expected surface", () => {
  assert.equal(typeof cuopt.parseCuoptToolOutput, "function");
  assert.equal(typeof cuopt.cuoptEnvelopeToUiValues, "function");
  assert.equal(typeof cuopt.mockToUiValues, "function");
  assert.equal(typeof cuopt.looksLikeCuoptResult, "function");
  assert.equal(typeof cuopt.parseCostDisplay, "function");
  assert.deepEqual(cuopt.CUOPT_SCORE_PENALTY, { solved: 0, infeasible: 15, fallback: 20 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: FAIL — `Cannot find module '../app-cuopt.mjs'` or similar.

- [ ] **Step 3: Create the module skeleton**

Create `app-cuopt.mjs`:

```js
// Pure parsing + transformation for the cuOpt envelope produced by
// skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py.
//
// This module is imported by app.js (browser-loaded) AND by tests/cuopt-parser.test.mjs
// (node:test runner). Keep it DOM-free.

export const CUOPT_SCORE_PENALTY = { solved: 0, infeasible: 15, fallback: 20 };

export const CUOPT_TO_UI_NODE = {
  taipei: "Taipei",
  hsinchu: "Hsinchu",
  taichung: "Taichung",
  tainan: "Tainan",
  kaohsiung: "Port",
  taoyuan: "Air"
};

export function parseCostDisplay(_s) { return null; }       // implemented Task 2
export function looksLikeCuoptResult(_t) { return false; }  // implemented Task 2
export function parseCuoptToolOutput(_stdout, _isError) {   // implemented Task 3
  return { status: "fallback", reason: "not_implemented" };
}
export function cuoptEnvelopeToUiValues(_envelope, _data) { return null; }  // Task 4
export function mockToUiValues(_data) { return null; }                       // Task 4
```

- [ ] **Step 4: Add the test script**

Edit `package.json`. The current `scripts` block:

```json
"scripts": {
  "start": "node server.mjs",
  "dev": "node server.mjs",
  "test": "node scripts/check.mjs"
}
```

Becomes:

```json
"scripts": {
  "start": "node server.mjs",
  "dev": "node server.mjs",
  "test": "node scripts/check.mjs && node --test tests/",
  "test:static": "node scripts/check.mjs",
  "test:unit": "node --test tests/"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: PASS (1 test).

Also run: `npm test`
Expected: both checks pass.

- [ ] **Step 6: Commit**

```bash
git add app-cuopt.mjs tests/cuopt-parser.test.mjs package.json
git commit -m "feat(cuopt): scaffold app-cuopt.mjs module + node:test runner"
```

---

### Task 2: Implement `parseCostDisplay` and `looksLikeCuoptResult`

**Files:**
- Modify: `app-cuopt.mjs`
- Modify: `tests/cuopt-parser.test.mjs`

- [ ] **Step 1: Write failing tests for `parseCostDisplay`**

Append to `tests/cuopt-parser.test.mjs`:

```js
test("parseCostDisplay extracts dollars-in-millions from display string", () => {
  assert.equal(cuopt.parseCostDisplay("$7.2M"), 7_200_000);
  assert.equal(cuopt.parseCostDisplay("$5.6M"), 5_600_000);
  assert.equal(cuopt.parseCostDisplay("$10M"), 10_000_000);
  assert.equal(cuopt.parseCostDisplay("$1.25M"), 1_250_000);
});

test("parseCostDisplay returns null on unrecognised format", () => {
  assert.equal(cuopt.parseCostDisplay("nope"), null);
  assert.equal(cuopt.parseCostDisplay(""), null);
  assert.equal(cuopt.parseCostDisplay(null), null);
  assert.equal(cuopt.parseCostDisplay(undefined), null);
});

test("looksLikeCuoptResult matches by kind marker", () => {
  const text = '{"kind":"cuopt.result","status":"solved","selected_lanes":[]}';
  assert.equal(cuopt.looksLikeCuoptResult(text), true);
});

test("looksLikeCuoptResult matches by combined fields", () => {
  const text = '{"status":"solved","selected_lanes":[{"a":1}],"objective_value":42.5}';
  assert.equal(cuopt.looksLikeCuoptResult(text), true);
});

test("looksLikeCuoptResult rejects short / empty / unrelated text", () => {
  assert.equal(cuopt.looksLikeCuoptResult(""), false);
  assert.equal(cuopt.looksLikeCuoptResult(null), false);
  assert.equal(cuopt.looksLikeCuoptResult("hello world"), false);
  assert.equal(cuopt.looksLikeCuoptResult('{"some":"json","but":"unrelated"}'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: 4 new tests FAIL.

- [ ] **Step 3: Implement both functions in `app-cuopt.mjs`**

Replace the two stub implementations with:

```js
export function parseCostDisplay(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/\$([\d.]+)M/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.round(v * 1_000_000) : null;
}

export function looksLikeCuoptResult(text) {
  if (!text || typeof text !== "string" || text.length < 40) return false;
  const head = text.slice(0, 400);
  if (/"kind"\s*:\s*"cuopt\.result"/.test(head)) return true;
  if (/"selected_lanes"\s*:/.test(head) && /"objective_value"\s*:/.test(head)) return true;
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add app-cuopt.mjs tests/cuopt-parser.test.mjs
git commit -m "feat(cuopt): add parseCostDisplay + looksLikeCuoptResult helpers"
```

---

### Task 3: Implement `parseCuoptToolOutput`

**Files:**
- Modify: `app-cuopt.mjs`
- Modify: `tests/cuopt-parser.test.mjs`

- [ ] **Step 1: Define the canonical envelope used in tests**

Append to `tests/cuopt-parser.test.mjs`:

```js
const SOLVED_ENVELOPE = {
  kind: "cuopt.result",
  status: "solved",
  objective_value: 4321.5,
  selected_lanes: [
    { from: "taipei", to: "hsinchu", mode: "truck", weekly_lots: 420 }
  ],
  metrics: {
    weekly_logistics_cost_usd: 5_600_000,
    mean_cycle_days: 4.3,
    unassigned_priority_lots: 4,
    peak_capacity_pressure: 0.71
  },
  capacity: [
    { node: "hsinchu", utilization: 0.82 },
    { node: "taichung", utilization: 0.68 },
    { node: "tainan", utilization: 0.77 },
    { node: "kaohsiung", utilization: 0.61 },
    { node: "taoyuan", utilization: 0.59 }
  ],
  explanation: "Solved on cuOpt with 6 vehicles across 5 lanes."
};
const SOLVED_JSON = JSON.stringify(SOLVED_ENVELOPE);
```

- [ ] **Step 2: Write failing tests for every parse path**

Append:

```js
test("parseCuoptToolOutput: clean solved envelope", () => {
  const result = cuopt.parseCuoptToolOutput(SOLVED_JSON, false);
  assert.equal(result.status, "solved");
  assert.equal(result.envelope.metrics.peak_capacity_pressure, 0.71);
});

test("parseCuoptToolOutput: infeasible envelope still parses", () => {
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), true);
  assert.equal(result.status, "infeasible");
  assert.ok(result.envelope);
});

test("parseCuoptToolOutput: script_error on empty stdout + error", () => {
  const result = cuopt.parseCuoptToolOutput("", true);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "script_error");
});

test("parseCuoptToolOutput: parse_failed on empty stdout no error", () => {
  const result = cuopt.parseCuoptToolOutput("", false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "parse_failed");
});

test("parseCuoptToolOutput: parse_failed on garbage stdout", () => {
  const result = cuopt.parseCuoptToolOutput("not json {{{", false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "parse_failed");
});

test("parseCuoptToolOutput: parse_failed on truncated JSON", () => {
  const truncated = SOLVED_JSON.slice(0, 80);
  const result = cuopt.parseCuoptToolOutput(truncated, false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "parse_failed");
});

test("parseCuoptToolOutput: bad_shape on JSON missing kind", () => {
  const env = { ...SOLVED_ENVELOPE };
  delete env.kind;
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "bad_shape");
});

test("parseCuoptToolOutput: bad_shape on JSON missing metrics", () => {
  const env = { ...SOLVED_ENVELOPE };
  delete env.metrics;
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "bad_shape");
});

test("parseCuoptToolOutput: bad_shape on unknown status", () => {
  const env = { ...SOLVED_ENVELOPE, status: "weird" };
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), false);
  assert.equal(result.status, "fallback");
  assert.equal(result.reason, "bad_shape");
});

test("parseCuoptToolOutput: error exit + valid envelope routes through envelope status", () => {
  // run.py exits 4 on infeasible but still prints the envelope.
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), true);
  assert.equal(result.status, "infeasible");
});

test("parseCuoptToolOutput: tolerates leading whitespace", () => {
  const result = cuopt.parseCuoptToolOutput("\n\n  " + SOLVED_JSON + "\n", false);
  assert.equal(result.status, "solved");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: 11 new tests FAIL with various errors (all return the stub's `not_implemented`).

- [ ] **Step 4: Implement `parseCuoptToolOutput`**

Replace the stub in `app-cuopt.mjs`:

```js
const VALID_STATUSES = new Set(["solved", "infeasible"]);

export function parseCuoptToolOutput(stdout, isError) {
  const trimmed = typeof stdout === "string" ? stdout.trim() : "";
  if (!trimmed) {
    return { status: "fallback", reason: isError ? "script_error" : "parse_failed" };
  }
  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch (_) {
    return { status: "fallback", reason: "parse_failed" };
  }
  if (!envelope || typeof envelope !== "object") {
    return { status: "fallback", reason: "bad_shape" };
  }
  if (envelope.kind !== "cuopt.result") {
    return { status: "fallback", reason: "bad_shape" };
  }
  if (!envelope.metrics || typeof envelope.metrics !== "object") {
    return { status: "fallback", reason: "bad_shape" };
  }
  if (!VALID_STATUSES.has(envelope.status)) {
    return { status: "fallback", reason: "bad_shape" };
  }
  return { status: envelope.status, envelope };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: All tests PASS (16 total so far).

- [ ] **Step 6: Commit**

```bash
git add app-cuopt.mjs tests/cuopt-parser.test.mjs
git commit -m "feat(cuopt): add parseCuoptToolOutput with comprehensive failure-mode coverage"
```

---

### Task 4: Implement `cuoptEnvelopeToUiValues` and `mockToUiValues`

**Files:**
- Modify: `app-cuopt.mjs`
- Modify: `tests/cuopt-parser.test.mjs`

- [ ] **Step 1: Define test fixture `data` (mock copy of supply-chain.json subset)**

Append to `tests/cuopt-parser.test.mjs`:

```js
const FIXTURE_DATA = {
  metrics: {
    baseline: [
      { label: "Weekly logistics cost",   value: 72, max: 100, display: "$7.2M" },
      { label: "Mean route cycle",        value: 64, max: 100, display: "6.4 days" },
      { label: "Unassigned priority lots", value: 31, max: 100, display: "31 lots" },
      { label: "Capacity pressure",       value: 88, max: 100, display: "88%" }
    ],
    optimized: [
      { label: "Weekly logistics cost",   value: 56, max: 100, display: "$5.6M",    delta: "−$1.6M" },
      { label: "Mean route cycle",        value: 43, max: 100, display: "4.3 days", delta: "−2.1 days" },
      { label: "Unassigned priority lots", value: 4,  max: 100, display: "4 lots",   delta: "−27 lots" },
      { label: "Capacity pressure",       value: 71, max: 100, display: "71%",      delta: "−17 pp" }
    ]
  },
  capacity: {
    baseline: [
      { label: "Taipei", value: 56 }, { label: "Hsinchu", value: 93 },
      { label: "Taichung", value: 78 }, { label: "Tainan", value: 91 },
      { label: "Port", value: 69 }, { label: "Air", value: 84 }, { label: "Buffer", value: 38 }
    ],
    optimized: [
      { label: "Taipei", value: 52 }, { label: "Hsinchu", value: 82 },
      { label: "Taichung", value: 68 }, { label: "Tainan", value: 77 },
      { label: "Port", value: 61 }, { label: "Air", value: 59 }, { label: "Buffer", value: 64 }
    ]
  }
};
```

- [ ] **Step 2: Write failing tests for `mockToUiValues`**

Append:

```js
test("mockToUiValues returns the data.metrics.optimized rows as metricRows", () => {
  const ui = cuopt.mockToUiValues(FIXTURE_DATA);
  assert.equal(ui.status, "fallback");
  assert.equal(ui.explanation, "");
  assert.equal(ui.metricRows.length, 4);
  assert.equal(ui.metricRows[0].display, "$5.6M");
  assert.equal(ui.metricRows[0].delta, "−$1.6M");
  assert.equal(ui.metricRows[0].dataSource, "mock");
});

test("mockToUiValues returns 7 capacityRows with baseline + value", () => {
  const ui = cuopt.mockToUiValues(FIXTURE_DATA);
  assert.equal(ui.capacityRows.length, 7);
  assert.deepEqual(ui.capacityRows[0], { label: "Taipei", value: 52, baseline: 56, dataSource: "mock" });
  assert.deepEqual(ui.capacityRows[6], { label: "Buffer", value: 64, baseline: 38, dataSource: "mock" });
});
```

- [ ] **Step 3: Write failing tests for `cuoptEnvelopeToUiValues`**

Append:

```js
test("cuoptEnvelopeToUiValues maps a clean solved envelope to UI rows", () => {
  const ui = cuopt.cuoptEnvelopeToUiValues(SOLVED_ENVELOPE, FIXTURE_DATA);
  assert.equal(ui.status, "solved");
  assert.equal(ui.explanation, "Solved on cuOpt with 6 vehicles across 5 lanes.");

  // Metric row 0: cost = $5.6M, baseline = $7.2M → delta = "−$1.6M"
  assert.equal(ui.metricRows[0].display, "$5.6M");
  assert.equal(ui.metricRows[0].delta, "−$1.6M");
  assert.equal(ui.metricRows[0].dataSource, "envelope");
  // Bar value = round(5_600_000 / 7_200_000 * 100) = 78
  assert.equal(ui.metricRows[0].value, 78);

  // Metric row 1: cycle 4.3d → value 43
  assert.equal(ui.metricRows[1].value, 43);
  assert.equal(ui.metricRows[1].display, "4.3 days");
  assert.equal(ui.metricRows[1].delta, "−2.1 days");

  // Metric row 2: unassigned 4
  assert.equal(ui.metricRows[2].value, 4);
  assert.equal(ui.metricRows[2].display, "4 lots");
  assert.equal(ui.metricRows[2].delta, "−27 lots");

  // Metric row 3: capacity pressure 71%
  assert.equal(ui.metricRows[3].value, 71);
  assert.equal(ui.metricRows[3].display, "71%");
  assert.equal(ui.metricRows[3].delta, "−17 pp");

  // Capacity rows: 7 total, taipei + buffer from mock, others from envelope
  assert.equal(ui.capacityRows.length, 7);
  assert.equal(ui.capacityRows[0].dataSource, "mock");          // Taipei
  assert.equal(ui.capacityRows[1].value, 82);                   // Hsinchu (envelope)
  assert.equal(ui.capacityRows[1].dataSource, "envelope");
  assert.equal(ui.capacityRows[4].value, 61);                   // Port = kaohsiung
  assert.equal(ui.capacityRows[5].value, 59);                   // Air = taoyuan
  assert.equal(ui.capacityRows[6].dataSource, "mock");          // Buffer
});

test("cuoptEnvelopeToUiValues falls back per-key when envelope metric missing", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  delete env.metrics.mean_cycle_days;
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  // Row 0 still envelope-sourced
  assert.equal(ui.metricRows[0].dataSource, "envelope");
  // Row 1 (cycle) falls back to mock optimized
  assert.equal(ui.metricRows[1].display, "4.3 days");
  assert.equal(ui.metricRows[1].dataSource, "mock");
});

test("cuoptEnvelopeToUiValues falls back per-key when envelope metric is NaN", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.metrics.weekly_logistics_cost_usd = "not a number";
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.metricRows[0].dataSource, "mock");
  assert.equal(ui.metricRows[0].display, "$5.6M");
});

test("cuoptEnvelopeToUiValues handles missing capacity[] (all mock)", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.capacity = [];
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  for (const row of ui.capacityRows) {
    assert.equal(row.dataSource, "mock");
  }
});

test("cuoptEnvelopeToUiValues handles partial capacity[] (per-row fallback)", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  // Drop tainan from envelope
  env.capacity = env.capacity.filter(c => c.node !== "tainan");
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  // Hsinchu present → envelope
  assert.equal(ui.capacityRows[1].dataSource, "envelope");
  // Tainan dropped → mock
  assert.equal(ui.capacityRows[3].dataSource, "mock");
  assert.equal(ui.capacityRows[3].value, 77);   // mock optimized for Tainan
});

test("cuoptEnvelopeToUiValues clamps weird out-of-range bar values", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.metrics.peak_capacity_pressure = 1.5;       // > 1, should clamp display + bar to 100
  env.metrics.unassigned_priority_lots = 999;     // bar clamp to 100, display shows real
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.metricRows[3].value, 100);
  assert.equal(ui.metricRows[3].display, "150%");   // honest display
  assert.equal(ui.metricRows[2].value, 100);
  assert.equal(ui.metricRows[2].display, "999 lots");
});

test("cuoptEnvelopeToUiValues handles infeasible status (passes through)", () => {
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.status, "infeasible");
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: 9 new tests FAIL.

- [ ] **Step 5: Implement both functions in `app-cuopt.mjs`**

Append to `app-cuopt.mjs`:

```js
// ---- Internal helpers ----

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function fmtSignedMillions(delta) {
  // delta is negative when cost dropped. We display with the U+2212 minus sign
  // to match the existing mock display strings ("−$1.6M").
  const abs = Math.abs(delta) / 1_000_000;
  const rounded = abs.toFixed(1).replace(/\.0$/, "");
  return (delta <= 0 ? "−" : "+") + "$" + rounded + "M";
}

function fmtSignedDays(delta) {
  const abs = Math.abs(delta).toFixed(1).replace(/\.0$/, "");
  return (delta <= 0 ? "−" : "+") + abs + " days";
}

function fmtSignedInt(delta, suffix) {
  return (delta <= 0 ? "−" : "+") + Math.abs(delta) + " " + suffix;
}

function fmtSignedPp(delta) {
  return (delta <= 0 ? "−" : "+") + Math.abs(delta) + " pp";
}

// ---- Metric row builders. Each returns { value, display, delta, dataSource }. ----

function metricRowCost(envelope, mockOpt, mockBase) {
  const usd = envelope?.metrics?.weekly_logistics_cost_usd;
  if (!isFiniteNumber(usd)) return { ...mockOpt, dataSource: "mock" };
  const baselineUsd = parseCostDisplay(mockBase.display);
  const millions = (usd / 1_000_000).toFixed(1).replace(/\.0$/, "");
  return {
    label: mockOpt.label,
    max: mockOpt.max,
    value: clamp(Math.round((usd / (baselineUsd || usd)) * 100), 0, 100),
    display: "$" + millions + "M",
    delta: fmtSignedMillions(usd - (baselineUsd || usd)),
    dataSource: "envelope"
  };
}

function metricRowCycle(envelope, mockOpt, mockBase) {
  const days = envelope?.metrics?.mean_cycle_days;
  if (!isFiniteNumber(days)) return { ...mockOpt, dataSource: "mock" };
  const baseDaysMatch = mockBase.display.match(/([\d.]+)\s*days/);
  const baseDays = baseDaysMatch ? parseFloat(baseDaysMatch[1]) : days;
  const rounded = days.toFixed(1).replace(/\.0$/, "");
  return {
    label: mockOpt.label,
    max: mockOpt.max,
    value: clamp(Math.round(days * 10), 0, 100),
    display: rounded + " days",
    delta: fmtSignedDays(days - baseDays),
    dataSource: "envelope"
  };
}

function metricRowUnassigned(envelope, mockOpt, mockBase) {
  const n = envelope?.metrics?.unassigned_priority_lots;
  if (!isFiniteNumber(n)) return { ...mockOpt, dataSource: "mock" };
  const baseMatch = mockBase.display.match(/(\d+)\s*lots/);
  const baseN = baseMatch ? parseInt(baseMatch[1], 10) : n;
  return {
    label: mockOpt.label,
    max: mockOpt.max,
    value: clamp(Math.round(n), 0, 100),
    display: Math.round(n) + " lots",
    delta: fmtSignedInt(n - baseN, "lots"),
    dataSource: "envelope"
  };
}

function metricRowPressure(envelope, mockOpt, mockBase) {
  const p = envelope?.metrics?.peak_capacity_pressure;
  if (!isFiniteNumber(p)) return { ...mockOpt, dataSource: "mock" };
  const baseMatch = mockBase.display.match(/(\d+)%/);
  const basePct = baseMatch ? parseInt(baseMatch[1], 10) : Math.round(p * 100);
  const pct = Math.round(p * 100);
  return {
    label: mockOpt.label,
    max: mockOpt.max,
    value: clamp(pct, 0, 100),
    display: pct + "%",
    delta: fmtSignedPp(pct - basePct),
    dataSource: "envelope"
  };
}

// ---- Capacity row builder ----

function buildCapacityRow(mockOptRow, mockBaseRow, envelopeNodeUtil) {
  if (isFiniteNumber(envelopeNodeUtil)) {
    return {
      label: mockOptRow.label,
      value: clamp(Math.round(envelopeNodeUtil * 100), 0, 100),
      baseline: mockBaseRow.value,
      dataSource: "envelope"
    };
  }
  return {
    label: mockOptRow.label,
    value: mockOptRow.value,
    baseline: mockBaseRow.value,
    dataSource: "mock"
  };
}

// Reverse the CUOPT_TO_UI_NODE map so UI labels can pick the right envelope node.
const UI_TO_CUOPT_NODE = Object.fromEntries(
  Object.entries(CUOPT_TO_UI_NODE).map(([k, v]) => [v, k])
);

function envelopeCapacityFor(envelope, uiLabel) {
  const cuoptName = UI_TO_CUOPT_NODE[uiLabel];
  if (!cuoptName) return null;
  const entry = (envelope?.capacity || []).find(c => c.node === cuoptName);
  return entry ? entry.utilization : null;
}

// ---- Exported transformers ----

export function cuoptEnvelopeToUiValues(envelope, data) {
  const mockMetricsOpt = data.metrics.optimized;
  const mockMetricsBase = data.metrics.baseline;
  const metricRows = [
    metricRowCost(envelope, mockMetricsOpt[0], mockMetricsBase[0]),
    metricRowCycle(envelope, mockMetricsOpt[1], mockMetricsBase[1]),
    metricRowUnassigned(envelope, mockMetricsOpt[2], mockMetricsBase[2]),
    metricRowPressure(envelope, mockMetricsOpt[3], mockMetricsBase[3])
  ];

  const mockCapOpt = data.capacity.optimized;
  const mockCapBase = data.capacity.baseline;
  const capacityRows = mockCapOpt.map((row, i) =>
    buildCapacityRow(row, mockCapBase[i], envelopeCapacityFor(envelope, row.label))
  );

  return {
    status: envelope.status,
    explanation: envelope.explanation || "",
    metricRows,
    capacityRows
  };
}

export function mockToUiValues(data) {
  const metricRows = data.metrics.optimized.map(row => ({ ...row, dataSource: "mock" }));
  const capacityRows = data.capacity.optimized.map((row, i) => ({
    label: row.label,
    value: row.value,
    baseline: data.capacity.baseline[i].value,
    dataSource: "mock"
  }));
  return { status: "fallback", explanation: "", metricRows, capacityRows };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/cuopt-parser.test.mjs`
Expected: All tests PASS (25 total).

- [ ] **Step 7: Commit**

```bash
git add app-cuopt.mjs tests/cuopt-parser.test.mjs
git commit -m "feat(cuopt): add cuoptEnvelopeToUiValues + mockToUiValues with per-key fallback"
```

---

## Phase 2 — Normalizer changes

### Task 5: Add `cuopt` stage hint to both normalizers

**Files:**
- Modify: `server/normalize-claude.mjs:1-4`
- Modify: `server/normalize-codex.mjs:1-4`

- [ ] **Step 1: Edit `server/normalize-claude.mjs`**

Replace lines 1-4:

```js
const STAGE_HINTS = {
  vision: ["vision_analyze.py", "Vision Insights", "Nemotron Omni"],
  aiq: ["aiq.py", "AIQ Research", "deep_research_running", "research_poll"]
};
```

With:

```js
const STAGE_HINTS = {
  cuopt: ["taiwan_supply_chain", "cuopt.result", "/cuopt/request", "/cuopt/solution"],
  vision: ["vision_analyze.py", "Vision Insights", "Nemotron Omni"],
  aiq: ["aiq.py", "AIQ Research", "deep_research_running", "research_poll"]
};
```

Note: `taiwan_supply_chain` is the unambiguous token; `run.py` is intentionally NOT included because it could match other scripts (vision_analyze isn't named run.py but future scripts might be). The path always carries `taiwan_supply_chain/run.py`, so `taiwan_supply_chain` is sufficient.

- [ ] **Step 2: Edit `server/normalize-codex.mjs` identically**

Make the same change to lines 1-4.

- [ ] **Step 3: Verify with a quick manual check**

Run: `npm test`
Expected: existing static checks still pass.

Then start the server and run a manual end-to-end (this is a sanity check only; full E2E is Phase 5):

```bash
npm start &
sleep 2
curl -N -X POST http://localhost:4173/api/run \
  -H 'Content-Type: application/json' \
  -d '{"harness":"claude","prompt":"call cuopt","surface":"sandbox"}' \
  | head -40
```

Expected: at least one `tool.invoked` beat with `"stage":"cuopt"` if the agent calls the cuopt script. (If the agent doesn't actually call it, that's OK — we're just verifying the normalizer changes parse.)

Kill the server: `kill %1` or close the terminal.

- [ ] **Step 4: Commit**

```bash
git add server/normalize-claude.mjs server/normalize-codex.mjs
git commit -m "feat(cuopt): add cuopt stage hint to both harness normalizers"
```

---

## Phase 3 — `app.js` state and handlers

### Task 6: Import cuopt-parser and add state

**Files:**
- Modify: `app.js:1-3` (imports) and `app.js:6-52` (state object)

- [ ] **Step 1: Add the import**

At the very top of `app.js`, replace lines 1-3:

```js
const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SAMPLE_IMAGE_PATH = "/home/nvidia/gtc-taipei-demo/data/sample-capacity.png";
const PROMPT_STORAGE_KEY = "gtc-taipei-prompt-draft";
```

With:

```js
import {
  parseCuoptToolOutput,
  cuoptEnvelopeToUiValues,
  mockToUiValues,
  looksLikeCuoptResult,
  CUOPT_SCORE_PENALTY
} from "./app-cuopt.mjs";

const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SAMPLE_IMAGE_PATH = "/home/nvidia/gtc-taipei-demo/data/sample-capacity.png";
const PROMPT_STORAGE_KEY = "gtc-taipei-prompt-draft";
```

- [ ] **Step 2: Add the two new state fields**

In the `state` object (currently ends around line 52 with `visionBackgroundBashId: null`), add two new fields just before the closing brace:

Find:

```js
  // When Claude Code's harness backgrounds the vision_analyze.py Bash call
  // (`run_in_background: true`), the first tool result is just the
  // harness's "Command running in background with ID: …" preamble, not the
  // real Nemotron output. We stash the bash_id here and watch subsequent
  // tool results for the actual vision content. See handleToolCompleted.
  visionBackgroundBashId: null
};
```

Replace with:

```js
  // When Claude Code's harness backgrounds the vision_analyze.py Bash call
  // (`run_in_background: true`), the first tool result is just the
  // harness's "Command running in background with ID: …" preamble, not the
  // real Nemotron output. We stash the bash_id here and watch subsequent
  // tool results for the actual vision content. See handleToolCompleted.
  visionBackgroundBashId: null,

  // Same pattern for the cuopt script.
  cuoptBackgroundBashId: null,

  // Sticky: true once applyCuoptResult has committed once for this run.
  // Guards against double-fire (e.g. agent invokes cuopt twice) and lets
  // the setStageSubstate guard + finishRun safety-net know cuopt is settled.
  cuoptResolved: false
};
```

- [ ] **Step 3: Reset both in `applyRunIdleSlate`**

Find `applyRunIdleSlate` (around line 996). Locate the lines that reset visionBackgroundBashId and add the two cuopt resets next to them:

```js
function applyRunIdleSlate() {
  els.console.innerHTML = "";
  state.visionTextAccumulator = "";
  state.visionBackgroundBashId = null;
  state.cuoptBackgroundBashId = null;
  state.cuoptResolved = false;
  state.planTextAccumulator = "";
  // ... rest unchanged
```

- [ ] **Step 4: Reset both in `applyIdleState`**

Find `applyIdleState` (around line 362). It has a similar block. Add the two cuopt resets:

Find:

```js
  state.visionBackgroundBashId = null;
  state.planTextAccumulator = "";
```

Replace with:

```js
  state.visionBackgroundBashId = null;
  state.cuoptBackgroundBashId = null;
  state.cuoptResolved = false;
  state.planTextAccumulator = "";
```

- [ ] **Step 5: Verify the page still loads**

Run: `npm start`
Open `http://localhost:4173` in a browser.
Open the JS console. Expected: no import errors, no runtime errors. The page renders normally.

Kill the server.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): import cuopt-parser module + add cuopt run state"
```

---

### Task 7: Add `animateMetricBars` and `renderMetricsSkeleton`

**Files:**
- Modify: `app.js` — add two new functions next to `renderMetrics` (around line 613)

- [ ] **Step 1: Add `renderMetricsSkeleton` after `renderMetrics`**

Insert after the existing `renderMetrics` function (just past its closing brace):

```js
function renderMetricsSkeleton() {
  // 4 empty rows with pulsing bar-fills. Matches the structure of renderMetrics
  // so animateMetricBars can find .metric-row .bar-fill and tween them.
  const rows = [0, 1, 2, 3].map((ix) => `
    <div class="metric-row is-skeleton" data-row="${ix}">
      <div class="metric-label">
        <div class="metric-label-row">
          <span class="skel-line"></span>
          <strong class="skel-line short"></strong>
        </div>
      </div>
      <div class="bar-track">
        <div class="bar-fill is-pulsing" style="width: 0%"></div>
      </div>
    </div>
  `).join("");
  els.metricBars.innerHTML = rows;
  els.metricBars.classList.add("is-skeleton");
  els.metricsEyebrow.textContent = "Solving…";
}

function animateMetricBars(fromRows, toRows) {
  // If the DOM doesn't currently hold 4 .metric-row elements (e.g. coming out
  // of skeleton or first run), re-render the structure now. We do this in
  // baseline state so animateMetricBars can tween from there.
  if (els.metricBars.querySelectorAll(".metric-row").length !== 4 ||
      els.metricBars.classList.contains("is-skeleton")) {
    renderMetrics("baseline");
  }
  els.metricBars.classList.remove("is-skeleton");
  els.metricBars.classList.remove("is-baseline");
  els.metricBars.classList.add("is-optimized");

  const rowEls = els.metricBars.querySelectorAll(".metric-row");
  toRows.forEach((target, ix) => {
    const li = rowEls[ix];
    if (!li) return;
    const fill = li.querySelector(".bar-fill");
    const fromVal = fromRows[ix].value;
    const toVal = target.value;
    if (fill) {
      tween({
        from: fromVal, to: toVal, duration: 900, easing: easeOutCubic,
        key: `metric-bar-${ix}`,
        onUpdate: (v) => { fill.style.width = v + "%"; }
      });
    }
    // After the bar tween starts, swap in the new display string + delta chip
    // with a small fade so the text doesn't pop while the bar is still moving.
    const labelStrong = li.querySelector(".metric-label-row strong");
    if (labelStrong) {
      labelStrong.style.opacity = "0";
      setTimeout(() => {
        labelStrong.textContent = target.display;
        labelStrong.style.opacity = "1";
      }, 250);
    }
    // Delta chip lives under .metric-label as .metric-delta. Insert or update.
    const labelBlock = li.querySelector(".metric-label");
    let delta = labelBlock.querySelector(".metric-delta");
    if (target.delta) {
      if (!delta) {
        delta = document.createElement("span");
        delta.className = "metric-delta";
        labelBlock.appendChild(delta);
      }
      delta.style.opacity = "0";
      setTimeout(() => {
        delta.textContent = target.delta;
        delta.style.opacity = "1";
      }, 300);
    }
    // Visual hint that this row's value came from a fallback rather than the
    // envelope. CSS uses [data-source="mock"] to tint the bar slightly.
    li.setAttribute("data-source", target.dataSource || "envelope");
  });

  els.metricsEyebrow.textContent = "Optimized";
}
```

- [ ] **Step 2: Add the supporting CSS**

In `styles.css`, find the existing `.metric-bars` block (around line 1383, "Metric bars" section). At the end of that section, add:

```css
.metric-bars.is-skeleton .bar-fill.is-pulsing {
  background: linear-gradient(90deg,
    var(--surface-2) 0%,
    var(--accent-soft) 50%,
    var(--surface-2) 100%);
  background-size: 200% 100%;
  animation: skel-shimmer 1.2s linear infinite;
  width: 60% !important;
}
.skel-line {
  display: inline-block;
  width: 90px;
  height: 12px;
  border-radius: 3px;
  background: var(--surface-2);
  vertical-align: middle;
}
.skel-line.short { width: 50px; height: 10px; }
.metric-row[data-source="mock"] .bar-fill {
  /* Subtle dotted overlay marks "this row is from the reference plan" */
  background-image: repeating-linear-gradient(
    -45deg,
    transparent 0 4px,
    rgba(0,0,0,0.06) 4px 5px);
}
.metric-label-row strong,
.metric-delta {
  transition: opacity 220ms ease;
}
@keyframes skel-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 3: Verify the page still renders**

Run: `npm start`. Open `http://localhost:4173`. The metric panel should still render at baseline — no skeleton, no animation yet, because nothing calls the new functions.

Open the JS console and manually invoke:

```js
renderMetricsSkeleton();
```

Expected: the 4 metric rows turn into pulsing skeletons. Then:

```js
animateMetricBars(state.data.metrics.baseline, state.data.metrics.optimized.map(r => ({...r, dataSource:"mock"})));
```

Expected: bars tween from baseline to optimized values, display strings and deltas appear. Kill the server.

- [ ] **Step 4: Commit**

```bash
git add app.js styles.css
git commit -m "feat(cuopt): add animateMetricBars + renderMetricsSkeleton"
```

---

### Task 8: Add the capacity-panel HTML and CSS

**Files:**
- Modify: `index.html` — inside `<div id="canvas-cuopt">` (around line 232)
- Modify: `styles.css` — append new section

- [ ] **Step 1: Edit `index.html`**

Find the `<!-- Stage 2: cuOpt Solve -->` block (around line 231-242). Currently:

```html
<div class="stage-canvas" id="canvas-cuopt" data-stage-canvas="cuopt" role="tabpanel" aria-labelledby="stage-tab-cuopt" hidden>
  <article class="panel metric-panel" aria-labelledby="metrics-title">
    <div class="panel-heading">
      <div>
        <span class="eyebrow" id="metrics-eyebrow">Baseline today</span>
        <h2 id="metrics-title">Route economics</h2>
      </div>
    </div>
    <div class="metric-bars" id="metric-bars"></div>
  </article>
</div>
```

Add a second `<article>` inside `#canvas-cuopt` after the metric-panel:

```html
<div class="stage-canvas" id="canvas-cuopt" data-stage-canvas="cuopt" role="tabpanel" aria-labelledby="stage-tab-cuopt" hidden>
  <article class="panel metric-panel" aria-labelledby="metrics-title">
    <div class="panel-heading">
      <div>
        <span class="eyebrow" id="metrics-eyebrow">Baseline today</span>
        <h2 id="metrics-title">Route economics</h2>
      </div>
    </div>
    <div class="metric-bars" id="metric-bars"></div>
  </article>

  <article class="panel capacity-panel" aria-labelledby="capacity-title">
    <div class="panel-heading">
      <div>
        <span class="eyebrow" id="capacity-eyebrow">Per-node utilization</span>
        <h2 id="capacity-title">Capacity pressure</h2>
      </div>
      <span class="confidence-chip is-quiet" id="capacity-source">reference plan</span>
    </div>
    <div class="capacity-bars" id="capacity-bars" role="list"></div>
    <p class="capacity-explanation" id="capacity-explanation" hidden></p>
  </article>
</div>
```

- [ ] **Step 2: Append capacity-panel CSS to `styles.css`**

At the end of `styles.css`, before the final media-query block (around line 2470), add:

```css
/* ---------- Capacity panel (Stage 2, below metric-panel) ---------- */
.capacity-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.capacity-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 22px 18px;
}
.capacity-row {
  display: grid;
  grid-template-columns: 90px 1fr 70px;
  align-items: center;
  gap: 12px;
  font-size: 0.82rem;
}
.capacity-row .capacity-label {
  color: var(--ink-dim);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.capacity-track {
  position: relative;
  height: 14px;
  border-radius: 7px;
  background: var(--surface-2);
  overflow: hidden;
}
.capacity-fill-baseline {
  position: absolute;
  inset: 0;
  width: var(--baseline-pct, 0%);
  background: var(--ink-mute);
  opacity: 0.35;
  border-radius: 7px;
}
.capacity-fill-optimized {
  position: absolute;
  inset: 0;
  width: var(--optimized-pct, 0%);
  background: linear-gradient(90deg, #76b900 0%, #00c3ff 100%);
  border-radius: 7px;
  transition: width 700ms cubic-bezier(.22,.61,.36,1);
}
.capacity-row[data-source="mock"] .capacity-fill-optimized {
  background-image: repeating-linear-gradient(
    -45deg,
    transparent 0 4px,
    rgba(0,0,0,0.08) 4px 5px);
}
.capacity-delta {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--accent-green, #2c8c00);
  text-align: right;
}
.capacity-delta.is-buffer-positive { color: var(--accent-amber, #b07000); }
.capacity-row.is-skeleton .capacity-fill-baseline,
.capacity-row.is-skeleton .capacity-fill-optimized {
  animation: skel-shimmer 1.2s linear infinite;
  background-size: 200% 100%;
}
.capacity-explanation {
  margin: 0 22px 18px;
  font-size: 0.85rem;
  color: var(--ink-dim);
  line-height: 1.45;
  font-style: italic;
}
.confidence-chip.is-warn {
  background: var(--accent-amber-soft, #fff3d6);
  color: var(--accent-amber, #8b5a00);
}
```

- [ ] **Step 3: Verify the page renders the new (empty) panel**

Run: `npm start`. Open `http://localhost:4173`. Click the "cuOpt Solve" rail pill. The new capacity panel should appear below the metric panel — empty, with the "reference plan" chip in its top-right.

Kill the server.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(cuopt): add capacity-panel structure + styles to Stage 2 canvas"
```

---

### Task 9: Implement `renderCapacityChart` and `renderCapacitySkeleton`

**Files:**
- Modify: `app.js` — add two new functions (next to `renderMetricsSkeleton`)
- Modify: `app.js:198` (collectEls) — collect new elements

- [ ] **Step 1: Add element refs in `collectEls`**

In `collectEls` (around line 176), after the existing `els.metricsEyebrow = ...` line, add:

```js
els.capacityBars = document.querySelector("#capacity-bars");
els.capacityExplanation = document.querySelector("#capacity-explanation");
els.capacitySource = document.querySelector("#capacity-source");
```

- [ ] **Step 2: Add render functions after `animateMetricBars`**

Append in `app.js`:

```js
function renderCapacitySkeleton() {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((ix) => `
    <div class="capacity-row is-skeleton" role="listitem" data-row="${ix}">
      <span class="capacity-label">…</span>
      <div class="capacity-track">
        <div class="capacity-fill-baseline" style="--baseline-pct: 0%"></div>
        <div class="capacity-fill-optimized" style="--optimized-pct: 0%"></div>
      </div>
      <span class="capacity-delta">—</span>
    </div>
  `).join("");
  els.capacityBars.innerHTML = rows;
  els.capacityExplanation.hidden = true;
  els.capacitySource.className = "confidence-chip is-quiet";
  els.capacitySource.textContent = "solving…";
}

function renderCapacityChart(rows, status, explanation) {
  const chipText = status === "solved" ? "from cuOpt"
                  : status === "infeasible" ? "cuOpt partial"
                  : "reference plan";
  const chipClass = status === "solved" ? "confidence-chip"
                   : status === "infeasible" ? "confidence-chip is-warn"
                   : "confidence-chip is-quiet";
  els.capacitySource.className = chipClass;
  els.capacitySource.textContent = chipText;

  els.capacityBars.innerHTML = rows.map((row) => {
    const delta = row.value - row.baseline;
    // Buffer is the only node where a positive delta (higher utilization) is good.
    const isBuffer = row.label === "Buffer";
    const deltaClass = isBuffer && delta > 0 ? "capacity-delta is-buffer-positive"
                      : "capacity-delta";
    const deltaText = delta === 0 ? "—"
                     : (delta < 0 ? "−" : "+") + Math.abs(delta);
    return `
      <div class="capacity-row" role="listitem" data-source="${row.dataSource}" data-node="${escapeHtml(row.label)}">
        <span class="capacity-label">${escapeHtml(row.label)}</span>
        <div class="capacity-track">
          <div class="capacity-fill-baseline" style="--baseline-pct: ${row.baseline}%"></div>
          <div class="capacity-fill-optimized" style="--optimized-pct: 0%"></div>
        </div>
        <span class="${deltaClass}">${escapeHtml(deltaText)}</span>
      </div>
    `;
  }).join("");

  // Trigger the optimized-fill animation with a one-frame delay so the
  // browser commits the initial 0% width before transitioning to the target.
  requestAnimationFrame(() => {
    els.capacityBars.querySelectorAll(".capacity-row").forEach((el, ix) => {
      const opt = el.querySelector(".capacity-fill-optimized");
      if (opt) opt.style.setProperty("--optimized-pct", rows[ix].value + "%");
    });
  });

  if (explanation) {
    els.capacityExplanation.textContent = explanation;
    els.capacityExplanation.hidden = false;
  } else {
    els.capacityExplanation.hidden = true;
  }
}
```

- [ ] **Step 3: Verify by manual invocation**

Run: `npm start`. Open the page. Open the JS console:

```js
renderCapacitySkeleton();
```

Expected: 7 skeleton capacity rows render. Then:

```js
renderCapacityChart(
  state.data.capacity.optimized.map((r, i) => ({
    label: r.label,
    value: r.value,
    baseline: state.data.capacity.baseline[i].value,
    dataSource: "mock"
  })),
  "fallback",
  ""
);
```

Expected: 7 rows animate. Each row has a translucent baseline bar and a gradient optimized bar with a tiny dotted overlay (the mock-source visual). Chip says "reference plan". No explanation shown.

Then:

```js
renderCapacityChart(
  state.data.capacity.optimized.map((r, i) => ({
    label: r.label,
    value: r.value,
    baseline: state.data.capacity.baseline[i].value,
    dataSource: i % 2 === 0 ? "envelope" : "mock"
  })),
  "solved",
  "Solved on cuOpt with 6 vehicles across 5 lanes."
);
```

Expected: chip says "from cuOpt". Rows alternate dotted/solid optimized bars. Explanation paragraph shown.

Kill the server.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): implement renderCapacityChart + renderCapacitySkeleton"
```

---

### Task 10: Implement `applyCuoptResult`

**Files:**
- Modify: `app.js` — add the function next to the other beat-handler helpers (just before `handleAssistantText` is a natural spot — around line 1109)

- [ ] **Step 1: Add the function**

Insert just before `handleAssistantText` in `app.js`:

```js
function applyCuoptResult(result) {
  if (state.cuoptResolved) return;         // idempotent commit
  state.cuoptResolved = true;

  const ui = result.status === "fallback"
    ? mockToUiValues(state.data)
    : cuoptEnvelopeToUiValues(result.envelope, state.data);

  // Metric bars: animate baseline → ui.metricRows
  animateMetricBars(state.data.metrics.baseline, ui.metricRows);

  // Capacity chart
  renderCapacityChart(ui.capacityRows, ui.status, ui.explanation);

  // Map state + supporting routes (reveal-supports delayed so the active
  // route's CSS transition lands first)
  setMapStatus(result.status === "infeasible" ? "solving" : "solved");
  applyMapRoute("reveal-active");
  applyMapRoute("fade-baseline");
  setTimeout(() => applyMapRoute("reveal-supports"), 200);

  // Score
  const penalty = CUOPT_SCORE_PENALTY[result.status] ?? CUOPT_SCORE_PENALTY.fallback;
  const targetScore = state.optimizedScore - penalty;
  animateScore(state.currentScore, Math.max(state.currentScore, targetScore), 1400);

  // Stage and copy
  setStageSubstate("cuopt", "done");
  els.metricsEyebrow.textContent = "Optimized";

  if (result.status === "fallback") {
    showToast("warn", `cuOpt returned no usable data (${result.reason}) — showing reference plan.`);
    addConsoleEntry("cuopt", `cuOpt fallback (${result.reason}). Reference plan shown.`);
  } else if (result.status === "infeasible") {
    showToast("warn", "cuOpt returned a best-effort infeasible solution.");
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "infeasible"}`);
  } else {
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "solved"}`);
  }
}
```

- [ ] **Step 2: Wire `showToast` for the new `warn` level**

`showToast` currently handles `"error"` and `"info"`. Find it (around line 2073) and add the warn class:

Find:

```js
function showToast(level, text, timeoutMs = 6000) {
  const stack = els.toastStack;
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast " + (level === "error" ? "is-error" : "is-info");
```

Replace with:

```js
function showToast(level, text, timeoutMs = 6000) {
  const stack = els.toastStack;
  if (!stack) return;
  const toast = document.createElement("div");
  const cls = level === "error" ? "is-error"
            : level === "warn"  ? "is-warn"
            : "is-info";
  toast.className = "toast " + cls;
```

- [ ] **Step 3: Add `.toast.is-warn` styling**

In `styles.css`, find the existing `.toast` rules. Add (next to any `.toast.is-error` block):

```css
.toast.is-warn {
  background: var(--accent-amber-soft, #fff3d6);
  border-color: var(--accent-amber, #b07000);
  color: var(--accent-amber, #8b5a00);
}
```

- [ ] **Step 4: Verify manually**

Run: `npm start`. Open the page. Open the JS console:

```js
applyCuoptResult({ status: "fallback", reason: "test" });
```

Expected: metric bars animate baseline → mock optimized, capacity chart populates with the mock values, map routes light up, score climbs to 71 (91 - 20), toast appears warning about "test", run trace gets an entry.

Reload page. Then test the solved path:

```js
state.cuoptResolved = false;  // reset so it'll fire again
applyCuoptResult({
  status: "solved",
  envelope: {
    kind: "cuopt.result", status: "solved",
    objective_value: 4321, selected_lanes: [],
    metrics: { weekly_logistics_cost_usd: 5600000, mean_cycle_days: 4.3, unassigned_priority_lots: 4, peak_capacity_pressure: 0.71 },
    capacity: [{node:"hsinchu",utilization:0.82},{node:"taichung",utilization:0.68},{node:"tainan",utilization:0.77},{node:"kaohsiung",utilization:0.61},{node:"taoyuan",utilization:0.59}],
    explanation: "Solved on cuOpt with 6 vehicles across 5 lanes."
  }
});
```

Expected: same animation flow but no toast, no warning. Score climbs to 91. Capacity chart shows envelope-sourced rows + mock Taipei/Buffer. Explanation paragraph visible.

Kill the server.

- [ ] **Step 5: Commit**

```bash
git add app.js styles.css
git commit -m "feat(cuopt): implement applyCuoptResult commit-point + warn toast level"
```

---

### Task 11: Wire `handleToolInvoked` cuopt branch

**Files:**
- Modify: `app.js:1140-1163` — `handleToolInvoked`

- [ ] **Step 1: Add the cuopt branch and remove the dead "leave cuopt idle" branch**

Find the current `handleToolInvoked`:

```js
function handleToolInvoked({ id, name, input, stage }) {
  if (stage === "vision") {
    setStageSubstate("vision", "calling");
    els.visionConfidence.textContent = "analyzing";
    els.visionConfidence.className = "confidence-chip is-analyzing";
    if (els.visionImageWrap) els.visionImageWrap.classList.add("is-analyzing");
  } else if (stage === "aiq") {
    setStageSubstate("aiq", "calling");
    els.researchDepth.textContent = "researching";
    els.researchDepth.className = "confidence-chip is-analyzing";
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
    if (state.visionBackgroundBashId) {
      addConsoleEntry("vision", "Vision background still pending when AIQ started — finalizing.");
      finalizeVisionDone();
      state.visionBackgroundBashId = null;
    }
  } else if (state.stageState.cuopt === "idle" && stage === "general") {
    /* leave cuopt idle for skipping later */
  }
  const skillId = matchSkill(name, input);
  if (skillId) markSkillCalled(skillId);
  renderToolEntry({ id, name, stage, input, status: "running", skillId });
}
```

Replace with:

```js
function handleToolInvoked({ id, name, input, stage }) {
  if (stage === "cuopt") {
    setStageSubstate("cuopt", "calling");
    applyMapRoute("shimmer");
    setMapStatus("solving");
    renderMetricsSkeleton();
    renderCapacitySkeleton();
  } else if (stage === "vision") {
    setStageSubstate("vision", "calling");
    els.visionConfidence.textContent = "analyzing";
    els.visionConfidence.className = "confidence-chip is-analyzing";
    if (els.visionImageWrap) els.visionImageWrap.classList.add("is-analyzing");
  } else if (stage === "aiq") {
    setStageSubstate("aiq", "calling");
    els.researchDepth.textContent = "researching";
    els.researchDepth.className = "confidence-chip is-analyzing";
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
    if (state.visionBackgroundBashId) {
      addConsoleEntry("vision", "Vision background still pending when AIQ started — finalizing.");
      finalizeVisionDone();
      state.visionBackgroundBashId = null;
    }
  }
  const skillId = matchSkill(name, input);
  if (skillId) markSkillCalled(skillId);
  renderToolEntry({ id, name, stage, input, status: "running", skillId });
}
```

- [ ] **Step 2: Verify by manual exercise**

Run: `npm start`. Open the page. Open the JS console:

```js
handleToolInvoked({ id: "test-1", name: "Bash", input: { command: "python3 taiwan_supply_chain/run.py" }, stage: "cuopt" });
```

Expected: cuopt rail pill turns to "calling" (orange ring), metric panel shows skeleton, capacity panel shows skeleton, map status flips to "solving…", baseline route shimmers.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): wire handleToolInvoked cuopt branch + remove dead skip-cuopt branch"
```

---

### Task 12: Wire `handleToolCompleted` cuopt branch (incl. Layer 2/3 background handling)

**Files:**
- Modify: `app.js:1167-1222` — `handleToolCompleted`

- [ ] **Step 1: Add the cuopt branch**

Find `handleToolCompleted`. After the section that calls `updateToolEntry` and `markSkillCompleted` (line ~1175), insert the cuopt branch BEFORE the existing vision branch:

Find the line:

```js
  if (isError) {
    addConsoleEntry(stage || "general", `Tool ${name || ""} failed · expand entry for stderr.`);
  }

  if (stage === "vision" && !isError) {
```

Replace with:

```js
  if (isError) {
    addConsoleEntry(stage || "general", `Tool ${name || ""} failed · expand entry for stderr.`);
  }

  if (stage === "cuopt") {
    if (state.cuoptResolved) {
      addConsoleEntry("cuopt", "cuopt completed again — ignoring duplicate.");
      return;
    }
    const cleaned = (stdout || "").trim();
    const bgMatch = cleaned.match(/Command running in background with ID:\s*([\w-]+)/i);
    if (bgMatch && !isError) {
      state.cuoptBackgroundBashId = bgMatch[1];
      setStageSubstate("cuopt", "streaming");
      addConsoleEntry("cuopt", `cuopt backgrounded by harness (bash id ${bgMatch[1].slice(0,8)}). Waiting for output…`);
      return;
    }
    const result = parseCuoptToolOutput(stdout, isError);
    applyCuoptResult(result);
    return;
  }

  // Layer 3: cuopt sat in the background; look for its real output in any
  // subsequent tool result. Mirrors the vision background-capture pattern.
  if (state.cuoptBackgroundBashId && !isError && stage !== "cuopt" &&
      !state.cuoptResolved && looksLikeCuoptResult(stdout)) {
    const result = parseCuoptToolOutput(stdout, false);
    applyCuoptResult(result);
    state.cuoptBackgroundBashId = null;
    addConsoleEntry("cuopt", "Captured backgrounded cuopt output.");
  }

  if (stage === "vision" && !isError) {
```

- [ ] **Step 2: Verify with manual fake beats**

Run: `npm start`. Open the page. Click Run (use the default prompt). While it's running, in another terminal:

```bash
curl -s http://localhost:4173 > /dev/null  # just to verify server up
```

You don't need a real cuopt to test — open JS console on the page mid-run and fake the beats:

```js
handleToolInvoked({ id: "fake-cuopt-1", name: "Bash", input: { command: "python3 .../taiwan_supply_chain/run.py" }, stage: "cuopt" });
// Wait 2s
setTimeout(() => {
  handleToolCompleted({
    id: "fake-cuopt-1", name: "Bash", stage: "cuopt", isError: false,
    stdout: JSON.stringify({
      kind: "cuopt.result", status: "solved",
      objective_value: 4321, selected_lanes: [],
      metrics: { weekly_logistics_cost_usd: 5600000, mean_cycle_days: 4.3, unassigned_priority_lots: 4, peak_capacity_pressure: 0.71 },
      capacity: [{node:"hsinchu",utilization:0.82},{node:"taichung",utilization:0.68},{node:"tainan",utilization:0.77},{node:"kaohsiung",utilization:0.61},{node:"taoyuan",utilization:0.59}],
      explanation: "Solved on cuOpt with 6 vehicles across 5 lanes."
    })
  });
}, 2000);
```

Expected: cuopt pill goes calling → done. Metrics + capacity + map + score all animate to optimized. No toast.

Now test the background path. Reload page, click Run, then:

```js
handleToolInvoked({ id: "fake-cuopt-2", name: "Bash", input: { command: "python3 .../taiwan_supply_chain/run.py" }, stage: "cuopt" });
handleToolCompleted({
  id: "fake-cuopt-2", name: "Bash", stage: "cuopt", isError: false,
  stdout: "Command running in background with ID: bash-xyz-123"
});
```

Expected: cuopt pill goes calling → streaming. Skeleton stays. Console entry "cuopt backgrounded by harness…".

Then simulate the Layer 3 capture:

```js
handleToolCompleted({
  id: "fake-followup", name: "Bash", stage: "general", isError: false,
  stdout: JSON.stringify({
    kind: "cuopt.result", status: "solved",
    metrics: { weekly_logistics_cost_usd: 5600000, mean_cycle_days: 4.3, unassigned_priority_lots: 4, peak_capacity_pressure: 0.71 },
    capacity: [{node:"hsinchu",utilization:0.82}],
    explanation: "Captured."
  })
});
```

Expected: cuopt pill flips to done, metrics animate, capacity shows hsinchu envelope + rest mock, console entry "Captured backgrounded cuopt output."

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): wire handleToolCompleted cuopt branch with bg-mode capture"
```

---

### Task 13: Add the implicit-fallback guard in `setStageSubstate`

**Files:**
- Modify: `app.js:1662-1677` — `setStageSubstate`

- [ ] **Step 1: Edit `setStageSubstate`**

Find:

```js
function setStageSubstate(stage, substate) {
  state.stageState[stage] = substate;
  if (substate === "calling" || substate === "streaming") {
    autoAdvance(stage);
  }
```

Replace with:

```js
function setStageSubstate(stage, substate) {
  // If vision or AIQ starts before cuopt was ever invoked, treat that as
  // an implicit "cuopt was skipped" signal and fire the fallback path so
  // the audience still sees baseline → optimized for Stage 2.
  if ((stage === "vision" || stage === "aiq") &&
      (substate === "calling" || substate === "streaming") &&
      state.stageState.cuopt === "idle" &&
      !state.cuoptResolved) {
    applyCuoptResult({ status: "fallback", reason: "not_invoked" });
    // applyCuoptResult sets state.cuoptResolved itself.
  }

  state.stageState[stage] = substate;
  if (substate === "calling" || substate === "streaming") {
    autoAdvance(stage);
  }
```

- [ ] **Step 2: Verify the guard fires correctly**

Run: `npm start`. Open the page. Click Run. In the JS console:

```js
// Skip cuopt; go straight to vision
handleToolInvoked({ id: "fake-vision-1", name: "Bash", input: { command: "python3 vision_analyze.py" }, stage: "vision" });
```

Expected: cuopt pill animates to done via fallback (warn toast, score climbs to 71, capacity chip "reference plan"); then vision pill goes to calling.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): implicit fallback when vision/aiq fires before cuopt"
```

---

### Task 14: Add the `finishRun` safety-net

**Files:**
- Modify: `app.js:1805-1854` — `finishRun`

- [ ] **Step 1: Edit `finishRun`**

Find the beginning of `finishRun`:

```js
function finishRun(data) {
  if (!state.running && state.completed) return;
  state.running = false;
  state.completed = true;
```

Add the safety-net right after the early return guard:

```js
function finishRun(data) {
  if (!state.running && state.completed) return;
  state.running = false;
  state.completed = true;

  // Safety-net: if the run completed while cuopt was still streaming (e.g. the
  // harness backgrounded the call and never surfaced the real output), or if
  // the agent never called cuopt at all, fire the fallback now so the UI
  // doesn't end on a skeleton or a "skipped" rail pip.
  if (!state.cuoptResolved) {
    applyCuoptResult({
      status: "fallback",
      reason: state.cuoptBackgroundBashId ? "background_timeout" : "not_invoked"
    });
  }
```

- [ ] **Step 2: Verify the safety-net**

Run: `npm start`. Click Run, then immediately:

```js
fireBeat({ kind: "run.completed", data: { exitCode: 0, durationMs: 100 } });
```

Expected: cuopt pill animates to done via fallback (reason "not_invoked"), warn toast fires. Run shows complete.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(cuopt): finishRun safety-net guarantees cuopt always resolves"
```

---

### Task 15: Register cuopt in `data.skillMap` + verify skill chip

**Files:**
- Modify: `data/supply-chain.json:33-36`

- [ ] **Step 1: Edit `skillMap`**

Find:

```json
"skillMap": {
  "vision_analyze.py": "vision",
  "aiq.py": "aiq"
},
```

Replace with:

```json
"skillMap": {
  "taiwan_supply_chain": "cuopt",
  "cuopt.result": "cuopt",
  "vision_analyze.py": "vision",
  "aiq.py": "aiq"
},
```

- [ ] **Step 2: Run `npm test` to ensure data-shape checks still pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Verify the cuopt skill chip lights up**

The existing `matchSkill` in app.js uses `data.skills[*].match[]`, not `skillMap`. The cuopt skill chip already has `match: ["cuopt", "routing-formulation", ...]` — confirm by reading `data/supply-chain.json`. The `skillMap` addition is for `data.stageLabels`-driven console entries; it's harmless if unused but keeps the data shape coherent for future code.

Start the server, click Run, watch the trace pane: when a cuopt tool fires the cuopt skill chip should light up. (You can fake this via the JS console as in Task 12.)

- [ ] **Step 4: Commit**

```bash
git add data/supply-chain.json
git commit -m "feat(cuopt): register cuopt tokens in data.skillMap"
```

---

## Phase 4 — Manual end-to-end verification

### Task 16: Real-cuopt end-to-end on the sandbox surface

**No files modified.** This task is verification.

- [ ] **Step 1: Confirm sandbox is reachable**

```bash
curl -s http://localhost:4173/api/sandbox/status || true   # only meaningful after npm start
```

Run server: `npm start`

Open `http://localhost:4173`. Sandbox chip should show "openshell · my-assistant" in green.

- [ ] **Step 2: Run the default prompt with Codex**

Click Run. Default prompt should be the one in `data/default-prompt.txt`, which asks for cuopt → vision → aiq.

Expected (Codex):
- cuopt pill: idle → calling → done (with envelope-sourced explanation in trace)
- Metric bars: animate baseline → envelope numbers ($5.6M, 4.3 days, etc.)
- Capacity chart: 5 envelope-sourced rows + Taipei/Buffer mock rows. Chip says "from cuOpt". Explanation paragraph visible.
- Map: routes light up
- Score: climbs to 91
- Vision pill, AIQ pill: follow normally
- Final: 4 plan tabs

- [ ] **Step 3: Run the same prompt with Claude**

Switch harness toggle to Claude. Click Run again.
Expected: same end state. Cuopt may take longer (Claude's tool-call overhead). Background-mode preamble path may trigger if Claude's harness backgrounds the call — confirm by checking for a "Captured backgrounded cuopt output" trace entry.

- [ ] **Step 4: Document any anomalies in the trace**

Take notes on:
- Total elapsed run time per harness
- Whether the cuopt envelope's numbers match the mock optimized values (they should be approximately equal by design)
- Any toasts that fired (should be none on the clean path)

- [ ] **Step 5: No commit** (verification only)

---

### Task 17: Fallback paths end-to-end

**No files modified.** This task is verification.

- [ ] **Step 1: Test parse_failed**

In the JS console mid-run:

```js
state.cuoptResolved = false;
handleToolCompleted({
  id: "bad-1", name: "Bash", stage: "cuopt", isError: false, stdout: "this is not json"
});
```

Expected: warn toast "cuOpt returned no usable data (parse_failed)…", metric bars animate to mock optimized, capacity chip "reference plan", score climbs to 71.

- [ ] **Step 2: Test script_error**

```js
state.cuoptResolved = false;
handleToolCompleted({
  id: "bad-2", name: "Bash", stage: "cuopt", isError: true, stdout: ""
});
```

Expected: warn toast "cuOpt returned no usable data (script_error)…", same animation.

- [ ] **Step 3: Test infeasible**

```js
state.cuoptResolved = false;
handleToolCompleted({
  id: "bad-3", name: "Bash", stage: "cuopt", isError: true,
  stdout: JSON.stringify({
    kind: "cuopt.result", status: "infeasible",
    metrics: { weekly_logistics_cost_usd: 5600000, mean_cycle_days: 4.3, unassigned_priority_lots: 12, peak_capacity_pressure: 0.78 },
    capacity: [{node:"hsinchu",utilization:0.88}],
    explanation: "Partial routes only."
  })
});
```

Expected: warn toast "cuOpt returned a best-effort infeasible solution.", capacity chip "cuOpt partial", score climbs to 76 (91-15).

- [ ] **Step 4: Test "agent never invokes cuopt"**

Reload page. Click Run, then immediately:

```js
handleToolInvoked({ id: "early-vision", name: "Bash", input: { command: "vision_analyze.py" }, stage: "vision" });
```

Expected: cuopt pill flashes calling-then-done via implicit fallback (reason "not_invoked"), vision pill becomes calling.

- [ ] **Step 5: Test double-invoke idempotency**

Reload. Click Run. In console:

```js
handleToolInvoked({ id: "c1", name: "Bash", input: { command: "taiwan_supply_chain" }, stage: "cuopt" });
handleToolCompleted({ id: "c1", name: "Bash", stage: "cuopt", isError: false,
  stdout: JSON.stringify({kind:"cuopt.result", status:"solved", metrics:{weekly_logistics_cost_usd:5600000,mean_cycle_days:4.3,unassigned_priority_lots:4,peak_capacity_pressure:0.71}, capacity:[]}) });
handleToolCompleted({ id: "c2", name: "Bash", stage: "cuopt", isError: false,
  stdout: JSON.stringify({kind:"cuopt.result", status:"solved", metrics:{weekly_logistics_cost_usd:5600000,mean_cycle_days:4.3,unassigned_priority_lots:4,peak_capacity_pressure:0.71}, capacity:[]}) });
```

Expected: second handleToolCompleted prints "cuopt completed again — ignoring duplicate." No double animation, no second toast.

- [ ] **Step 6: Kill the cuopt server, real end-to-end**

```bash
# In another terminal, stop the cuopt server (whatever the GB10 management command is —
# adapt as needed). For testing, just block port 8002:
sudo iptables -A OUTPUT -p tcp --dport 8002 -j REJECT   # (or whatever blocks egress to 8002)
```

Re-run a full demo prompt. Expected: cuopt script exits non-zero, fallback path triggers, demo continues with vision + AIQ as normal.

Remove the iptables rule after:

```bash
sudo iptables -D OUTPUT -p tcp --dport 8002 -j REJECT
```

If iptables isn't an option, just stop the cuopt server process itself.

- [ ] **Step 7: No commit** (verification only)

---

## Phase 5 — Docs reconciliation

### Task 18: Fix CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the event-kinds list**

Find the "Event contract (frontend ↔ orchestrator)" section, currently:

```markdown
The orchestrator writes NDJSON beats of the form `{ "kind": "...", "data": {...} }`. Notable kinds:

- `surface.info` — which surface was chosen and why.
- `run.registered` — runId, harness, surface, cmd.
- `stage.started`, `stage.progress`, `artifact.created`, `stage.completed` — synthesized by the per-harness normalizer.
- `log` — surfaced stderr / non-JSON lines.
- `run.completed`, `run.failed`, `run.cancelled` — terminal beats. Exactly one is emitted per run.

`docs/integration-plan.md` documents the longer-term event types (`stage.*`, `run.*`) that the UI is designed around. Preserve those names when extending.
```

Replace with:

```markdown
The orchestrator writes NDJSON beats of the form `{ "kind": "...", "data": {...} }`. Emitted kinds:

- `surface.info` — which surface was chosen and why.
- `run.registered` — runId, harness, surface, cmd.
- `run.started` — synthesized by the harness normalizer on first `init`/`thread.started` event.
- `tool.invoked` — synthesized when the harness begins a tool call; carries `{ id, name, input, stage }`. `stage` is one of `"cuopt"`, `"vision"`, `"aiq"`, or `"general"` (the normalizer infers it from the tool input).
- `tool.completed` — synthesized when the harness returns a tool result; carries `{ id, name, stage, stdout, stderr, isError, durationMs }`.
- `assistant.text` — synthesized for any free-text assistant message.
- `log` — surfaced stderr / non-JSON lines; level ∈ `"warn"`, `"stderr"`, `"info"`, `"debug"`.
- `run.completed`, `run.failed`, `run.cancelled` — terminal beats. Exactly one is emitted per run.

Stage transitions on the frontend are derived from `tool.invoked` / `tool.completed` beats — there is no explicit `stage.*` event from the orchestrator. See `docs/integration-plan.md` for how to add a new stage.
```

- [ ] **Step 2: Add the cuopt-live paragraph in "Skills the harness will call"**

Find the existing list of skills. Before the line "The cuOpt skill is currently mocked through `data/supply-chain.json`." insert:

```markdown
- `python3 skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` — runs the Taiwan supply-chain solve against the local cuOpt REST server at `host.openshell.internal:8002`. Prints a JSON envelope `{kind:"cuopt.result", status, selected_lanes, metrics, capacity, explanation}` on stdout. Typical runtime 2–15s. Exit codes 2 (request failed), 3 (poll timeout), 4 (solver non-success) all still print a usable envelope on stdout where they can.
```

And replace the sentence "The cuOpt skill is currently mocked through `data/supply-chain.json`." with:

```markdown
The frontend parses the cuOpt envelope client-side via `parseCuoptToolOutput` in `app-cuopt.mjs`. On any failure (script exit, parse failure, infeasible solve, agent skipped) the UI silently falls back to the reference plan in `data/supply-chain.json` and surfaces a warn toast — the demo never dead-ends on cuopt. See `skills/cuopt/contract.md` for the envelope schema.
```

- [ ] **Step 3: Add a "What not to do" entry**

In the "What not to do" section, append:

```markdown
- Do not silently rename or remove cuOpt envelope fields without updating `app-cuopt.mjs:cuoptEnvelopeToUiValues` AND the smoke-test assertion list in `scripts/check.mjs`.
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS (still works because we haven't added the doc-equality gate yet).

Open `CLAUDE.md` in a viewer. Skim for typos / formatting issues.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): correct event-kinds list, document cuopt live + fallback"
```

---

### Task 19: Copy CLAUDE.md → AGENTS.md

**Files:**
- Replace: `AGENTS.md`

- [ ] **Step 1: Copy the file**

```bash
cp CLAUDE.md AGENTS.md
```

- [ ] **Step 2: Verify byte equality**

```bash
diff CLAUDE.md AGENTS.md
```

Expected: no output (files identical).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): replace AGENTS.md with verbatim copy of corrected CLAUDE.md"
```

---

### Task 20: Rewrite `skills/aiq-research/SKILL.md`

**Files:**
- Replace: `skills/aiq-research/SKILL.md`

- [ ] **Step 1: Write the new file**

Replace the entire contents of `skills/aiq-research/SKILL.md` with (shown here in a 4-backtick fence so the inner ```bash blocks render correctly):

````markdown
---
name: aiq-research
description: Run shallow, citation-backed enterprise research via NVIDIA AIQ Blueprint's shallow_researcher agent. Deep research is intentionally disabled in this demo context.
version: "3.0.0"
metadata:
  author: "Chantal D Gama Rose <cdgamarose@nvidia.com>"
  audience: gtc-taipei-demo
  tags:
    - research
    - aiq
    - shallow-only
---

# AIQ Research Skill

Use this skill to run a **shallow** research query against the NVIDIA AIQ Blueprint backend through the local helper script at `skills/aiq-research/scripts/aiq.py`.

> **Important — read first.** This skill is configured for the GTC Taipei demo, which deliberately uses only the shallow research path. Do NOT call `aiq.py chat`, `aiq.py submit`, `aiq.py research_poll`, `aiq.py status`, `aiq.py state`, or `aiq.py report`. Do NOT pass `deep_researcher` as the agent type. Only `aiq.py check-auth` and `aiq.py research "<query>" shallow_researcher` are supported here.

## Purpose

A single, server-polled shallow research request that returns a final report JSON on stdout, typically in 20–60s.

Use it for:
- short citation-backed answers (market sizing, competitive context, risk surveys)
- enterprise-source enrichment where NVIDIA AIQ Blueprint adds value

Do **not** use it for:
- long-running deep research jobs (disabled)
- chat-style interactive queries (the `/chat` endpoint's auto-router may upgrade broad queries to deep research and is intentionally bypassed)

## Prerequisites

- Network access to `api.aiq.nvidia.com` (open under the openshell sandbox's `allow_api_aiq_nvidia_com_443` policy).
- A valid NVAuth token at `$HOME/.aiq/tokens/nvauth_token` (0600) OR in the `AIQ_NVAUTH_TOKEN` env var. The orchestrator syncs the host token into the sandbox on startup; you generally do not need to manage it from within an agent run.
- Python 3 available in the host environment.

## Escalated Permissions

If `check-auth` fails with `need_browser_login`, stop and ask the user to authenticate out-of-band. **Do not attempt `aiq.py login` from inside an agent run** — the browser device-flow needs interactive user attention and the demo's run loop does not wait for it.

## Available Scripts

| Script | Purpose | Arguments |
| --- | --- | --- |
| `skills/aiq-research/scripts/aiq.py check-auth` | Validate cached auth or attempt silent refresh | none |
| `skills/aiq-research/scripts/aiq.py research "<query>" shallow_researcher` | Run a shallow async research job, server-polled. Final report JSON printed on stdout. | query, agent type |

## Instructions

1. Run `check-auth` first.
2. If `check-auth` prints `need_browser_login`, stop and report. Do not attempt `login`.
3. Run `research "<query>" shallow_researcher` exactly once. The `shallow_researcher` argument is mandatory — it forces the explicit-agent-type code path and bypasses the `/chat` endpoint's auto-router.

The `research` command blocks for 20–60s while it polls server-side. That wait is expected, not a failure. When it returns, stdout contains the report JSON.

## Usage

### Authentication flow

```bash
python3 skills/aiq-research/scripts/aiq.py check-auth
```

- Prints `ok` on success — continue.
- Prints `need_browser_login` — stop, ask the user to authenticate, do not retry from inside the agent.

### Research flow

```bash
python3 skills/aiq-research/scripts/aiq.py research "USER QUESTION" shallow_researcher
```

The command exits 0 with the report JSON on stdout on success, or exits non-zero with a status dict on failure. Parse the stdout as JSON.

### Presenting the report

- Present the final report content to the user.
- Do not truncate citations or source URLs.
- Ask before writing the report to a new file path.

## Examples

### Example 1 — auth check

```bash
python3 skills/aiq-research/scripts/aiq.py check-auth
```

### Example 2 — shallow research

```bash
python3 skills/aiq-research/scripts/aiq.py research "What is the competitive landscape for premium contract manufacturing routed through Taiwan?" shallow_researcher
```

### Example 3 — error handling

If the call returns `{"status":"deep_research_running",...}`, treat it as an error and surface it to the user. This indicates the agent routed to deep research when it should not have.

## Security Notes

- Escalated permissions can bypass sandbox protections. State that plainly before requesting them.
- Do not delete cached credentials unless the user explicitly asks for that action.
- Ask before saving reports outside the current workspace or in a user home directory.
- `AIQ_INSECURE=1` disables TLS verification and should be used only as a last-resort debugging step with a clear user warning.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `AIQ_SERVER_URL` | No | Override the AIQ server base URL |
| `AIQ_NVAUTH_TOKEN` | No | NVAuth bearer token; takes precedence over the file at `~/.aiq/tokens/nvauth_token` |
| `AIQ_CACERT` | No | CA bundle path for environments that do not trust the NVIDIA internal CA by default |
| `AIQ_INSECURE` | No | If set to `1`, disables TLS verification for curl. Avoid in normal use |

## Troubleshooting

| Error | Cause | Solution |
| --- | --- | --- |
| `need_browser_login` | NVAuth token missing or expired | Ask the user to mint a token at https://nv-auth.nvidia.com/tokens and drop it at `~/.aiq/tokens/nvauth_token` (0600), then restart `npm start` |
| `deep_research_running` returned | Agent type was omitted or wrong | Re-run with the explicit `shallow_researcher` agent type |
| SSL verification failure | NVIDIA CA not trusted by curl | Set `AIQ_CACERT` to the correct CA bundle path |
| Request blocked by sandbox | Endpoint missing from policy | Update `policies/my-assistant-policy.yaml` and re-apply via `openshell policy set my-assistant ...` |
| Timeout | AIQ backend slow | Re-run; do not split into smaller queries unless the user asks |
````

- [ ] **Step 2: Verify with `npm test`**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add skills/aiq-research/SKILL.md
git commit -m "docs(aiq-research): rewrite SKILL.md to demo-correct shallow_researcher flow only"
```

---

### Task 21: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace paragraph 3**

Find:

```markdown
The current implementation is a runnable UI with mock skill adapters and realistic integration contracts. It is designed so the mock data can be replaced by real skill calls without changing the demo choreography.
```

Replace with:

```markdown
The demo runs real cuOpt, Vision Insights, and AIQ Research skill calls through a selectable Codex or Claude harness. If cuOpt is unreachable the UI falls back to a bundled reference plan so the demo never dead-ends on a network blip. Vision and AIQ are always live.
```

- [ ] **Step 2: Augment the "Run" section**

Find this block in `README.md` (shown with 4-backtick outer fence here so its inner ``` doesn't break this plan's rendering):

````markdown
## Run

```bash
npm start
```

Open `http://localhost:4173`.
````

Replace with:

````markdown
## Run

```bash
npm start
```

Open `http://localhost:4173`.

First start verifies sandbox reachability and syncs the bundled sample image. AIQ auth tokens live in `~/.aiq/tokens/` and are synced into the sandbox automatically. If you rotate a token, restart `npm start` to push it across.
````

- [ ] **Step 3: Rename and lightly update "Intended Live Flow"**

Find:

````markdown
## Intended Live Flow

```text
Frontend -> selected harness (Codex or Claude)
Selected harness -> cuOpt skill -> optimized supply-chain plan
Selected harness -> Vision Insights skill -> chart and dashboard analysis
Selected harness -> AIQ Research skill -> citation-backed business plan
Frontend <- progress events, metrics, visual insights, final plan
```
````

Replace with:

````markdown
## Live Flow

```text
Frontend -> selected harness (Codex or Claude) -> system prime (server/sandbox.mjs:buildSystemPrime)
Harness -> cuOpt taiwan_supply_chain/run.py -> envelope {selected_lanes, metrics, capacity, explanation}
                                              -> on failure: UI falls back to bundled reference plan
Harness -> Vision Insights vision_analyze.py -> Nemotron Omni summary
Harness -> AIQ Research aiq.py research "<q>" shallow_researcher -> report JSON
Frontend <- NDJSON beats (tool.invoked, tool.completed, assistant.text, run.completed)
```
````

- [ ] **Step 4: Update the repo-layout entry for cuopt**

Find:

```markdown
- `skills/cuopt/contract.md`: draft contract for the future cuOpt skill.
```

Replace with:

```markdown
- `skills/cuopt/contract.md`: cuOpt envelope I/O contract (live).
- `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py`: live solver wrapper called by the agent at runtime.
- `app-cuopt.mjs`: client-side envelope parser + UI transformer.
```

- [ ] **Step 5: Verify**

Run: `npm test`. Expected: PASS.

Open the README. Read through. Confirm no stale "mock" / "intended" / "draft" language remains.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): update to reflect live cuopt + vision + AIQ flow"
```

---

### Task 22: Rewrite `docs/integration-plan.md`

**Files:**
- Replace: `docs/integration-plan.md`

- [ ] **Step 1: Replace the entire file**

Replace contents of `docs/integration-plan.md` with:

```markdown
# Integration

How the live skill flow is wired and how to extend it.

## Current state

The three skills are live:

| Skill | Script | Where it runs |
| --- | --- | --- |
| cuOpt | `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` | Local cuOpt REST server at `host.openshell.internal:8002` (GB10 GPU). |
| Vision Insights | `skills/vision-insights/scripts/vision_analyze.py` | Nemotron Omni at `host.openshell.internal:8000` (NIM endpoint). |
| AIQ Research | `skills/aiq-research/scripts/aiq.py research "<q>" shallow_researcher` | Remote `api.aiq.nvidia.com` (NVAuth-gated). |

Surface selection (`surface: "auto" | "sandbox" | "host"`) lives in `server/sandbox.mjs`. Auto pings the openshell sandbox via `checkSandbox()` and picks sandbox if reachable, otherwise host. The system prime that lists the available skill scripts is assembled in `server/sandbox.mjs:buildSystemPrime`.

## Adding a new skill

A new skill (call it `xyz`) needs the following wiring:

1. **Register in the system prime.** Add a bullet to `server/sandbox.mjs:buildSystemPrime` describing the script path and stdout shape. The agent only knows about scripts that appear here.
2. **Add a stage hint (if it deserves its own stage).** Add an entry to `STAGE_HINTS` in BOTH `server/normalize-claude.mjs` and `server/normalize-codex.mjs`. Pick unambiguous tokens (script name fragments, unique JSON markers) that won't collide with other skills.
3. **Add a parser in `app.js` (if stdout is structured).** Mirror the `cuopt` pattern: parse client-side, route through a single `applyXyzResult` commit-point, render to a stage panel.
4. **Add a smoke-test assertion.** In `scripts/check.mjs`, assert that the system prime contains the new script path.
5. **Update the data shape.** If the skill needs scenario data, extend `data/supply-chain.json` and `scripts/check.mjs`'s shape checks.

## Event contract

`/api/run` returns NDJSON beats of the form `{ "kind": "...", "data": {...} }`. The orchestrator emits:

- `surface.info` — first beat. `{ surface, sandboxReachable, reason, harness }`.
- `run.registered` — `{ runId, harness, surface, cmd, argv }`.
- `run.started` — synthesized by the harness normalizer. `{ sessionId, model, harness, tools }`.
- `tool.invoked` — synthesized. `{ id, name, input, stage }`. Stage ∈ `"cuopt"`, `"vision"`, `"aiq"`, `"general"`.
- `tool.completed` — synthesized. `{ id, name, stage, stdout, stderr, isError, durationMs }`.
- `assistant.text` — synthesized free-text. `{ stage, text }`.
- `log` — `{ level, text }`. Level ∈ `"warn"`, `"stderr"`, `"info"`, `"debug"`.
- `run.completed` | `run.failed` | `run.cancelled` — exactly one terminal beat per run.

The frontend derives stage transitions from `tool.invoked` / `tool.completed` — there is no separate `stage.*` event.

## cuOpt envelope

Schema documented in `skills/cuopt/contract.md`. The frontend parser lives in `app-cuopt.mjs:parseCuoptToolOutput`. Failure modes (script error, parse error, missing fields, agent skipped, harness-backgrounded) all route through `app.js:applyCuoptResult` with a single sticky `state.cuoptResolved` flag.

To extend cuOpt with new envelope fields:
1. Add the field in `run.py:envelope_from_solution`.
2. Wire it into `app-cuopt.mjs:cuoptEnvelopeToUiValues`.
3. Update the schema example in `skills/cuopt/contract.md`.
4. Add an assertion in `scripts/check.mjs` if the field is required.
```

- [ ] **Step 2: Verify**

Run: `npm test`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/integration-plan.md
git commit -m "docs(integration): rewrite to describe the live flow, not the aspirational one"
```

---

### Task 23: Light-edit `docs/demo-script.md`

**Files:**
- Modify: `docs/demo-script.md`

- [ ] **Step 1: Edit**

Replace contents of `docs/demo-script.md` with:

```markdown
# Demo Script

## Pre-flight

Before pressing Run:

- Confirm the **harness toggle** state. Show Codex first (left), then re-run the same prompt with Claude (right) at the end to demonstrate parity.
- Look at the **sandbox chip** in the rail header. Green "openshell · my-assistant" means the run will execute inside the sandbox. Amber "host · sandbox bypassed" means the sandbox is unreachable — the demo still runs on the host, but call this out if asked.
- Optionally **attach a chart image** via the prompt panel. If you don't, the bundled `sample-capacity.png` is used. Vision Insights will read whichever image is attached.

## Opening state

The operator lands on a CUDA-X control surface for a Taiwan advanced manufacturing scenario. The visible state shows the selected harness, the packaged skill chips at the right, the Taiwan route map, and an empty run trace.

## Harness toggle

Codex and Claude are presented as peers. The same packaged skills, the same system prime, the same NDJSON event contract. Switching the toggle changes the child binary the orchestrator spawns and nothing else.

## Stage 1: Demand brief

The default prompt asks the agent to call cuOpt, then Vision, then AIQ. The operator can tweak it. On Run, the brief collapses to a read-only summary and the canvas auto-advances to Stage 2.

## Stage 2: cuOpt Solve

The agent invokes `taiwan_supply_chain/run.py`. cuOpt solves on the GB10 and the run.py wrapper prints a JSON envelope on stdout. The UI:

- Animates the metric bars baseline → optimized using the envelope's numbers (cost, cycle time, unassigned lots, peak pressure).
- Renders the per-node capacity chart: 5 envelope-sourced rows (Hsinchu, Taichung, Tainan, Port=Kaohsiung, Air=Taoyuan) plus mock Taipei + Buffer. The chip at the top right reads "from cuOpt".
- Animates the route on the map from the stressed baseline to the optimized lanes.
- Bumps the readiness score from 41 toward 91.
- Displays the envelope's `explanation` text under the capacity chart.

**Fallback behavior.** If cuOpt returns nothing parseable (server down, script error, infeasible solve), the same animation runs but with the bundled reference plan. The capacity chip flips to "reference plan" and a warn toast appears. **Call this out as a deliberate demo-resilience design choice rather than apologizing for it** — the live demo continues even when the GPU service is misbehaving.

## Stage 3: Vision Insights

The optimized capacity chart artifact (or the user's attached image) is sent to Nemotron Omni. The UI shows the model's "analyzing" state, then writes a one-line operator readout under the image.

## Stage 4: AIQ Research

The agent submits a shallow research request. The plan panel shows the streaming source-count, then transitions to a four-tab business plan (Strategy, Market, Risk, Execution).

## Close

CUDA-X libraries, packaged skills, and either harness can work together as one demo flow. Solve with cuOpt, interpret with Nemotron Omni, research with AIQ, present through one operator UI.

## Re-running with the other harness

Flip the toggle. Click Run with the same prompt. Same end state, different agent voice. The point: skills are portable; the harness is the user's choice.
```

- [ ] **Step 2: Verify**

Run: `npm test`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/demo-script.md
git commit -m "docs(demo-script): pre-flight checks, capacity-chart talk track, fallback line"
```

---

## Phase 6 — Test infrastructure additions

### Task 24: Add the doc-equality gate to `scripts/check.mjs`

**Files:**
- Modify: `scripts/check.mjs`

- [ ] **Step 1: Add the gate**

At the end of `scripts/check.mjs` (after the existing assertions, before `console.log("Static demo checks passed");`), insert:

```js
// Doc-equality gate: AGENTS.md and CLAUDE.md must be byte-identical (after
// normalizing line endings + trailing whitespace + trailing newline). They
// are read by Codex and Claude respectively when working in this repo, and
// drift between them causes one harness to act on stale guidance.
{
  const claudeMd = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");
  const agentsMd = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
  if (normalize(claudeMd) !== normalize(agentsMd)) {
    throw new Error("AGENTS.md and CLAUDE.md have diverged. They must be byte-identical (after whitespace normalization). Run: cp CLAUDE.md AGENTS.md");
  }
}
```

- [ ] **Step 2: Verify it passes (since we already copied)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Verify it fails when they diverge**

```bash
echo "" >> AGENTS.md
echo "drift test line" >> AGENTS.md
npm test || echo "EXPECTED FAILURE — gate caught the drift"
# Then restore
cp CLAUDE.md AGENTS.md
npm test
```

Expected: drift run fails with "AGENTS.md and CLAUDE.md have diverged"; restored run passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/check.mjs
git commit -m "test(check): add AGENTS.md ↔ CLAUDE.md equality gate"
```

---

### Task 25: Add the system-prime smoke test

**Files:**
- Modify: `scripts/check.mjs`

- [ ] **Step 1: Add the import + smoke test**

At the top of `scripts/check.mjs`, add the import:

```js
import { readFile, stat } from "node:fs/promises";
import { buildInvocation } from "../server/sandbox.mjs";
```

(The existing imports already include `readFile` and `stat`; just add the new `buildInvocation` import.)

At the end of the file (after the doc-equality gate, before the `console.log`), add:

```js
// System-prime smoke test: assemble a fake invocation and assert the resulting
// stdin payload contains the tokens the demo depends on. Catches typos in
// buildSystemPrime that would silently break the demo at runtime.
{
  const inv = buildInvocation({
    harness: "claude",
    prompt: "smoke",
    imagePath: "/data/sample-capacity.png",
    surface: "sandbox"
  });
  const prime = inv.stdin || "";
  const required = [
    "taiwan_supply_chain/run.py",         // cuopt invocation path
    "shallow_researcher",                  // AIQ explicit-agent-type token
    "## Strategy", "## Market", "## Risk", "## Execution", // section headers parsePlanSections expects
    "cuopt.result"                         // envelope kind
  ];
  for (const tok of required) {
    if (!prime.includes(tok)) {
      throw new Error(`System prime missing required token: "${tok}". Check server/sandbox.mjs:buildSystemPrime.`);
    }
  }
}
```

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: PASS.

Then test that it catches a regression:

```bash
# Temporarily remove shallow_researcher from the system prime
sed -i 's/shallow_researcher/REMOVED_TOKEN/' server/sandbox.mjs
npm test || echo "EXPECTED FAILURE — smoke test caught the regression"
git checkout server/sandbox.mjs
npm test
```

Expected: regression run fails with "System prime missing required token: 'shallow_researcher'"; restored run passes.

- [ ] **Step 3: Commit**

```bash
git add scripts/check.mjs
git commit -m "test(check): add system-prime smoke test for required tokens"
```

---

### Task 26: Final verification — full `npm test` + manual end-to-end

**No files modified.** Final verification.

- [ ] **Step 1: Run the complete test suite**

```bash
npm test
```

Expected output:
```
Static demo checks passed
[ TAP output from node --test, ~25 tests, all pass ]
```

- [ ] **Step 2: Run a real end-to-end with both harnesses**

Repeat Task 16 (sandbox surface) and Task 17 (fallback paths) verifications. Document the final timings.

- [ ] **Step 3: Visual sanity check the docs**

Open these in a Markdown viewer and skim for anything that still looks like a placeholder or contradicts the implementation:

- `CLAUDE.md` and `AGENTS.md` (should be identical)
- `README.md`
- `docs/integration-plan.md`
- `docs/demo-script.md`
- `skills/aiq-research/SKILL.md`

- [ ] **Step 4: Final commit (if anything turned up in review)**

If small doc tweaks fall out of the visual check:

```bash
git add <files>
git commit -m "docs: post-implementation polish"
```

---

## Self-review

(Author's pass — fix anything spotted inline.)

**Spec coverage check:**
- P0-1 normalizer change → Task 5 ✓
- P0-1 client-side parsing (parseCuoptToolOutput) → Task 3 ✓
- P0-1 envelope → UI transformation (cuoptEnvelopeToUiValues, mockToUiValues) → Task 4 ✓
- P0-1 score derivation rationale + CUOPT_SCORE_PENALTY → Task 10 ✓
- P0-1 handleToolInvoked branch → Task 11 ✓
- P0-1 handleToolCompleted branch + Layer 2/3 → Task 12 ✓
- P0-1 removing dead "leave cuopt idle" branch → Task 11 ✓
- P0-1 implicit fallback (setStageSubstate guard) → Task 13 ✓
- P0-1 finishRun safety-net → Task 14 ✓
- P0-1 state additions (cuoptResolved, cuoptBackgroundBashId) → Task 6 ✓
- P0-1 animateMetricBars + renderMetricsSkeleton → Task 7 ✓
- P0-1 capacity panel HTML/CSS → Task 8 ✓
- P0-1 renderCapacityChart + skeleton → Task 9 ✓
- P0-1 score Math.max guard → Task 10 ✓
- P0-1 skillMap entry → Task 15 ✓
- P0-2 CLAUDE.md fix → Task 18 ✓
- P0-2 AGENTS.md copy → Task 19 ✓
- P0-2 SKILL.md rewrite → Task 20 ✓
- P0-2 README.md → Task 21 ✓
- P0-2 integration-plan.md → Task 22 ✓
- P0-2 demo-script.md → Task 23 ✓
- P0-2 doc-equality gate → Task 24 ✓
- P0-2 system-prime smoke test → Task 25 ✓

No gaps detected.

**Type consistency:**
- `applyCuoptResult(result)` signature matches across Tasks 10, 11, 12, 13, 14.
- `cuoptEnvelopeToUiValues(envelope, data)` matches between Task 4 (implementation) and Task 10 (caller).
- `mockToUiValues(data)` matches.
- Reason codes (`script_error`, `parse_failed`, `bad_shape`, `not_invoked`, `background_timeout`) — referenced consistently across Tasks 3, 12, 13, 14.

**Placeholder scan:** no `TBD`/`TODO`/`fill in details` strings. Each code step shows the actual code or the exact edit. Each verification step gives a runnable command and an expected outcome.

---

## Execution notes for the implementer

- Tasks are ordered to minimize broken intermediate states. Tasks 1–4 add pure functions with no UI side-effects. Tasks 5–6 introduce stage hints and state without yet wiring DOM changes. Tasks 7–16 layer in the UI. Each task ends with a commit.
- TDD pattern (red → green → commit) is enforced on Tasks 1–4 where the functions are pure and unit-testable.
- UI-affecting tasks (7+) use manual smoke tests via the JS console because the codebase doesn't ship a browser test runner. The smoke-test invocations shown in each task are reproducible.
- If a step's manual smoke test fails, do NOT advance to the next task. Diagnose, fix, and re-run the smoke test before committing.
- `npm test` should be runnable at every commit boundary — never leave the suite red between commits.
