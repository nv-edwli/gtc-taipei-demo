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
  const env = { ...SOLVED_ENVELOPE, status: "infeasible" };
  const result = cuopt.parseCuoptToolOutput(JSON.stringify(env), true);
  assert.equal(result.status, "infeasible");
});

test("parseCuoptToolOutput: tolerates leading whitespace", () => {
  const result = cuopt.parseCuoptToolOutput("\n\n  " + SOLVED_JSON + "\n", false);
  assert.equal(result.status, "solved");
});

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
