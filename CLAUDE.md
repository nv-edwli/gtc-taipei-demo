# Agents Guide

This file orients any coding agent (Claude Code, Codex, or another harness) working in this repo. `README.md` is the human-facing overview; this file captures what an agent needs to be productive without re-reading the whole tree.

## What this repo is

A runnable GTC Taipei demo that shows a Taiwan manufacturing supply-chain flow:

1. `cuOpt` solves a routing problem.
2. `vision-insights` (Nemotron Omni) interprets the resulting chart.
3. `aiq-research` produces a citation-backed business plan.
4. A small Node frontend lets the operator pick the agent harness (Codex or Claude) and watch the run trace stream back over NDJSON.

The frontend is dependency-free. The backend orchestrator spawns a real `claude` or `codex` CLI as a child process; both harnesses are peers and call the same packaged skills.

## Run and verify

```bash
npm start    # serves http://localhost:4173 (host 0.0.0.0)
npm test     # scripts/check.mjs — static + data-shape checks
```

`npm test` is the canonical pre-flight gate. It validates required files exist, that `data/supply-chain.json` has the expected stage labels, harness copy, and metric keys, and that the bundled sample image is present. Run it after any change to `data/supply-chain.json`, `scripts/check.mjs`, or anything in `data/`, `docs/`, `policies/`, or `server/`.

## Repo layout

- `index.html`, `styles.css`, `app.js` — single-page frontend. Uses `/api/run` (NDJSON), `/api/upload`, `/api/sandbox/status`, `/api/policy`.
- `server.mjs` — HTTP server, static file serving, upload handling, route dispatch.
- `server/orchestrator.mjs` — spawns the harness child, normalizes its event stream, manages run lifecycle and cancellation.
- `server/sandbox.mjs` — sandbox detection, prompt assembly (the system prime that lists available skill scripts), and invocation building for `openshell sandbox exec` vs host-direct.
- `server/normalize-claude.mjs`, `server/normalize-codex.mjs` — per-harness translators that turn each CLI's stream-json events into the frontend's `kind`/`data` beat format.
- `data/supply-chain.json` — scenario data, baseline/optimized metrics, harness-specific copy, stage labels, skill map.
- `data/default-prompt.txt` — default user prompt populated into the UI textarea.
- `data/sample-capacity.png` — bundled chart used when the user does not upload one.
- `docs/demo-script.md` — stage-by-stage talk track.
- `docs/integration-plan.md` — path from the current mock-friendly shell to fully live skill orchestration. Read this before changing the event contract.
- `policies/my-assistant-policy.yaml` — OpenShell sandbox policy used by the `my-assistant` sandbox that hosts the live demo. Synced automatically by the `.claude/settings.json` PostToolUse hook whenever `openshell policy set my-assistant ...` runs.
- `skills/` — packaged skills the harness calls during a run. Sub-skills follow the pattern `<skill>/SKILL.md` plus `scripts/`.
- `scripts/check.mjs` — the test gate run by `npm test`.

## The run flow (what an agent actually does)

```
Frontend POST /api/run { harness, prompt, surface, imagePath? }
  → orchestrator.mjs validates → builds invocation via sandbox.mjs
    → spawns either: openshell sandbox exec -n my-assistant -- <harness> <args>
                  or: <harness> <args>   (host fallback)
      → harness child reads system prime + user prompt from stdin
      → harness calls vision_analyze.py and aiq.py via its Bash tool
      → harness emits stream-json events on stdout
    ← orchestrator normalizes events into beats
  ← frontend renders beats into the run trace
```

The system prime is assembled in `server/sandbox.mjs:buildSystemPrime`. It tells the harness exactly which skill scripts to call and constrains AIQ to shallow mode (no deep-research polling) so the demo stays snappy.

## Surfaces (sandbox vs host)

`/api/run` accepts `surface: "auto" | "sandbox" | "host"` (default `auto`).

- **sandbox**: invokes `openshell sandbox exec -n my-assistant -- ...` and uses `/sandbox/gtc-taipei-demo/...` paths inside. Egress is restricted by `policies/my-assistant-policy.yaml`. This is the demo's preferred surface.
- **host**: invokes the harness binaries directly (`/home/nvidia/.local/bin/claude`, `/home/nvidia/.nvm/.../codex`). Used as a fallback when the sandbox is unreachable. Codex keeps its own `workspace-write` sandbox on the host; in the openshell sandbox it bypasses its inner sandbox because openshell already isolates it.
- **auto**: pings the sandbox via `checkSandbox()` and picks `sandbox` if reachable, otherwise `host`.

Uploaded images are written to `/tmp/uploads` on the host and mirrored to `/sandbox/uploads` inside the sandbox. The bundled sample sits at `/sandbox/gtc-taipei-demo/data/sample-capacity.png` in the sandbox and `/home/nvidia/gtc-taipei-demo/data/sample-capacity.png` on the host. Path resolution lives in `server/sandbox.mjs:resolveImagePath`.

## Skills the harness will call

These are exposed in the system prime. Call them directly via the harness's Bash tool — do not reinvent the prompts.

- `python3 skills/vision-insights/scripts/vision_analyze.py --preset chart --max-tokens 6000 <image-path>` — analyzes the supplied chart with Nemotron Omni; returns the final summary on stdout.
- `python3 skills/aiq-research/scripts/aiq.py check-auth` — auth probe. If it prints `need_browser_login`, stop and report; do not attempt `login` from inside the demo.
  - Auth uses NVAuth when a token is present at `$HOME/.aiq/tokens/nvauth_token` (0600) or in the `AIQ_NVAUTH_TOKEN` env var; otherwise falls back to Starfleet OAuth. NVAuth is required because the AIQ backend gates ECI / enterprise-data lookups on it. Token tokens are minted at <https://nv-auth.nvidia.com/tokens> with duration ≤ 24h (or longer for service accounts). The orchestrator syncs the host token file into `/sandbox/.aiq/tokens/` on startup; if you rotate the token, drop the new one into `~/.aiq/tokens/nvauth_token` and restart `npm start`.
- `python3 skills/aiq-research/scripts/aiq.py research "<query>" shallow_researcher` — shallow research, submits an async job and polls server-side; final report JSON is printed on stdout when the job completes (typically 20–60s). The `shallow_researcher` argument is **mandatory** — it forces the explicit-agent-type code path and sidesteps `/chat`'s auto-router (which sometimes promotes broad queries to deep research). **Never** use `aiq.py chat`, `submit`, `research_poll`, or `report` from inside a demo run, and never pass `deep_researcher` as the agent type. The orchestrator still defensively recognises a `{"status":"deep_research_running",...}` response and surfaces it as an error.

- `python3 skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` — runs the Taiwan supply-chain solve against the local cuOpt REST server at `host.openshell.internal:8002`. Prints a JSON envelope `{kind:"cuopt.result", status, selected_lanes, metrics, capacity, explanation}` on stdout. Typical runtime 2–15s. Exit codes 2 (request failed), 3 (poll timeout), 4 (solver non-success) all still print a usable envelope on stdout where they can.

The frontend parses the cuOpt envelope client-side via `parseCuoptToolOutput` in `app-cuopt.mjs`. On any failure (script exit, parse failure, infeasible solve, agent skipped) the UI silently falls back to the reference plan in `data/supply-chain.json` and surfaces a warn toast — the demo never dead-ends on cuopt. See `skills/cuopt/contract.md` for the envelope schema and the broader sub-skill bundle under `skills/cuopt/`.

## Event contract (frontend ↔ orchestrator)

The orchestrator writes NDJSON beats of the form `{ "kind": "...", "data": {...} }`. Emitted kinds:

- `surface.info` — which surface was chosen and why.
- `run.registered` — runId, harness, surface, cmd.
- `run.started` — synthesized by the harness normalizer on first `init`/`thread.started` event.
- `tool.invoked` — synthesized when the harness begins a tool call; carries `{ id, name, input, stage }`. `stage` is one of `"cuopt"`, `"vision"`, `"aiq"`, or `"general"` (the normalizer infers it from the tool input).
- `tool.completed` — synthesized when the harness returns a tool result; carries `{ id, name, stage, stdout, stderr, isError, durationMs }`.
- `assistant.text` — synthesized for any free-text assistant message.
- `log` — surfaced stderr / non-JSON lines; level ∈ `"warn"`, `"stderr"`, `"info"`, `"debug"`.
- `run.completed`, `run.failed`, `run.cancelled` — terminal beats. Exactly one is emitted per run.

Stage transitions on the frontend are derived from `tool.invoked` / `tool.completed` beats — there is no explicit `stage.*` event from the orchestrator. See `docs/integration-plan.md` for how to add a new stage.

## Editing rules of thumb

- Frontend changes: load `http://localhost:4173`, exercise a real `/api/run`, and watch the trace pane. Type-checks or unit tests do not catch UI regressions.
- Touching `data/supply-chain.json`: run `npm test` — `scripts/check.mjs` enforces stage labels, harness copy, and metric keys.
- Touching `server/sandbox.mjs` or `server/orchestrator.mjs`: exercise both `surface: "sandbox"` and `surface: "host"` end-to-end. The two paths diverge on binary location, image-path resolution, and Codex sandbox flags.
- Touching `policies/my-assistant-policy.yaml`: prefer editing through `openshell policy set my-assistant --policy policies/my-assistant-policy.yaml`. The `.claude/settings.json` PostToolUse hook syncs the file back if you set/update the live policy that way.
- New skill scripts: register them in `server/sandbox.mjs:buildSystemPrime` so the harness child actually knows they exist.

## What not to do

- Do not introduce a frontend framework or a bundler — the dependency-free constraint is intentional.
- Do not call `aiq.py chat`, `login`, `submit`, `research_poll`, `status`, or `report` from inside a demo run. Only `aiq.py research "<query>" shallow_researcher` is allowed for AIQ research calls.
- Do not commit anything that would belong in `.env` or under `node_modules/`.
- Do not change the `/api/run` NDJSON shape without updating both normalizers and the frontend reader in lockstep.
- Do not silently rename or remove cuOpt envelope fields without updating `app-cuopt.mjs:cuoptEnvelopeToUiValues` AND the smoke-test assertion list in `scripts/check.mjs`.

## Pointers

- Run-time talk track: `docs/demo-script.md`
- Integration roadmap: `docs/integration-plan.md`
- cuOpt I/O contract: `skills/cuopt/contract.md`
- Sandbox policy: `policies/my-assistant-policy.yaml`
- Default user prompt: `data/default-prompt.txt`
