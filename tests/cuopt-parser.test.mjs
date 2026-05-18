import { test } from "node:test";
import assert from "node:assert/strict";
import * as cuopt from "../app-cuopt.mjs";

// ── Module surface ────────────────────────────────────────────────────────────

test("module exports the expected surface", () => {
  assert.equal(typeof cuopt.parseCuoptToolOutput, "function");
  assert.equal(typeof cuopt.cuoptEnvelopeToUiValues, "function");
  assert.equal(typeof cuopt.mockToUiValues, "function");
  assert.equal(typeof cuopt.looksLikeCuoptResult, "function");
  assert.deepEqual(cuopt.CUOPT_SCORE_PENALTY, { solved: 0, infeasible: 15, fallback: 20 });
});

// ── looksLikeCuoptResult ──────────────────────────────────────────────────────

test("looksLikeCuoptResult matches by kind marker", () => {
  const text = '{"kind":"cuopt.result","status":"solved","baseline":{},"whatif":{}}';
  assert.equal(cuopt.looksLikeCuoptResult(text), true);
});

test("looksLikeCuoptResult matches with whitespace around colon", () => {
  const text = '{ "kind" : "cuopt.result", "status": "solved" }';
  assert.equal(cuopt.looksLikeCuoptResult(text), true);
});

test("looksLikeCuoptResult rejects short / empty / unrelated text", () => {
  assert.equal(cuopt.looksLikeCuoptResult(""), false);
  assert.equal(cuopt.looksLikeCuoptResult(null), false);
  assert.equal(cuopt.looksLikeCuoptResult("hello world"), false);
  assert.equal(cuopt.looksLikeCuoptResult('{"some":"json","but":"unrelated"}'), false);
  // old VRP format — no kind marker
  assert.equal(
    cuopt.looksLikeCuoptResult(
      '{"status":"solved","selected_lanes":[{"a":1}],"objective_value":42.5}'
    ),
    false
  );
});

// ── Shared test fixtures ──────────────────────────────────────────────────────

const SOLVED_ENVELOPE = {
  kind: "cuopt.result",
  status: "solved",
  baseline: {
    objective: 1_000_000,
    fg1_final: 200,
    fg2_final: 50,
    fg1_inv_by_period:   [0,0,0,0,0,0,0,0,0,200],
    fg2_inv_by_period:   [0,0,0,0,0,0,0,0,0,50],
    rm1_buy_by_period:   [100,100,100,100,100,100,100,100,100,100],
    rm2_buy_by_period:   [80,80,80,80,80,80,80,80,80,80],
    rm1_buy_total: 1000,
    rm2_buy_total: 800,
    res1_util_by_period: [90,90,90,90,90,90,90,90,90,90],
    res2_util_by_period: [80,80,80,80,80,80,80,80,80,80]
  },
  whatif: {
    objective: 1_200_000,
    fg1_final: 220,
    fg2_final: 52,
    fg1_inv_by_period:   [0,0,0,0,0,0,0,0,0,220],
    fg2_inv_by_period:   [0,0,0,0,0,0,0,0,0,52],
    rm1_buy_by_period:   [100,120,0,80,100,100,30,100,80,100],
    rm2_buy_by_period:   [80,80,80,80,80,80,80,80,80,80],
    rm1_buy_total: 810,
    rm2_buy_total: 800,
    res1_util_by_period: [90,90,90,90,90,90,90,90,90,90],
    res2_util_by_period: [80,80,80,80,80,80,80,80,80,80]
  },
  delta: { objective: 200_000, fg1_final: 20, fg2_final: 2, rm1_buy_total: -190 },
  opening_stock: { SA1: 40, RM1: 250, RM3: 180 },
  explanation: "Opening stock lifts objective."
};
const SOLVED_JSON = JSON.stringify(SOLVED_ENVELOPE);

const FIXTURE_DATA = {
  metrics: {
    baseline: [
      { label: "FG1 end inventory",     value: 87,  max: 100, display: "347 units" },
      { label: "FG2 end inventory",     value: 63,  max: 100, display: "63 units" },
      { label: "RM1 total procurement", value: 100, max: 100, display: "1000 units" },
      { label: "Weighted objective",    value: 87,  max: 100, display: "3467k" }
    ],
    optimized: [
      { label: "FG1 end inventory",     value: 90, max: 100, display: "358 units",  delta: "+11 vs baseline" },
      { label: "FG2 end inventory",     value: 64, max: 100, display: "64 units",   delta: "+1 vs baseline" },
      { label: "RM1 total procurement", value: 81, max: 100, display: "810 units",  delta: "−190 saved" },
      { label: "Weighted objective",    value: 90, max: 100, display: "3585k",      delta: "+118k (+3%)" }
    ]
  },
  capacity: {
    baseline: [
      { label: "P1",  value: 83 }, { label: "P2",  value: 100 }, { label: "P3",  value: 83 },
      { label: "P4",  value: 67 }, { label: "P5",  value: 83  }, { label: "P6",  value: 83 },
      { label: "P7",  value: 100 }, { label: "P8", value: 83  }, { label: "P9",  value: 67 },
      { label: "P10", value: 83 }
    ],
    optimized: [
      { label: "P1",  value: 83 }, { label: "P2",  value: 100 }, { label: "P3",  value: 0  },
      { label: "P4",  value: 67 }, { label: "P5",  value: 83  }, { label: "P6",  value: 83 },
      { label: "P7",  value: 25 }, { label: "P8",  value: 83  }, { label: "P9",  value: 67 },
      { label: "P10", value: 83 }
    ]
  }
};

// ── parseCuoptToolOutput ──────────────────────────────────────────────────────

test("parseCuoptToolOutput: clean solved envelope", () => {
  const result = cuopt.parseCuoptToolOutput(SOLVED_JSON, false);
  assert.equal(result.status, "solved");
  assert.equal(result.envelope.whatif.fg1_final, 220);
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

test("parseCuoptToolOutput: bad_shape on JSON missing baseline/whatif", () => {
  const env = { kind: "cuopt.result", status: "solved" };
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
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), true);
  assert.equal(result.status, "infeasible");
});

test("parseCuoptToolOutput: tolerates leading whitespace", () => {
  const result = cuopt.parseCuoptToolOutput("\n\n  " + SOLVED_JSON + "\n", false);
  assert.equal(result.status, "solved");
});

// ── mockToUiValues ────────────────────────────────────────────────────────────

test("mockToUiValues returns the data.metrics.optimized rows as metricRows", () => {
  const ui = cuopt.mockToUiValues(FIXTURE_DATA);
  assert.equal(ui.status, "fallback");
  assert.equal(ui.explanation, "");
  assert.equal(ui.metricRows.length, 4);
  assert.equal(ui.metricRows[0].display, "358 units");
  assert.equal(ui.metricRows[0].delta, "+11 vs baseline");
  assert.equal(ui.metricRows[0].dataSource, "mock");
});

test("mockToUiValues returns 10 capacityRows with baseline + value", () => {
  const ui = cuopt.mockToUiValues(FIXTURE_DATA);
  assert.equal(ui.capacityRows.length, 10);
  assert.deepEqual(ui.capacityRows[0], { label: "P1", value: 83, baseline: 83, dataSource: "mock" });
  assert.deepEqual(ui.capacityRows[2], { label: "P3", value: 0,  baseline: 83, dataSource: "mock" });
});

// ── cuoptEnvelopeToUiValues ───────────────────────────────────────────────────

test("cuoptEnvelopeToUiValues maps a clean solved envelope to UI rows", () => {
  const ui = cuopt.cuoptEnvelopeToUiValues(SOLVED_ENVELOPE, FIXTURE_DATA);
  assert.equal(ui.status, "solved");
  assert.equal(ui.explanation, "Opening stock lifts objective.");

  // FG1: whatif=220, baseline=200 → value=round(220/400*100)=55, delta="+20 vs baseline"
  assert.equal(ui.metricRows[0].value, 55);
  assert.equal(ui.metricRows[0].display, "220 units");
  assert.equal(ui.metricRows[0].delta, "+20 vs baseline");
  assert.equal(ui.metricRows[0].dataSource, "envelope");

  // FG2: whatif=52, baseline=50 → value=52, delta="+2 vs baseline"
  assert.equal(ui.metricRows[1].value, 52);
  assert.equal(ui.metricRows[1].display, "52 units");
  assert.equal(ui.metricRows[1].delta, "+2 vs baseline");

  // RM1: whatif=810, baseline=1000 → value=81; saved=190 → "−190 saved"
  assert.equal(ui.metricRows[2].value, 81);
  assert.equal(ui.metricRows[2].display, "810 units");
  assert.equal(ui.metricRows[2].delta, "−190 saved");

  // Objective: whatif=1200000, baseline=1000000 → value=30, delta="+200k (+20%)"
  assert.equal(ui.metricRows[3].value, 30);
  assert.equal(ui.metricRows[3].display, "1200k");
  assert.equal(ui.metricRows[3].delta, "+200k (+20%)");

  // Capacity: 10 rows from whatif.rm1_buy_by_period
  assert.equal(ui.capacityRows.length, 10);
  assert.equal(ui.capacityRows[0].label, "P1");
  assert.equal(ui.capacityRows[0].dataSource, "envelope");
  // P3 = 0 units → value = 0
  assert.equal(ui.capacityRows[2].value, 0);
  // P7 = 30 units → value = round(30/120*100) = 25
  assert.equal(ui.capacityRows[6].value, 25);
});

test("cuoptEnvelopeToUiValues falls back per-key when envelope metric missing", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  delete env.whatif.fg2_final;
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  // Row 0 (FG1) still envelope-sourced
  assert.equal(ui.metricRows[0].dataSource, "envelope");
  // Row 1 (FG2) falls back to mock optimized
  assert.equal(ui.metricRows[1].display, "64 units");
  assert.equal(ui.metricRows[1].dataSource, "mock");
});

test("cuoptEnvelopeToUiValues falls back per-key when envelope metric is NaN", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.whatif.fg1_final = "not a number";
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.metricRows[0].dataSource, "mock");
  assert.equal(ui.metricRows[0].display, "358 units");
});

test("cuoptEnvelopeToUiValues handles missing capacity array (all mock)", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  delete env.whatif.rm1_buy_by_period;
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  for (const row of ui.capacityRows) {
    assert.equal(row.dataSource, "mock");
  }
});

test("cuoptEnvelopeToUiValues handles short capacity array (all mock)", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.whatif.rm1_buy_by_period = [100, 100];   // < 10 elements → fallback
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.capacityRows.length, 10);
  for (const row of ui.capacityRows) {
    assert.equal(row.dataSource, "mock");
  }
});

test("cuoptEnvelopeToUiValues clamps weird out-of-range bar values", () => {
  const env = JSON.parse(JSON.stringify(SOLVED_ENVELOPE));
  env.whatif.fg1_final   = 5000;   // FG1_SCALE=400 → 5000/400*100=1250 → clamp 100
  env.whatif.rm1_buy_total = 99999; // RM1_MAX_QTY=1000 → 99999/1000*100 → clamp 100
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.metricRows[0].value, 100);
  assert.equal(ui.metricRows[0].display, "5000 units");
  assert.equal(ui.metricRows[2].value, 100);
  assert.equal(ui.metricRows[2].display, "99999 units");
});

test("cuoptEnvelopeToUiValues handles infeasible status (passes through)", () => {
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const ui = cuopt.cuoptEnvelopeToUiValues(env, FIXTURE_DATA);
  assert.equal(ui.status, "infeasible");
});
