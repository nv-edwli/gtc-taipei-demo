#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
# SPDX-License-Identifier: Apache-2.0
"""
Max-supply what-if MILP solver for the GTC Taipei demo.

Runs the multi-period supply-chain MILP twice:
  - Baseline solve:  zero opening inventory for all items
  - What-if solve:   SA1=40, RM1=250, RM3=180 opening inventory

Prints a single JSON envelope to stdout:
  {kind:"cuopt.result", status, baseline, whatif, delta, opening_stock, explanation}

Environment:
  CUOPT_SERVER_URL   default http://host.openshell.internal:8002
  CUOPT_TIMEOUT_S    default 90
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

SERVER = os.environ.get("CUOPT_SERVER_URL", "http://host.openshell.internal:8002")
TIMEOUT_S = int(os.environ.get("CUOPT_TIMEOUT_S", "90"))
HEADERS = {"Content-Type": "application/json", "CLIENT-VERSION": "custom"}

EPS = 1e-4          # floor-truncation guard

# ── Scenario data (generic-max-supply skill, 10-period horizon) ───────────────

PERIODS = list(range(1, 11))

PRODUCED_ITEMS = ["FG1", "FG2", "SA1", "SA2"]   # items with a manufacturing process
PROCURED_ITEMS = ["RM1", "RM2", "RM3"]           # items that are purchased
ALL_ITEMS      = sorted(PRODUCED_ITEMS + PROCURED_ITEMS)
FINAL_ITEMS    = ["FG1", "FG2"]                  # finished goods (in objective)

ITEM_FAMILY = {
    "FG1": "FAM_FG",  "FG2": "FAM_FG",
    "SA1": "FAM_SA",  "SA2": "FAM_SA",
    "RM1": "FAM_RM1", "RM2": "FAM_RM1",
    "RM3": "FAM_RM2",                     # unconstrained — no supply cap
}
CONSTRAINED_FAMILIES = {"FAM_FG", "FAM_SA", "FAM_RM1"}

PROCESS_LEAD  = {"PROC1": 1, "PROC2": 1, "PROC3": 2, "PROC4": 1}
PROCESS_HOURS = {"PROC1": 0.5, "PROC2": 0.3, "PROC3": 1.0, "PROC4": 0.8}

PROCESS_INPUTS = {
    "PROC1": {"RM1": 2.2, "RM2": 1.5},
    "PROC2": {"RM3": 3.0},
    "PROC3": {"SA1": 2.0, "SA2": 3.0},
    "PROC4": {"SA1": 1.0, "RM2": 1.0},
}
PROCESS_OUTPUTS = {
    "PROC1": {"SA1": 1.0},
    "PROC2": {"SA2": 1.8, "SA1": 0.5},
    "PROC3": {"FG1": 1.0},
    "PROC4": {"FG2": 0.85},
}

# Ordered (process, resource) execution pairs
PROC_RES_PAIRS = [
    ("PROC1", "RES1"), ("PROC2", "RES1"), ("PROC2", "RES2"),
    ("PROC3", "RES2"), ("PROC4", "RES1"), ("PROC4", "RES2"),
]
PROC_TO_RES = {
    "PROC1": ["RES1"], "PROC2": ["RES1", "RES2"],
    "PROC3": ["RES2"], "PROC4": ["RES1", "RES2"],
}
RES_TO_PROC = {
    "RES1": ["PROC1", "PROC2", "PROC4"],
    "RES2": ["PROC2", "PROC3", "PROC4"],
}

# Resource capacity: RES1=40h every period; RES2=60h except period 5 (30h)
RES_CAP = {
    **{("RES1", t): 40.0 for t in PERIODS},
    **{("RES2", t): (30.0 if t == 5 else 60.0) for t in PERIODS},
}

# Supply limits (constrained families only; RM3 / FAM_RM2 is unconstrained)
SUPPLY = {}
for _t, _q in zip(PERIODS, [100, 120, 100, 80, 100, 100, 120, 100, 80, 100]):
    SUPPLY[("RM1", _t)] = float(_q)
for _t, _q in zip(PERIODS, [80, 80, 60, 80, 80, 80, 60, 80, 80, 80]):
    SUPPLY[("RM2", _t)] = float(_q)

DEMAND_WEIGHT = {"FG1": 10000.0, "FG2": 1.0}

# Derived adjacency (built once at module load)
ITEM_PRODUCING = {i: [] for i in ALL_ITEMS}
for _p, _outs in PROCESS_OUTPUTS.items():
    for _i in _outs:
        ITEM_PRODUCING[_i].append(_p)

ITEM_CONSUMING = {i: [] for i in ALL_ITEMS}
for _p, _ins in PROCESS_INPUTS.items():
    for _i in _ins:
        ITEM_CONSUMING[_i].append(_p)

PROC_IS_CONSTRAINED = {
    p: any(ITEM_FAMILY[i] in CONSTRAINED_FAMILIES for i in PROCESS_OUTPUTS[p])
    for p in PROCESS_OUTPUTS
}

# What-if opening inventory
OPENING = {"SA1": 40.0, "RM1": 250.0, "RM3": 180.0}


# ── MILP builder ───────────────────────────────────────────────────────────────

def build_payload(opening: dict) -> dict:
    """
    Build the cuOpt REST API payload for the max-supply MILP.
    opening: {item_id: opening_balance}.  0 for every item not in the dict.

    Variable naming (all underscore-separated, no brackets):
      x_{p}_{r}_{t}        process execution
      produced_{i}_{t}     continuous fractional output
      used_{i}_{t}         integer (floor) usable output
      buy_{i}_{t}          procurement quantity
      inv_{i}_{t}          end-of-period inventory  (t = 1..10)

    Opening balances appear only on the RHS of the t=1 material-balance rows.
    No explicit inv_{i}_0 variables are needed.
    """
    var_idx   = {}
    var_names = []
    var_lb    = []
    var_ub    = []
    var_types = []

    def add_var(name, lb=0.0, ub="inf", vtype="continuous"):
        var_idx[name] = len(var_names)
        var_names.append(name)
        var_lb.append(lb)
        var_ub.append(ub)
        var_types.append(vtype)

    # ── decision variables ────────────────────────────────────────────────────

    for (p, r) in PROC_RES_PAIRS:
        for t in PERIODS:
            add_var(f"x_{p}_{r}_{t}")

    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            add_var(f"produced_{i}_{t}")

    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            add_var(f"used_{i}_{t}", vtype="integer")

    for i in PROCURED_ITEMS:
        for t in PERIODS:
            add_var(f"buy_{i}_{t}")

    for i in ALL_ITEMS:
        for t in PERIODS:
            add_var(f"inv_{i}_{t}")

    n = len(var_names)

    # ── constraint builder ────────────────────────────────────────────────────

    row_offs  = [0]
    row_idx   = []
    row_val   = []
    row_lo    = []
    row_hi    = []

    def flush(terms: dict, lo, hi):
        """Emit one CSR row from a {col_index: coefficient} dict."""
        for col in sorted(terms):
            coeff = terms[col]
            if coeff == 0.0:
                continue
            row_idx.append(col)
            row_val.append(coeff)
        row_offs.append(len(row_idx))
        row_lo.append(lo)
        row_hi.append(hi)

    def vi(name):
        return var_idx[name]

    # C1: produced[i,t] = Σ output_qty * x[p,r,t-lead]
    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            terms = {vi(f"produced_{i}_{t}"): 1.0}
            for p in ITEM_PRODUCING[i]:
                start = t - PROCESS_LEAD[p]
                if start < 1:
                    continue
                qty = PROCESS_OUTPUTS[p][i]
                for r in PROC_TO_RES[p]:
                    k = vi(f"x_{p}_{r}_{start}")
                    terms[k] = terms.get(k, 0.0) - qty
            flush(terms, 0.0, 0.0)

    # C2a: used[i,t] - produced[i,t] ≤ 0   (integer ≤ real output)
    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            flush({vi(f"used_{i}_{t}"): 1.0, vi(f"produced_{i}_{t}"): -1.0}, "ninf", 0.0)

    # C2b: produced[i,t] - used[i,t] ≤ 1 - EPS   (forces floor truncation)
    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            flush({vi(f"produced_{i}_{t}"): 1.0, vi(f"used_{i}_{t}"): -1.0}, "ninf", 1.0 - EPS)

    # C3a: material balance for procured items
    #   t=1: inv[i,1] - buy[i,1] + consumption[i,1] = opening[i]
    #   t>1: inv[i,t] - inv[i,t-1] - buy[i,t] + consumption[i,t] = 0
    for i in PROCURED_ITEMS:
        for t in PERIODS:
            terms = {vi(f"inv_{i}_{t}"): 1.0}
            if t > 1:
                terms[vi(f"inv_{i}_{t-1}")] = -1.0
            terms[vi(f"buy_{i}_{t}")] = -1.0
            for p in ITEM_CONSUMING[i]:
                inp = PROCESS_INPUTS[p][i]
                for r in PROC_TO_RES[p]:
                    k = vi(f"x_{p}_{r}_{t}")
                    terms[k] = terms.get(k, 0.0) + inp
            rhs = opening.get(i, 0.0) if t == 1 else 0.0
            flush(terms, rhs, rhs)

    # C3b: material balance for produced items  (same pattern, uses used[i,t])
    for i in PRODUCED_ITEMS:
        for t in PERIODS:
            terms = {vi(f"inv_{i}_{t}"): 1.0}
            if t > 1:
                terms[vi(f"inv_{i}_{t-1}")] = -1.0
            terms[vi(f"used_{i}_{t}")] = -1.0
            for p in ITEM_CONSUMING[i]:
                inp = PROCESS_INPUTS[p][i]
                for r in PROC_TO_RES[p]:
                    k = vi(f"x_{p}_{r}_{t}")
                    terms[k] = terms.get(k, 0.0) + inp
            rhs = opening.get(i, 0.0) if t == 1 else 0.0
            flush(terms, rhs, rhs)

    # C4: supply limits for constrained procured items
    for i in PROCURED_ITEMS:
        if ITEM_FAMILY[i] not in CONSTRAINED_FAMILIES:
            continue
        for t in PERIODS:
            flush({vi(f"buy_{i}_{t}"): 1.0}, "ninf", SUPPLY.get((i, t), 0.0))

    # C5: resource capacity per period
    for r in ["RES1", "RES2"]:
        for t in PERIODS:
            terms = {}
            for p in RES_TO_PROC[r]:
                if not PROC_IS_CONSTRAINED.get(p, True):
                    continue
                terms[vi(f"x_{p}_{r}_{t}")] = PROCESS_HOURS[p]
            cap = RES_CAP[(r, t)]
            if terms:
                flush(terms, "ninf", cap)

    # ── objective ─────────────────────────────────────────────────────────────
    obj = [0.0] * n
    for i in FINAL_ITEMS:
        obj[vi(f"inv_{i}_10")] = DEMAND_WEIGHT[i]

    return {
        "csr_constraint_matrix": {
            "offsets": row_offs,
            "indices": row_idx,
            "values":  row_val,
        },
        "objective_data": {"coefficients": obj},
        "constraint_bounds": {
            "lower_bounds": row_lo,
            "upper_bounds": row_hi,
        },
        "variable_bounds": {
            "lower_bounds": var_lb,
            "upper_bounds": var_ub,
        },
        "variable_types": var_types,
        "variable_names": var_names,
        "maximize": True,
        "solver_config": {
            "time_limit": 60,
            "tolerances": {"mip_relative_gap": 0.01},
        },
    }


# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _http(method, url, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req  = urllib.request.Request(url, data=data, method=method, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw else {}


def submit(payload):
    body = _http("POST", f"{SERVER}/cuopt/request", body=payload)
    return body["reqId"]


def poll(req_id):
    """Block until solved/infeasible or timeout. Returns (solver_response, infeasible_bool)."""
    deadline = time.time() + TIMEOUT_S
    while time.time() < deadline:
        try:
            body = _http("GET", f"{SERVER}/cuopt/solution/{req_id}")
        except urllib.error.HTTPError as e:
            if e.code in (404, 425):
                time.sleep(0.5)
                continue
            raise
        if "response" in body:
            inner = body["response"]
            if "solver_response" in inner:
                return inner["solver_response"], False
            if "solver_infeasible_response" in inner:
                return inner["solver_infeasible_response"], True
        time.sleep(0.5)
    return None, None


# ── Result extractor ───────────────────────────────────────────────────────────

def extract(sresp: dict) -> dict:
    sol = (sresp or {}).get("solution", {}) or {}
    vs  = sol.get("vars", {}) or {}
    obj = float(sol.get("primal_objective", 0.0) or 0.0)

    def v(name):
        return float(vs.get(name, 0.0) or 0.0)

    fg1_inv = [v(f"inv_FG1_{t}") for t in PERIODS]
    fg2_inv = [v(f"inv_FG2_{t}") for t in PERIODS]
    rm1_buy = [v(f"buy_RM1_{t}") for t in PERIODS]
    rm2_buy = [v(f"buy_RM2_{t}") for t in PERIODS]

    res1_util, res2_util = [], []
    for t in PERIODS:
        used1 = sum(PROCESS_HOURS[p] * v(f"x_{p}_RES1_{t}") for p in ["PROC1", "PROC2", "PROC4"])
        cap1  = RES_CAP[("RES1", t)]
        res1_util.append(round(used1 / cap1 * 100, 1) if cap1 else 0.0)

        used2 = sum(PROCESS_HOURS[p] * v(f"x_{p}_RES2_{t}") for p in ["PROC2", "PROC3", "PROC4"])
        cap2  = RES_CAP[("RES2", t)]
        res2_util.append(round(used2 / cap2 * 100, 1) if cap2 else 0.0)

    r = lambda x: round(x, 1)
    return {
        "objective":            r(obj),
        "fg1_final":            r(fg1_inv[-1]),
        "fg2_final":            r(fg2_inv[-1]),
        "fg1_inv_by_period":    [r(x) for x in fg1_inv],
        "fg2_inv_by_period":    [r(x) for x in fg2_inv],
        "rm1_buy_by_period":    [r(x) for x in rm1_buy],
        "rm2_buy_by_period":    [r(x) for x in rm2_buy],
        "rm1_buy_total":        r(sum(rm1_buy)),
        "rm2_buy_total":        r(sum(rm2_buy)),
        "res1_util_by_period":  res1_util,
        "res2_util_by_period":  res2_util,
    }


# ── Per-solve runner ───────────────────────────────────────────────────────────

def run_solve(label: str, opening: dict):
    """Returns (metrics_dict, status_str)."""
    try:
        payload = build_payload(opening)
        req_id  = submit(payload)
    except Exception as e:
        sys.stderr.write(f"cuOpt submit failed ({label}): {e}\n")
        return {}, "error"

    sresp, infeasible = poll(req_id)
    if sresp is None:
        sys.stderr.write(f"cuOpt poll timeout ({label}) after {TIMEOUT_S}s\n")
        return {}, "timeout"

    status = "infeasible" if infeasible else "solved"
    return extract(sresp), status


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    baseline, b_status = run_solve("baseline", {})
    whatif,   w_status = run_solve("whatif",   OPENING)

    ok     = (b_status == "solved") and (w_status == "solved")
    status = "solved" if ok else "infeasible"

    def diff(key):
        return round(whatif.get(key, 0.0) - baseline.get(key, 0.0), 1) if ok else 0.0

    delta_obj  = diff("objective")
    delta_fg1  = diff("fg1_final")
    delta_fg2  = diff("fg2_final")
    delta_rm1  = diff("rm1_buy_total")

    if ok:
        pct = round(delta_obj / baseline["objective"] * 100) if baseline.get("objective") else 0
        explanation = (
            f"Opening stock SA1={int(OPENING['SA1'])}, RM1={int(OPENING['RM1'])}, "
            f"RM3={int(OPENING['RM3'])} lifts objective "
            f"{baseline['objective']:,.0f} → {whatif['objective']:,.0f} "
            f"(+{pct}%). "
            f"FG1 end-inv {baseline['fg1_final']:.0f} → {whatif['fg1_final']:.0f} units; "
            f"FG2 {baseline['fg2_final']:.0f} → {whatif['fg2_final']:.0f}. "
            f"RM1 buy {baseline['rm1_buy_total']:.0f} → {whatif['rm1_buy_total']:.0f} total."
        )
    else:
        explanation = f"Solve incomplete — baseline: {b_status}, what-if: {w_status}."

    envelope = {
        "kind":         "cuopt.result",
        "status":       status,
        "baseline":     baseline,
        "whatif":       whatif,
        "delta": {
            "objective":     delta_obj,
            "fg1_final":     delta_fg1,
            "fg2_final":     delta_fg2,
            "rm1_buy_total": delta_rm1,
        },
        "opening_stock": OPENING,
        "explanation":   explanation,
    }

    json.dump(envelope, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
