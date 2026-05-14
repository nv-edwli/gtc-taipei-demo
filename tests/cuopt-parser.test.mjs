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
