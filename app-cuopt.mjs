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
export function parseCuoptToolOutput(_stdout, _isError) {   // implemented Task 3
  return { status: "fallback", reason: "not_implemented" };
}
export function cuoptEnvelopeToUiValues(_envelope, _data) { return null; }  // Task 4
export function mockToUiValues(_data) { return null; }                       // Task 4
