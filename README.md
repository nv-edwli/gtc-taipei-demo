# GTC Taipei CUDA-X Supply Chain Demo

This repo contains a dependency-free frontend demo for a GTC Taipei storyline:

1. A packaged `cuOpt` skill solves an advanced manufacturing supply-chain routing problem through Taiwan.
2. Vision Insights sends the generated chart or dashboard artifact to Nemotron Omni for visual interpretation.
3. AIQ Research turns the optimized route, chart insights, competitive context, risks, and feasibility into an in-depth business plan.
4. The frontend can toggle the active agent harness between Codex and Claude. Both harnesses are presented as peers with access to the same packaged skills.

The demo runs real cuOpt, Vision Insights, and AIQ Research skill calls through a selectable Codex or Claude harness. If cuOpt is unreachable the UI falls back to a bundled reference plan so the demo never dead-ends on a network blip. Vision and AIQ are always live.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

First start verifies sandbox reachability and syncs the bundled sample image. AIQ auth tokens live in `~/.aiq/tokens/` and are synced into the sandbox automatically. If you rotate a token, restart `npm start` to push it across.

## Verify

```bash
npm test
```

The test checks that the static assets and demo data are present and internally consistent.

## Repo Layout

- `index.html`, `styles.css`, `app.js`: single-page frontend.
- `data/supply-chain.json`: scenario data, metric values, harness-specific insights, and business-plan sections.
- `skills/cuopt/contract.md`: cuOpt envelope I/O contract (live).
- `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py`: live solver wrapper called by the agent at runtime.
- `app-cuopt.mjs`: client-side envelope parser + UI transformer.
- `skills/aiq-research/SKILL.md` (+ `scripts/aiq.py`): the AIQ Research skill.
- `skills/vision-insights/SKILL.md` (+ `scripts/vision_analyze.py`): the Vision Insights skill (Nemotron Omni).
- `docs/demo-script.md`: stage-by-stage talk track.
- `docs/integration-plan.md`: path from mock adapters to live skill orchestration.
- `policies/my-assistant-policy.yaml`: OpenShell sandbox policy used by the live `my-assistant` sandbox that hosts the demo (apply with `openshell policy set my-assistant --policy policies/my-assistant-policy.yaml`).

## Live Flow

```text
Frontend -> selected harness (Codex or Claude) -> system prime (server/sandbox.mjs:buildSystemPrime)
Harness -> cuOpt taiwan_supply_chain/run.py -> envelope {selected_lanes, metrics, capacity, explanation}
                                              -> on failure: UI falls back to bundled reference plan
Harness -> Vision Insights vision_analyze.py -> Nemotron Omni summary
Harness -> AIQ Research aiq.py research "<q>" shallow_researcher -> report JSON
Frontend <- NDJSON beats (tool.invoked, tool.completed, assistant.text, run.completed)
```
