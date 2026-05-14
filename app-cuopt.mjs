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
