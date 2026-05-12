# cuOpt Skill Contract

The cuOpt skill is not implemented yet. This contract defines the minimum interface expected by the GTC Taipei frontend and the orchestration backend.

## Input

```json
{
  "scenario_id": "taiwan-manufacturing-supply-chain",
  "objective": {
    "primary": "minimize_total_cost",
    "secondary": ["minimize_cycle_time", "maximize_service_level", "preserve_capacity_buffer"]
  },
  "nodes": [
    { "id": "taipei", "type": "command" },
    { "id": "hsinchu", "type": "wafer_supply" },
    { "id": "taichung", "type": "precision_components" },
    { "id": "tainan", "type": "advanced_packaging" },
    { "id": "kaohsiung", "type": "port" },
    { "id": "taoyuan", "type": "airport" }
  ],
  "constraints": {
    "weekly_lots": 1240,
    "priority_lots": 180,
    "max_node_utilization": 0.85,
    "weather_buffer_required": true
  }
}
```

## Output

```json
{
  "status": "solved",
  "objective_value": 0.91,
  "selected_lanes": [
    { "from": "taipei", "to": "hsinchu", "mode": "truck", "weekly_lots": 420 },
    { "from": "hsinchu", "to": "taichung", "mode": "truck", "weekly_lots": 380 },
    { "from": "taichung", "to": "tainan", "mode": "truck", "weekly_lots": 360 }
  ],
  "metrics": {
    "weekly_logistics_cost_usd": 5600000,
    "mean_cycle_days": 4.3,
    "unassigned_priority_lots": 4,
    "peak_capacity_pressure": 0.71
  },
  "capacity": [
    { "node": "hsinchu", "utilization": 0.82 },
    { "node": "tainan", "utilization": 0.77 }
  ],
  "explanation": "Route assignment reduces peak pressure while preserving buffer capacity for expedite demand."
}
```

## Frontend Requirements

The frontend expects the orchestration backend to convert this output into:

- route geometry or route IDs for map highlighting
- metric rows for the economics panel
- capacity values for chart generation
- compact narrative text for the run console
