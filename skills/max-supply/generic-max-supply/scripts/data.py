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

import os
from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple

import pandas as pd


@dataclass
class ModelData:
    # Sets
    all_items: Set[str] = field(default_factory=set)
    procured_items: Set[str] = field(default_factory=set)
    produced_items: Set[str] = field(default_factory=set)
    final_items: Set[str] = field(default_factory=set)
    constrained_families: Set[str] = field(default_factory=set)
    unconstrained_families: Set[str] = field(default_factory=set)
    all_processes: Set[str] = field(default_factory=set)
    all_resources: Set[str] = field(default_factory=set)
    periods: List[int] = field(default_factory=list)
    process_resource_pairs: Set[Tuple[str, str]] = field(default_factory=set)

    # Scalar lookups
    item_family: Dict[str, str] = field(default_factory=dict)
    process_lead_time: Dict[str, int] = field(default_factory=dict)
    process_hours: Dict[str, float] = field(default_factory=dict)

    # Indexed parameters
    process_input_qty: Dict[Tuple[str, str], float] = field(default_factory=dict)
    process_output_qty: Dict[Tuple[str, str], float] = field(default_factory=dict)
    resource_capacity: Dict[Tuple[str, int], float] = field(default_factory=dict)
    supply_qty: Dict[Tuple[str, int], float] = field(default_factory=dict)
    demand_weight: Dict[str, float] = field(default_factory=dict)

    # Graph adjacency
    item_producing_processes: Dict[str, List[str]] = field(default_factory=dict)
    item_consuming_processes: Dict[str, List[str]] = field(default_factory=dict)
    process_to_resources: Dict[str, List[str]] = field(default_factory=dict)
    resource_to_processes: Dict[str, List[str]] = field(default_factory=dict)

    # Constraint flags
    process_is_constrained: Dict[str, bool] = field(default_factory=dict)


def load_data(input_dir: str, num_periods: int) -> ModelData:
    items_df = pd.read_csv(os.path.join(input_dir, "items.csv"))
    families_df = pd.read_csv(os.path.join(input_dir, "families.csv"))
    processes_df = pd.read_csv(os.path.join(input_dir, "processes.csv"))
    process_inputs_df = pd.read_csv(os.path.join(input_dir, "process_inputs.csv"))
    process_outputs_df = pd.read_csv(os.path.join(input_dir, "process_outputs.csv"))
    resources_df = pd.read_csv(os.path.join(input_dir, "resources.csv"))
    process_resources_df = pd.read_csv(os.path.join(input_dir, "process_resources.csv"))
    supply_df = pd.read_csv(os.path.join(input_dir, "supply.csv"))
    demand_df = pd.read_csv(os.path.join(input_dir, "demand.csv"))

    data = ModelData()

    # --- Core sets ---
    data.all_items = set(items_df["item_id"])
    data.all_processes = set(processes_df["process_id"])
    data.all_resources = set(resources_df["resource_id"].unique())
    data.periods = list(range(1, num_periods + 1))

    data.produced_items = set(process_outputs_df["item_id"])
    data.procured_items = data.all_items - data.produced_items
    data.final_items = set(demand_df["item_id"])

    # --- Family classification ---
    is_true = families_df["is_constrained"].apply(lambda v: str(v).lower() in ("true", "1", "yes"))
    data.constrained_families = set(families_df.loc[is_true, "family_id"])
    data.unconstrained_families = set(families_df.loc[~is_true, "family_id"])

    # --- Scalar lookups ---
    data.item_family = dict(zip(items_df["item_id"], items_df["family_id"]))
    data.process_lead_time = dict(zip(processes_df["process_id"], processes_df["lead_time"].astype(int)))
    data.process_hours = dict(zip(processes_df["process_id"], processes_df["hours_per_unit"].astype(float)))

    # --- BOM quantities ---
    for _, row in process_inputs_df.iterrows():
        data.process_input_qty[(row["process_id"], row["item_id"])] = float(row["quantity"])
        data.item_consuming_processes.setdefault(row["item_id"], []).append(row["process_id"])

    for _, row in process_outputs_df.iterrows():
        data.process_output_qty[(row["process_id"], row["item_id"])] = float(row["quantity"])
        data.item_producing_processes.setdefault(row["item_id"], []).append(row["process_id"])

    # --- Resources ---
    for _, row in resources_df.iterrows():
        data.resource_capacity[(row["resource_id"], int(row["period"]))] = float(row["available_hours"])

    for _, row in process_resources_df.iterrows():
        p, r = row["process_id"], row["resource_id"]
        data.process_resource_pairs.add((p, r))
        data.process_to_resources.setdefault(p, []).append(r)
        data.resource_to_processes.setdefault(r, []).append(p)

    # --- Supply ---
    for _, row in supply_df.iterrows():
        data.supply_qty[(row["item_id"], int(row["period"]))] = float(row["quantity"])

    # --- Demand ---
    data.demand_weight = dict(zip(demand_df["item_id"], demand_df["priority_weight"].astype(float)))

    # --- Derived: process constrained flag ---
    # A process is resource-constrained if any of its output items belongs
    # to a constrained family.
    for p in data.all_processes:
        output_items = [i for (pp, i) in data.process_output_qty if pp == p]
        data.process_is_constrained[p] = any(data.item_family.get(i) in data.constrained_families for i in output_items)

    return data
