# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Max-supply optimisation model using the cuOpt MILP API.

Maximises weighted end-of-horizon inventory of finished goods subject to:
  - Multi-level bill of materials with process lead times
  - Floor-truncation of fractional yields (integer usable output)
  - Per-period supply limits for constrained material families
  - Resource capacity constraints (hours per period)

Input data is read from scripts/data/ (CSV files). Run from skill root: python scripts/model.py
"""

from pathlib import Path

from cuopt.linear_programming.problem import CONTINUOUS, INTEGER, MAXIMIZE, Problem
from cuopt.linear_programming.solver_settings.solver_settings import SolverSettings
from data import load_data

DIR = Path(__file__).resolve().parent
DATA_DIR = DIR / "data"


def main():
    input_dir = str(DATA_DIR)
    num_periods = 10
    truncation_epsilon = 1e-4

    # ------------------------------------------------------------------
    # Load data
    # ------------------------------------------------------------------
    print("Loading data...")
    data = load_data(input_dir, num_periods)
    print(
        f"  {len(data.all_items)} items, {len(data.all_processes)} processes, "
        f"{len(data.all_resources)} resources, {num_periods} periods"
    )

    # ------------------------------------------------------------------
    # Create cuOpt problem
    # ------------------------------------------------------------------
    print("Building model...")
    prob = Problem("MaxSupply")

    # ------------------------------------------------------------------
    # Decision variables
    # ------------------------------------------------------------------

    # x[p, r, t] — units of process p executed on resource r in period t
    x = {}
    for (p, r) in sorted(data.process_resource_pairs):
        for t in data.periods:
            x[p, r, t] = prob.addVariable(lb=0.0, vtype=CONTINUOUS, name=f"x_{p}_{r}_{t}")

    # produced[i, t] — continuous production (may be fractional)
    produced = {}
    for i in sorted(data.produced_items):
        for t in data.periods:
            produced[i, t] = prob.addVariable(lb=0.0, vtype=CONTINUOUS, name=f"produced_{i}_{t}")

    # used[i, t] — usable (floor-truncated) production, integer
    used = {}
    for i in sorted(data.produced_items):
        for t in data.periods:
            used[i, t] = prob.addVariable(lb=0.0, vtype=INTEGER, name=f"used_{i}_{t}")

    # buy[i, t] — procurement of raw / procured items
    buy = {}
    for i in sorted(data.procured_items):
        for t in data.periods:
            buy[i, t] = prob.addVariable(lb=0.0, vtype=CONTINUOUS, name=f"buy_{i}_{t}")

    # inventory[i, t] — inventory (period 0 = initial, fixed to zero)
    inventory = {}
    for i in sorted(data.all_items):
        inventory[i, 0] = prob.addVariable(lb=0.0, ub=0.0, vtype=CONTINUOUS, name=f"inv_{i}_0")
        for t in data.periods:
            inventory[i, t] = prob.addVariable(lb=0.0, vtype=CONTINUOUS, name=f"inv_{i}_{t}")

    # ------------------------------------------------------------------
    # Constraints
    # ------------------------------------------------------------------

    # C1: Production definition — produced[i,t] = Σ qty · x[p,r,start_t]
    #     (process started at start_t = t − lead_time delivers output at t)
    for i in sorted(data.produced_items):
        for t in data.periods:
            terms = []
            for p in data.item_producing_processes.get(i, []):
                start_t = t - data.process_lead_time[p]
                if start_t < 1:
                    continue
                qty = data.process_output_qty[(p, i)]
                for r in data.process_to_resources.get(p, []):
                    terms.append(qty * x[p, r, start_t])
            prob.addConstraint(produced[i, t] == sum(terms), name=f"prod_def_{i}_{t}")

    # C2a: Truncation upper — used[i,t] ≤ produced[i,t]
    for i in sorted(data.produced_items):
        for t in data.periods:
            prob.addConstraint(used[i, t] <= produced[i, t], name=f"trunc_upper_{i}_{t}")

    # C2b: Truncation lower — used[i,t] ≥ produced[i,t] − (1 − ε)
    for i in sorted(data.produced_items):
        for t in data.periods:
            prob.addConstraint(
                used[i, t] >= produced[i, t] - (1.0 - truncation_epsilon),
                name=f"trunc_lower_{i}_{t}",
            )

    # C3a: Material balance — procured items
    #      inv[i,t] = inv[i,t−1] + buy[i,t] − consumption
    for i in sorted(data.procured_items):
        for t in data.periods:
            consumption = sum(
                data.process_input_qty[(p, i)] * x[p, r, t]
                for p in data.item_consuming_processes.get(i, [])
                for r in data.process_to_resources.get(p, [])
            )
            prob.addConstraint(
                inventory[i, t] == inventory[i, t - 1] + buy[i, t] - consumption,
                name=f"bal_proc_{i}_{t}",
            )

    # C3b: Material balance — produced items
    #      inv[i,t] = inv[i,t−1] + used[i,t] − consumption
    for i in sorted(data.produced_items):
        for t in data.periods:
            consumption = sum(
                data.process_input_qty[(p, i)] * x[p, r, t]
                for p in data.item_consuming_processes.get(i, [])
                for r in data.process_to_resources.get(p, [])
            )
            prob.addConstraint(
                inventory[i, t] == inventory[i, t - 1] + used[i, t] - consumption,
                name=f"bal_prod_{i}_{t}",
            )

    # C4: Supply limits for procured items in constrained families
    for i in sorted(data.procured_items):
        for t in data.periods:
            if data.item_family[i] in data.unconstrained_families:
                continue
            limit = data.supply_qty.get((i, t), 0)
            prob.addConstraint(buy[i, t] <= limit, name=f"supply_{i}_{t}")

    # C5: Resource capacity per period
    for r in sorted(data.all_resources):
        for t in data.periods:
            terms = [
                data.process_hours[p] * x[p, r, t]
                for p in data.resource_to_processes.get(r, [])
                if data.process_is_constrained.get(p, True)
            ]
            cap = data.resource_capacity.get((r, t), 0)
            if terms:
                prob.addConstraint(sum(terms) <= cap, name=f"cap_{r}_{t}")

    # ------------------------------------------------------------------
    # Objective: maximise weighted inventory of final products at horizon end
    # ------------------------------------------------------------------
    last_t = max(data.periods)
    obj_expr = sum(data.demand_weight[i] * inventory[i, last_t] for i in data.final_items)
    prob.setObjective(obj_expr, sense=MAXIMIZE)

    # ------------------------------------------------------------------
    # Solve
    # ------------------------------------------------------------------
    print("Solving...")
    settings = SolverSettings()
    settings.set_parameter("mip_relative_gap", 0.01)
    prob.solve(settings)

    # ------------------------------------------------------------------
    # Print results summary
    # ------------------------------------------------------------------
    obj_val = prob.ObjValue

    print()
    print("=" * 60)
    print("MAX SUPPLY OPTIMIZATION — RESULTS SUMMARY")
    print("=" * 60)
    print()
    print(f"Objective value: {obj_val:,.2f}")
    print()
    print("Final product inventory at end of horizon:")
    for i in sorted(data.final_items):
        inv = inventory[i, last_t].Value
        weight = data.demand_weight[i]
        print(f"  {i}: {inv:,.0f} units  (priority weight: {weight:,.0f})")


if __name__ == "__main__":
    main()
