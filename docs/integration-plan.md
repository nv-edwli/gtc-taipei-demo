# Integration

How the live skill flow is wired and how to extend it.

## Current state

The three skills are live:

| Skill | Script | Where it runs |
| --- | --- | --- |
| cuOpt | `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` | Local cuOpt REST server at `host.openshell.internal:8002` (GB10 GPU). |
| Vision Insights | `skills/vision-insights/scripts/vision_analyze.py` | Nemotron Omni at `host.openshell.internal:8000` (NIM endpoint). |
| AIQ Research | `skills/aiq-research/scripts/aiq.py research "<q>" shallow_researcher` | Remote `api.aiq.nvidia.com` (NVAuth-gated). |

Surface selection (`surface: "auto" | "sandbox" | "host"`) lives in `server/sandbox.mjs`. Auto pings the openshell sandbox via `checkSandbox()` and picks sandbox if reachable, otherwise host. The system prime that lists the available skill scripts is assembled in `server/sandbox.mjs:buildSystemPrime`.

## Adding a new skill

A new skill (call it `xyz`) needs the following wiring:

1. **Register in the system prime.** Add a bullet to `server/sandbox.mjs:buildSystemPrime` describing the script path and stdout shape. The agent only knows about scripts that appear here.
2. **Add a stage hint (if it deserves its own stage).** Add an entry to `STAGE_HINTS` in BOTH `server/normalize-claude.mjs` and `server/normalize-codex.mjs`. Pick unambiguous tokens (script name fragments, unique JSON markers) that won't collide with other skills.
3. **Add a parser in `app.js` (if stdout is structured).** Mirror the `cuopt` pattern: parse client-side, route through a single `applyXyzResult` commit-point, render to a stage panel.
4. **Add a smoke-test assertion.** In `scripts/check.mjs`, assert that the system prime contains the new script path.
5. **Update the data shape.** If the skill needs scenario data, extend `data/supply-chain.json` and `scripts/check.mjs`'s shape checks.

## Event contract

`/api/run` returns NDJSON beats of the form `{ "kind": "...", "data": {...} }`. The orchestrator emits:

- `surface.info` — first beat. `{ surface, sandboxReachable, reason, harness }`.
- `run.registered` — `{ runId, harness, surface, cmd, argv }`.
- `run.started` — synthesized by the harness normalizer. `{ sessionId, model, harness, tools }`.
- `tool.invoked` — synthesized. `{ id, name, input, stage }`. Stage ∈ `"cuopt"`, `"vision"`, `"aiq"`, `"general"`.
- `tool.completed` — synthesized. `{ id, name, stage, stdout, stderr, isError, durationMs }`.
- `assistant.text` — synthesized free-text. `{ stage, text }`.
- `log` — `{ level, text }`. Level ∈ `"warn"`, `"stderr"`, `"info"`, `"debug"`.
- `run.completed` | `run.failed` | `run.cancelled` — exactly one terminal beat per run.

The frontend derives stage transitions from `tool.invoked` / `tool.completed` — there is no separate `stage.*` event.

## cuOpt envelope

Schema documented in `skills/cuopt/contract.md`. The frontend parser lives in `app-cuopt.mjs:parseCuoptToolOutput`. Failure modes (script error, parse error, missing fields, agent skipped, harness-backgrounded) all route through `app.js:applyCuoptResult` with a single sticky `state.cuoptResolved` flag.

To extend cuOpt with new envelope fields:
1. Add the field in `run.py:envelope_from_solution`.
2. Wire it into `app-cuopt.mjs:cuoptEnvelopeToUiValues`.
3. Update the schema example in `skills/cuopt/contract.md`.
4. Add an assertion in `scripts/check.mjs` if the field is required.
