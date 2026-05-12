# Integration Plan

## Current State

The frontend is live and data-driven, but all skill outputs are mocked in `data/supply-chain.json`. This is intentional for the first GTC demo shell because it keeps the run deterministic and portable.

## Backend Toggle

The `Codex` and `Claude` segmented control should eventually select the orchestration backend:

```http
POST /api/runs
{
  "harness": "codex",
  "scenario": "taiwan-manufacturing-supply-chain"
}
```

The backend should stream progress events with a stable shape:

```json
{
  "stage": "cuopt",
  "status": "running",
  "message": "Invoking cuOpt skill",
  "artifact": null
}
```

Both harnesses should call the same packaged skills and return the same artifact schema.

## cuOpt Skill

Replace the mock `metrics.optimized` and route animation trigger with the output of `skills/cuopt/contract.md`. The first live version only needs:

- objective summary
- selected lanes
- rejected lanes
- per-node utilization
- cost, cycle-time, and service-level metrics

## Vision Insights Skill

Generate a chart image from the cuOpt result, then call:

```bash
python3 ~/.claude/skills/vision-insights/scripts/vision_analyze.py \
  --preset chart \
  --max-tokens 6000 \
  ./artifacts/cuopt-capacity.png
```

The returned final answer can populate the Vision Insights panel. Keep the raw model reasoning out of the frontend unless the demo explicitly needs a debug view.

## AIQ Research Skill

Start with auth:

```bash
python3 ~/.claude/skills/aiq-research/scripts/aiq.py check-auth
```

Submit a research prompt containing:

- the optimized route summary
- key cuOpt metrics
- Vision Insights chart summary
- target audience and desired business-plan depth
- required sections: strategy, market, risk, feasibility, execution

If the AIQ response returns a `deep_research_running` job ID, stream the status into the run trace and fetch the final report when complete.

## Frontend Event Contract

The frontend can stay framework-free if the backend exposes server-sent events:

```http
GET /api/runs/{run_id}/events
```

Event types:

- `stage.started`
- `stage.progress`
- `artifact.created`
- `stage.completed`
- `run.completed`
- `run.failed`

This keeps the UI unchanged while allowing either Codex or Claude to power the run.
