# GTC Taipei CUDA-X Supply Chain Demo

This repo contains a dependency-free frontend demo for a GTC Taipei storyline:

1. A packaged `cuOpt` skill solves an advanced manufacturing supply-chain routing problem through Taiwan.
2. Vision Insights sends the generated chart or dashboard artifact to Nemotron Omni for visual interpretation.
3. AIQ Research turns the optimized route, chart insights, competitive context, risks, and feasibility into an in-depth business plan.
4. The frontend can toggle the active agent harness between Codex and Claude. Both harnesses are presented as peers with access to the same packaged skills.

The current implementation is a runnable UI with mock skill adapters and realistic integration contracts. It is designed so the mock data can be replaced by real skill calls without changing the demo choreography.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

## Verify

```bash
npm test
```

The test checks that the static assets and demo data are present and internally consistent.

## Repo Layout

- `index.html`, `styles.css`, `app.js`: single-page frontend.
- `data/supply-chain.json`: scenario data, metric values, harness-specific insights, and business-plan sections.
- `skills/cuopt/contract.md`: draft contract for the future cuOpt skill.
- `skills/aiq-research/adapter.md`: notes for calling the existing AIQ Research skill.
- `skills/vision-insights/adapter.md`: notes for calling Vision Insights with Nemotron Omni.
- `docs/demo-script.md`: stage-by-stage talk track.
- `docs/integration-plan.md`: path from mock adapters to live skill orchestration.

## Intended Live Flow

```text
Frontend -> selected harness (Codex or Claude)
Selected harness -> cuOpt skill -> optimized supply-chain plan
Selected harness -> Vision Insights skill -> chart and dashboard analysis
Selected harness -> AIQ Research skill -> citation-backed business plan
Frontend <- progress events, metrics, visual insights, final plan
```
