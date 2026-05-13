---
name: generic-max-supply
description: >
  Multi-period supply chain planning model: data files, BOM structure,
  variable/constraint reference for the max-supply base model.
usage: >
  - Use for *formulating* or *modifying* the max-supply MILP (constraints, objective, BOM).
  Read data file map and variable/constraint reference before coding. Scripts and data under this skill (scripts/, scripts/data/).
  - One task only; do not split (e.g. change model, run, compare in one step).
---

# Generic Max-Supply Planning

## Core

- **Execution order (mandatory):** read `scripts/model.py` first, then decide relevant CSV files from the prompt, then read only those CSVs, then run baseline `model.py`, then copy to `model_whatif.py`, apply a targeted edit, and run `model_whatif.py`.
- **Source data and reference model:** **scripts/** for Python (`data.py`, `model.py`); **scripts/data/** for CSV inputs. `load_data(data_dir, num_periods)` reads from that data directory; optional cost/backlog files are read separately if needed.

## Workspace layout

| Location | Contents |
|----------|----------|
| **scripts/** | Python: `data.py` (load_data), `model.py` (build/solve). Run from repository root (or your run directory) with `python scripts/model.py`. |
| **scripts/data/** | Required and optional CSV files (items, families, processes, supply, demand, etc.). All files from the [data file map](#data-file-map) live here. |

## Using in the working directory

Do not modify the skill files. To run or change the model: (1) Copy `skills/generic-max-supply/scripts/` into your run directory. (2) Edit only the copy. (3) Run from that run directory or repository root. Do not assume a fixed sandbox cwd.

```bash
cp -r skills/generic-max-supply/scripts . && python3 scripts/model.py
```
(From repository root, this copies `skills/generic-max-supply/scripts/` to `./scripts/`.)

## What-If Variants

To run a what-if scenario (e.g. change opening inventory, tighten a supply cap, modify a cost):

1. Read `model.py` first (required), identify which model block changes, and infer which CSV files are relevant to the requested change.

2. Read only relevant CSV files for the prompt. Do not read all CSVs unless explicitly requested.

3. Copy the scripts to the working directory and fix the data path:
   ```bash
   cp skills/generic-max-supply/scripts/data.py data.py
   cp skills/generic-max-supply/scripts/model.py model.py
   ```
   Then update `DATA_DIR` in the copied `model.py` to match your CSV location.

4. Run baseline first and capture base objective:
   ```bash
   python model.py
   ```

5. Fork the working model:
   ```bash
   cp model.py model_whatif.py
   ```

6. Use `edit_file` to make **only** the targeted change in `model_whatif.py`.

7. Run the what-if model and compare against baseline:
   ```bash
   python model_whatif.py   # ← this is the what-if result
   ```

**Do not rewrite the model from scratch.** One targeted edit keeps the change isolated and the comparison meaningful.

## Problem overview

**Type:** MILP (Mixed-Integer Linear Program)
**Sense:** MAXIMIZE
**Horizon:** configurable `num_periods` (default 10)

The planner decides how many units of each manufacturing process to run on each resource in each period. The goal is to maximise the weighted sum of finished-good inventory at the end of the last period. Constraints capture multi-level BOM structure, lead-time offsets, integer yield truncation, material supply caps, and machine-hour capacity.

## Data file map

All files live in the same directory (**scripts/data/**). `load_data(data_dir, num_periods)` reads all required CSVs from that directory; the three optional cost/backlog files are read separately if needed.

| File | Key columns | What it populates |
|------|-------------|-------------------|
| `items.csv` | `item_id`, `name`, `family_id` | `all_items`, `item_family` lookup |
| `families.csv` | `family_id`, `name`, `is_constrained` | `constrained_families`, `unconstrained_families` |
| `processes.csv` | `process_id`, `name`, `lead_time`, `hours_per_unit` | `all_processes`, `process_lead_time`, `process_hours` |
| `process_inputs.csv` | `process_id`, `item_id`, `quantity` | `process_input_qty[(p,i)]`, `item_consuming_processes` |
| `process_outputs.csv` | `process_id`, `item_id`, `quantity` | `process_output_qty[(p,i)]`, `item_producing_processes`, derives `produced_items` |
| `process_resources.csv` | `process_id`, `resource_id` | `process_resource_pairs`, `process_to_resources`, `resource_to_processes` |
| `resources.csv` | `resource_id`, `name`, `period`, `available_hours` | `all_resources`, `resource_capacity[(r,t)]` |
| `supply.csv` | `item_id`, `period`, `quantity` | `supply_qty[(i,t)]` — upper bound on procurement per period |
| `demand.csv` | `item_id`, `period`, `quantity`, `priority_weight` | `final_items`, `demand_weight[i]` (only `priority_weight` is used in the base model) |

**Optional files — NOT loaded by `data.py`; read separately if needed:**

| File | Key columns | Purpose |
|------|-------------|---------|
| `item_costs.csv` | `item_id`, `unit_cost`, `holding_cost` | Per-unit purchase cot and per-period holding cost |
| `resource_costs.csv` | `resource_id`, `production_cost_per_hour` | Cost per machine-hour by resource |
| `backlog_params.csv` | `parameter`, `value` | Single row: `backlog_cost_rate` |

## Key sets and derivation

```python
produced_items      = set(process_outputs_df["item_id"])
procured_items      = all_items - produced_items
final_items         = set(demand_df["item_id"])

constrained_families   = {f where is_constrained == True}
unconstrained_families = {f where is_constrained == False}

# A process is constrained if ANY of its output items is in a constrained family.
process_is_constrained[p] = any(
    item_family[i] in constrained_families
    for i in outputs_of(p)
)
```

In the sample dataset: `FAM_FG`, `FAM_SA`, `FAM_RM1` are constrained; `FAM_RM2` is not. `RM3` (family `FAM_RM2`) is procured but unconstrained — no supply cap applied. All four processes (`PROC1`–`PROC4`) are constrained because they produce items in constrained families.

## Variable reference

| Variable | Represents | Domain | Initialisation |
|----------|-----------|--------|----------------|
| `x[p, r, t]` | Units of process `p` executed on resource `r` starting in period `t` | Continuous ≥ 0 | `addVariable(lb=0, vtype=CONTINUOUS)` |
| `produced[i, t]` | Continuous (possibly fractional) output of item `i` in period `t` | Continuous ≥ 0 | `addVariable(lb=0, vtype=CONTINUOUS)` |
| `used[i, t]` | Usable (floor-truncated) integer output of item `i` in period `t` | Integer ≥ 0 | `addVariable(lb=0, vtype=INTEGER)` |
| `buy[i, t]` | Units of procured item `i` purchased in period `t` | Continuous ≥ 0 | `addVariable(lb=0, vtype=CONTINUOUS)` |
| `inventory[i, t]` | On-hand inventory of item `i` at end of period `t` | Continuous ≥ 0 | `addVariable(lb=0, vtype=CONTINUOUS)` |
| `inventory[i, 0]` | Opening balance (fixed to zero) | Continuous, lb=ub=0 | `addVariable(lb=0, ub=0, vtype=CONTINUOUS)` |

`inventory[i, 0]` is a fixed variable (lb = ub = 0). For a non-zero opening balance, set ub = lb = opening_balance.

## Constraint map

| Label | Name pattern | What it enforces | Variables linked |
|-------|-------------|-----------------|-----------------|
| C1 | `prod_def_{i}_{t}` | `produced[i,t]` equals the sum of BOM-output quantities from all processes that **started** at `t − lead_time` | `produced`, `x` |
| C2a | `trunc_upper_{i}_{t}` | `used[i,t] ≤ produced[i,t]` (integer cannot exceed real output) | `used`, `produced` |
| C2b | `trunc_lower_{i}_{t}` | `used[i,t] ≥ produced[i,t] − (1 − ε)` with ε = 1e-4 (forces integer to be the floor) | `used`, `produced` |
| C3a | `bal_proc_{i}_{t}` | Material balance for **procured** items: `inv[i,t] = inv[i,t−1] + buy[i,t] − consumption` | `inventory`, `buy`, `x` |
| C3b | `bal_prod_{i}_{t}` | Material balance for **produced** items: `inv[i,t] = inv[i,t−1] + used[i,t] − consumption` | `inventory`, `used`, `x` |
| C4 | `supply_{i}_{t}` | `buy[i,t] ≤ supply_qty[(i,t)]` — only applied to procured items in **constrained** families | `buy` |
| C5 | `cap_{r}_{t}` | `Σ hours_per_unit[p] · x[p,r,t] ≤ capacity[(r,t)]` — only processes where `process_is_constrained[p]` is True | `x` |

**Lead-time note:** C1 uses `start_t = t − lead_time[p]`. If `start_t < 1`, the term is skipped (process cannot have started before period 1).

## Objective

```python
last_t = max(data.periods)
obj = Σ  demand_weight[i] * inventory[i, last_t]   for i in final_items
```

Maximise the priority-weighted inventory of finished goods at the end of the planning horizon. `demand_weight` comes from the `priority_weight` column in `demand.csv` (the `quantity` column in demand.csv is present but not used by the base model).

## Solver settings (default)

```python
settings = SolverSettings()
settings.set_parameter("mip_relative_gap", 0.01)
prob.solve(settings)
```

`mip_relative_gap = 0.01` (1% gap). **Do not change solver precision** (e.g. do not tighten to 0.1% or 0.0); use this default only.

## Sanity-checking results

After solving, verify the model is correct:

1. **Check model size changed** when you add items/constraints. The solver log prints `Solving a problem with N constraints, M variables`. If you added a new item or constraint but N and M are unchanged, your data edits did not take effect — check that you edited the CSV files in the working directory.
2. **Check item count** in the `Loading data...` output matches your expectation (e.g., adding RM4 should increase the item count by 1).
3. **Check objective value** actually changed meaningfully. Differences smaller than the MIP gap (~1%) may just be solver noise, not real model changes.

## Quick links by task

| Task | Use |
|------|-----|
| Implement or extend the base model | Data file map, key sets, variable reference, constraint map, objective. |
| Load or modify input data | Data file map; optional files read separately. |
| Tune or run the solver | Solver settings (default); data in **scripts/data/** by default. |
| Verify results after changes | Sanity-checking results. |
