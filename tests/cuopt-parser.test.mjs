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
