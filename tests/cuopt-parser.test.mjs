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
