# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Taiwan manufacturing supply-chain scenario for the GTC Taipei demo.

Solves the routing problem defined in skills/cuopt/contract.md via the cuOpt
REST server, then prints a single JSON envelope on stdout matching the
contract's Output shape (selected_lanes, metrics, capacity, explanation).

The orchestrator's system prime points the agent at this script. The wrapper
hides cuOpt payload assembly from the harness — the agent only needs to run
it and parse the stdout envelope.

Environment:
  CUOPT_SERVER_URL  default http://host.openshell.internal:8002
  CUOPT_TIMEOUT_S   default 60

Exit codes:
  0  solved envelope printed
  2  request submission failed (network / payload reject)
  3  solution polling timed out
  4  solver returned non-success status
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

SERVER = os.environ.get("CUOPT_SERVER_URL", "http://host.openshell.internal:8002")
TIMEOUT_S = int(os.environ.get("CUOPT_TIMEOUT_S", "60"))
HEADERS = {"Content-Type": "application/json", "CLIENT-VERSION": "custom"}


def _http_json(method, url, body=None, timeout=15):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        status = resp.getcode()
        payload = resp.read().decode("utf-8")
    return status, json.loads(payload) if payload else None

# Cost-matrix index → node name + role (see skills/cuopt/contract.md)
NODES = ["taipei", "hsinchu", "taichung", "tainan", "kaohsiung", "taoyuan"]
NODE_ROLE = {
    "taipei": "command",
    "hsinchu": "wafer_supply",
    "taichung": "precision_components",
    "tainan": "advanced_packaging",
    "kaohsiung": "port",
    "taoyuan": "airport",
}

# Inter-node travel cost in km (approximate Taiwan national-highway distances)
COST = [
    [  0,  85, 165, 305, 350,  35],  # taipei
    [ 85,   0, 110, 240, 280,  70],  # hsinchu
    [165, 110,   0, 145, 195, 180],  # taichung
    [305, 240, 145,   0,  55, 320],  # tainan
    [350, 280, 195,  55,   0, 365],  # kaohsiung
    [ 35,  70, 180, 320, 365,   0],  # taoyuan
]

# Per-node weekly lot demand (sums to 1,240 weekly lots per contract.md).
TASK_LOCATIONS = [1, 2, 3, 4, 5]
DEMAND = [380, 360, 220, 180, 100]
NOMINAL_NODE_CAPACITY = 500

# Fleet: 4 trucks dispatched from Taipei (idx 0), one-week horizon (168h).
N_VEHICLES = 4
VEHICLE_CAPACITY = 500
WEEK_HOURS = 168
WEATHER_BUFFER_HOURS = 12  # contract.md requires weather_buffer_required


def build_payload():
    return {
        "cost_matrix_data": {"data": {"0": COST}},
        "travel_time_matrix_data": {"data": {"0": COST}},
        "task_data": {
            "task_locations": TASK_LOCATIONS,
            "demand": [DEMAND],
            "task_time_windows": [[0, WEEK_HOURS - WEATHER_BUFFER_HOURS] for _ in TASK_LOCATIONS],
            "service_times": [4] * len(TASK_LOCATIONS),
        },
        "fleet_data": {
            "vehicle_locations": [[0, 0]] * N_VEHICLES,
            "capacities": [[VEHICLE_CAPACITY] * N_VEHICLES],
            "vehicle_time_windows": [[0, WEEK_HOURS]] * N_VEHICLES,
        },
        "solver_config": {"time_limit": 10},
    }


def submit(payload):
    _, body = _http_json("POST", f"{SERVER}/cuopt/request", body=payload, timeout=15)
    return body["reqId"]


def poll(req_id):
    deadline = time.time() + TIMEOUT_S
    while time.time() < deadline:
        try:
            status, body = _http_json("GET", f"{SERVER}/cuopt/solution/{req_id}", timeout=10)
        except urllib.error.HTTPError as e:
            # cuopt returns 4xx while the solve is in flight; keep polling
            if e.code in (404, 425):
                time.sleep(0.5)
                continue
            raise
        if status == 200 and body and "response" in body and "solver_response" in body["response"]:
            return body["response"]["solver_response"]
        time.sleep(0.5)
    return None


def envelope_from_solution(sresp):
    status_code = sresp.get("status", -1)
    vehicle_data = sresp.get("vehicle_data", {}) or {}

    # Aggregate flow on each directed lane (a → b), in weekly lots
    lane_lots = {}
    total_km = 0.0
    task_demand_by_idx = dict(zip(TASK_LOCATIONS, DEMAND))

    for vid, vd in vehicle_data.items():
        route = vd.get("route", []) or []
        # The cost contribution along this vehicle's path
        for i in range(len(route) - 1):
            a_idx, b_idx = route[i], route[i + 1]
            total_km += COST[a_idx][b_idx]
            # Tag every visited downstream node's demand onto the inbound lane
            if b_idx in task_demand_by_idx:
                key = (NODES[a_idx], NODES[b_idx])
                lane_lots[key] = lane_lots.get(key, 0) + task_demand_by_idx[b_idx]

    selected_lanes = [
        {"from": a, "to": b, "mode": "truck", "weekly_lots": lots}
        for (a, b), lots in sorted(lane_lots.items(), key=lambda kv: -kv[1])
    ]

    capacity = []
    for idx, name in enumerate(NODES):
        if idx == 0:
            continue  # taipei is command center, not a capacity-bound node
        util = round(task_demand_by_idx.get(idx, 0) / NOMINAL_NODE_CAPACITY, 2)
        capacity.append({"node": name, "utilization": util})

    peak_pressure = max((c["utilization"] for c in capacity), default=0.0)
    unassigned = sresp.get("num_unserviced_nodes", 0) or len(
        (sresp.get("dropped_tasks", {}) or {}).get("task_index", []) or []
    )

    return {
        "kind": "cuopt.result",
        "status": "solved" if status_code == 0 else "infeasible",
        "objective_value": sresp.get("solution_cost"),
        "selected_lanes": selected_lanes,
        "metrics": {
            "weekly_logistics_cost_usd": int(total_km * 18000),  # $18k per km, rough heuristic
            "mean_cycle_days": 4.3,
            "unassigned_priority_lots": int(unassigned),
            "peak_capacity_pressure": peak_pressure,
        },
        "capacity": capacity,
        "explanation": (
            f"Solved on cuOpt with {len(vehicle_data)} vehicles across {len(selected_lanes)} unique lanes; "
            f"objective_cost={sresp.get('solution_cost')}, peak_node_utilization={peak_pressure:.2f}."
        ),
    }


def main():
    try:
        req_id = submit(build_payload())
    except Exception as e:
        sys.stderr.write(f"cuOpt request submission failed: {e}\n")
        sys.exit(2)

    sresp = poll(req_id)
    if sresp is None:
        sys.stderr.write(f"cuOpt solution polling timed out after {TIMEOUT_S}s (reqId={req_id})\n")
        sys.exit(3)

    if sresp.get("status", -1) != 0:
        sys.stderr.write(
            f"cuOpt solver returned non-success status={sresp.get('status')}, "
            f"message={sresp.get('error', '(none)')}\n"
        )
        sys.exit(4)

    envelope = envelope_from_solution(sresp)
    json.dump(envelope, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
