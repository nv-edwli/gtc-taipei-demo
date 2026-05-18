// Pure parsing + transformation for the cuopt.result envelope produced by
// skills/cuopt/max-supply/run.py.
//
// Envelope shape:
//   {kind:"cuopt.result", status, baseline, whatif, delta, opening_stock, explanation}
//
// This module is imported by app.js (browser-loaded) AND by tests (node:test).
// Keep it DOM-free.

export const CUOPT_SCORE_PENALTY = { solved: 0, infeasible: 15, fallback: 20 };

// ── Predicates ────────────────────────────────────────────────────────────────

export function looksLikeCuoptResult(text) {
  if (!text || typeof text !== "string" || text.length < 40) return false;
  const head = text.slice(0, 400);
  return /"kind"\s*:\s*"cuopt\.result"/.test(head);
}

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
  // For the max-supply envelope, require baseline and whatif blocks
  if (!envelope.baseline || !envelope.whatif) {
    return { status: "fallback", reason: "bad_shape" };
  }
  if (!VALID_STATUSES.has(envelope.status)) {
    return { status: "fallback", reason: "bad_shape" };
  }
  return { status: envelope.status, envelope };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Metric row builders ───────────────────────────────────────────────────────
// Each returns { label, value (0-100), display, delta, max: 100, dataSource }.

// Scale for bar widths:  value = clamp(qty / scale * 100, 0, 100)
// Calibrated to actual solver output: FG1~350, FG2~65, RM1~1000, obj~3.5M
const FG1_SCALE   = 400;       // 400 units = full bar
const FG2_SCALE   = 100;       // 100 units = full bar
const RM1_MAX_QTY = 1000;      // total RM1 supply over 10 periods
const OBJ_SCALE   = 4_000_000; // 4 M weighted units = full bar

function metricFG1(env, mockOpt) {
  const fg1 = env?.whatif?.fg1_final;
  const fg1b = env?.baseline?.fg1_final;
  if (!isNum(fg1)) return { ...mockOpt, dataSource: "mock" };
  const delta = isNum(fg1b) ? fg1 - fg1b : 0;
  return {
    label: mockOpt.label,
    max: 100,
    value: clamp(Math.round(fg1 / FG1_SCALE * 100), 0, 100),
    display: Math.round(fg1) + " units",
    delta: (delta >= 0 ? "+" : "−") + Math.abs(Math.round(delta)) + " vs baseline",
    dataSource: "envelope"
  };
}

function metricFG2(env, mockOpt) {
  const fg2 = env?.whatif?.fg2_final;
  const fg2b = env?.baseline?.fg2_final;
  if (!isNum(fg2)) return { ...mockOpt, dataSource: "mock" };
  const delta = isNum(fg2b) ? fg2 - fg2b : 0;
  return {
    label: mockOpt.label,
    max: 100,
    value: clamp(Math.round(fg2 / FG2_SCALE * 100), 0, 100),
    display: Math.round(fg2) + " units",
    delta: (delta >= 0 ? "+" : "−") + Math.abs(Math.round(delta)) + " vs baseline",
    dataSource: "envelope"
  };
}

function metricRM1(env, mockOpt) {
  const rm1 = env?.whatif?.rm1_buy_total;
  const rm1b = env?.baseline?.rm1_buy_total;
  if (!isNum(rm1)) return { ...mockOpt, dataSource: "mock" };
  const saved = isNum(rm1b) ? rm1b - rm1 : 0;
  return {
    label: mockOpt.label,
    max: 100,
    value: clamp(Math.round(rm1 / RM1_MAX_QTY * 100), 0, 100),
    display: Math.round(rm1) + " units",
    delta: saved > 0
      ? "−" + Math.round(saved) + " saved"
      : (saved < 0 ? "+" + Math.abs(Math.round(saved)) : "—"),
    dataSource: "envelope"
  };
}

function metricObjective(env, mockOpt) {
  const obj = env?.whatif?.objective;
  const objb = env?.baseline?.objective;
  if (!isNum(obj)) return { ...mockOpt, dataSource: "mock" };
  const delta = isNum(objb) ? obj - objb : 0;
  const pct = (isNum(objb) && objb > 0) ? Math.round(delta / objb * 100) : 0;
  const fmt = v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : String(Math.round(v));
  return {
    label: mockOpt.label,
    max: 100,
    value: clamp(Math.round(obj / OBJ_SCALE * 100), 0, 100),
    display: fmt(obj),
    delta: (delta >= 0 ? "+" : "−") + fmt(Math.abs(delta)) + " (" + (delta >= 0 ? "+" : "−") + Math.abs(pct) + "%)",
    dataSource: "envelope"
  };
}

// ── Capacity (RM1 buy-order) row builder ──────────────────────────────────────

// Maps one period's buy quantity to a 0-100 bar pct.
// Max RM1 supply in any period is 120 units (period 2 / 7).
const RM1_PERIOD_MAX = 120;

function buildCapacityRows(env, mockOptRows, mockBaseRows) {
  const rm1Whatif   = env?.whatif?.rm1_buy_by_period;
  const rm1Baseline = env?.baseline?.rm1_buy_by_period;
  if (!Array.isArray(rm1Whatif) || rm1Whatif.length < 10) {
    return mockOptRows.map((row, i) => ({
      label:      row.label,
      value:      row.value,
      baseline:   mockBaseRows[i].value,
      dataSource: "mock"
    }));
  }
  return rm1Whatif.map((qty, i) => {
    const base = Array.isArray(rm1Baseline) ? (rm1Baseline[i] || 0) : 0;
    return {
      label:      "P" + (i + 1),
      value:      clamp(Math.round(qty  / RM1_PERIOD_MAX * 100), 0, 100),
      baseline:   clamp(Math.round(base / RM1_PERIOD_MAX * 100), 0, 100),
      dataSource: "envelope"
    };
  });
}

// ── Exported transformers ─────────────────────────────────────────────────────

export function cuoptEnvelopeToUiValues(envelope, data) {
  const mockOpt  = data.metrics.optimized;
  const mockBase = data.metrics.baseline;

  const metricRows = [
    metricFG1(envelope, mockOpt[0]),
    metricFG2(envelope, mockOpt[1]),
    metricRM1(envelope, mockOpt[2]),
    metricObjective(envelope, mockOpt[3]),
  ];

  const capacityRows = buildCapacityRows(
    envelope,
    data.capacity.optimized,
    data.capacity.baseline
  );

  return {
    status:       envelope.status,
    explanation:  envelope.explanation || "",
    metricRows,
    capacityRows,
  };
}

export function mockToUiValues(data) {
  const metricRows = data.metrics.optimized.map(row => ({ ...row, dataSource: "mock" }));
  const capacityRows = data.capacity.optimized.map((row, i) => ({
    label:      row.label,
    value:      row.value,
    baseline:   data.capacity.baseline[i].value,
    dataSource: "mock"
  }));
  return { status: "fallback", explanation: "", metricRows, capacityRows };
}
