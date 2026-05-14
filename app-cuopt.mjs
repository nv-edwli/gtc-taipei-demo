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
