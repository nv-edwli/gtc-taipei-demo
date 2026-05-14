# cuOpt UI wiring + docs reconciliation — design

Status: approved, ready for implementation plan
Date: 2026-05-13
Author: edwli@nvidia.com (via Claude Code brainstorming)

## Goal

Fix the two P0 issues surfaced in the GTC Taipei demo audit:

- **P0-1**: The cuOpt skill runs (its envelope arrives at the orchestrator) but the UI ignores it. Optimized metric bars, the readiness score, the map animation, and the cuopt stage indicator are all dead-coded. After the run finishes, the cuopt rail pill is shown as "skipped" even on a successful solve.
- **P0-2**: Repo documentation has drifted from the running code in three ways: AGENTS.md (Codex's entry-point doc) and CLAUDE.md (Claude's) describe different AIQ flows; `skills/aiq-research/SKILL.md` actively teaches the disallowed `chat → research_poll → report` path; CLAUDE.md and `docs/integration-plan.md` both name event kinds (`stage.started`, `artifact.created`, etc.) the orchestrator never emits.

The fix lands cuOpt's envelope visibly in the UI (metrics, score, map, a new capacity chart), routes failure modes to a graceful fallback that keeps the demo running, and brings the docs into agreement with the code.

## Out of scope

- The cuOpt I/O contract in `skills/cuopt/contract.md` and the solver wrapper in `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` — both stay as-is.
- The `policies/my-assistant-policy.yaml` sandbox policy and the `.claude/settings.json` PostToolUse hook.
- The NDJSON event-contract shape between orchestrator and client — no new event kinds added; we route everything through existing `tool.invoked` / `tool.completed` / `assistant.text` beats.
- Other audit findings (P1/P2/P3) — concurrent-run limit, 204-response bug, image-path validator tightening, etc.

---

## P0-1: cuOpt UI wiring

### Data flow

```
agent invokes taiwan_supply_chain/run.py
  → harness emits tool_use / item.started   (normalizer tags stage="cuopt")
  → orchestrator writes tool.invoked beat
    → app.js handleToolInvoked: setStageSubstate("cuopt","calling"),
      map shimmer, "Solving…" eyebrow, metric skeleton

cuOpt server returns; run.py prints JSON envelope on stdout
  → harness emits tool_result / item.completed
  → normalizer tags stage="cuopt"
  → orchestrator writes tool.completed beat (carries stdout)
    → app.js handleToolCompleted:
        result = parseCuoptToolOutput(stdout, isError)
        applyCuoptResult(result)
          → ui = (envelope ? cuoptEnvelopeToUiValues : mockToUiValues)
          → animateMetricBars(baseline, ui.metricRows)
          → renderCapacityChart(ui.capacityRows)
          → applyMapRoute("reveal-active") + "fade-baseline" + "reveal-supports"
          → animateScore(current, targetScore)
          → setStageSubstate("cuopt","done")
          → if fallback or infeasible: showToast(...) + addConsoleEntry(...)
```

Envelope parsing happens client-side, following the existing `parseAiqToolOutput` pattern. The normalizers stay responsible only for stage-tagging; no schema validation server-side.

### Normalizer change

Both `server/normalize-claude.mjs` and `server/normalize-codex.mjs` get a new top entry in `STAGE_HINTS`:

```js
const STAGE_HINTS = {
  cuopt: ["taiwan_supply_chain", "run.py", "cuopt.result", "/cuopt/request", "/cuopt/solution"],
  vision: ["vision_analyze.py", "Vision Insights", "Nemotron Omni"],
  aiq:    ["aiq.py", "AIQ Research", "deep_research_running", "research_poll"]
};
```

Order matters: `cuopt` checked first so the unambiguous `taiwan_supply_chain` token always wins over the generic `run.py`. The hint set covers both the tool-input phase (command-line includes the script path) and tool-output phase (stdout begins with `"kind": "cuopt.result"`).

### Client-side parsing

New function in `app.js`:

```js
function parseCuoptToolOutput(stdout, isError) {
  // Returns one of:
  //   { status: "solved",      envelope }    — clean success
  //   { status: "infeasible",  envelope }    — partial-solution result
  //   { status: "fallback",    reason }      — anything else
  // Reasons: "script_error" | "parse_failed" | "bad_shape" | "not_invoked"
}
```

Logic:

1. `trimmed = stdout.trim()`. Empty + `isError` → `{status:"fallback", reason:"script_error"}`. Empty + no error → `{status:"fallback", reason:"parse_failed"}`.
2. `JSON.parse(trimmed)`. On throw → `{status:"fallback", reason:"parse_failed"}`.
3. Validate shape: must have `kind === "cuopt.result"` and `metrics` object. Otherwise `{status:"fallback", reason:"bad_shape"}`.
4. Branch on `envelope.status`: `"solved"` → success; `"infeasible"` → infeasible (envelope still has partial data); anything else → `{status:"fallback", reason:"bad_shape"}`.
5. Even on `isError === true`, if the envelope parses cleanly, route through its `status` — the run.py wrapper exits non-zero with a valid envelope on the infeasible path.

### Envelope → UI transformation

```js
function cuoptEnvelopeToUiValues(envelope, data) {
  // data = state.data (provides metrics.baseline, metrics.optimized,
  //                    capacity.baseline, capacity.optimized)
  // → { metricRows, capacityRows, score, explanation, status }
}
```

**metricRows** (4 entries, 1:1 with the existing `metrics.baseline` keys):

| Envelope field | UI display | Bar value (0-100) | Delta |
|---|---|---|---|
| `metrics.weekly_logistics_cost_usd` | `"$X.YM"` (divide by 1_000_000, one decimal) | `clamp(round(cost / parseCostDisplay(mockBaseline[0].display) * 100), 0, 100)` | `"−$X.YM"` against baseline |
| `metrics.mean_cycle_days` | `"X.Y days"` | `round(days * 10)` | `"−Z.W days"` |
| `metrics.unassigned_priority_lots` | `"N lots"` | `min(N, 100)` | `"−M lots"` |
| `metrics.peak_capacity_pressure` | `"NN%"` (round to integer) | same | `"−NN pp"` |

`parseCostDisplay(s)` is a small helper that pulls the dollar-amount-in-millions out of a string like `"$7.2M"`: `parseFloat(s.match(/\$([\d.]+)M/)?.[1]) * 1_000_000`. Returns `null` if the format doesn't match; callers fall back to mock.

**Per-key partial-envelope handling.** If an individual envelope key is missing or NaN, that row alone uses the mock optimized value; the row's `data-source` attribute is set to `"mock"` so the styling can show a subtle pip distinguishing real from fallback values. Keys present and numeric use envelope data. This is a stricter rule than treating the whole envelope as fallback, because run.py might evolve to drop a heuristic field, and we don't want a single drop to nuke the entire metric panel.

**capacityRows** (7 entries; the cuopt envelope covers 5 nodes, mock supplies the rest):

| Mock row label | Source | Notes |
|---|---|---|
| Taipei | mock `capacity.optimized[0]` | Envelope skips taipei (command center). |
| Hsinchu | `envelope.capacity` where `node === "hsinchu"` | `round(utilization * 100)` |
| Taichung | `envelope.capacity[node === "taichung"]` | |
| Tainan | `envelope.capacity[node === "tainan"]` | |
| Port | `envelope.capacity[node === "kaohsiung"]` | alias map: `kaohsiung → "Port"` |
| Air | `envelope.capacity[node === "taoyuan"]` | alias map: `taoyuan → "Air"` |
| Buffer | mock `capacity.optimized[6]` | Envelope doesn't cover buffer. |

A `CUOPT_TO_UI_NODE` const near the function holds the alias map. Each capacity row carries `baseline` alongside the optimized `value` so the chart can render the diff overlay.

**score**: returned by `cuoptEnvelopeToUiValues` is a fixed target tied to the result quality, not a derivation — computed in `applyCuoptResult` from the `CUOPT_SCORE_PENALTY` table (`solved: 0`, `infeasible: 15`, `fallback: 20`) subtracted from `state.optimizedScore` (91). Rationale captured in §"Score derivation rationale" below.

**explanation**: `envelope.explanation || ""`. Used to populate the new `#capacity-explanation` element.

**status**: passed through so `applyCuoptResult` can pick the right chip / toast.

`mockToUiValues(data)` is the fallback transformer with the matching signature. It produces the same shape from `data.metrics.optimized` and `data.capacity.optimized`. No envelope, no explanation, status `"fallback"`.

### Score derivation rationale

Considered formulas:

- `100 * (1 - peak_capacity_pressure)` → for peak=0.71 gives 29. Doesn't reach the demo's celebratory 91 number.
- `100 - peak*30 - (unassigned/180)*40` → arbitrary weights; debatable.
- Fixed target tied to envelope status — chosen.

The readiness score is a UI-level narrative number representing "operational readiness after optimization," not a single solver-derived metric. Tying it to envelope status (solved/infeasible/fallback) makes the visual story clear without inventing a fake formula that could be challenged by an audience member.

### Beat handlers in `app.js`

**`handleToolInvoked`** — add a branch above the existing vision/aiq branches:

```js
if (stage === "cuopt") {
  setStageSubstate("cuopt", "calling");
  els.metricsEyebrow.textContent = "Solving…";
  applyMapRoute("shimmer");
  setMapStatus("solving");
  renderMetricsSkeleton();
  renderCapacitySkeleton();
}
```

**`handleToolCompleted`** — add a branch after `updateToolEntry` and the skill-completion tracking, before the existing vision/aiq branches:

```js
if (stage === "cuopt") {
  if (state.cuoptResolved) return;          // double-fire guard
  // Background-mode preamble guard (Layer 2, mirrors vision)
  const cleaned = (stdout || "").trim();
  const bgMatch = cleaned.match(/Command running in background with ID:\s*([\w-]+)/i);
  if (bgMatch && !isError) {
    state.cuoptBackgroundBashId = bgMatch[1];
    setStageSubstate("cuopt", "streaming");
    addConsoleEntry("cuopt", `cuopt backgrounded by harness (bash id ${bgMatch[1].slice(0,8)}). Waiting…`);
    return;
  }
  const result = parseCuoptToolOutput(stdout, isError);
  applyCuoptResult(result);
  return;
}

// Layer 3: a cuopt call sat in the background. Watch later tool results.
if (state.cuoptBackgroundBashId && !isError && stage !== "cuopt"
    && looksLikeCuoptResult(stdout)) {
  const result = parseCuoptToolOutput(stdout, false);
  applyCuoptResult(result);
  state.cuoptBackgroundBashId = null;
  addConsoleEntry("cuopt", "Captured backgrounded cuopt output.");
}
```

`state.cuoptResolved` is set inside `applyCuoptResult` (see below), not at each caller. This keeps callers DRY and guarantees we can't forget to set it on one path.

**`applyCuoptResult(result)`** — single commit-point. Idempotent via the `cuoptResolved` flag:

```js
const CUOPT_SCORE_PENALTY = { solved: 0, infeasible: 15, fallback: 20 };

function applyCuoptResult(result) {
  if (state.cuoptResolved) return;           // idempotency
  state.cuoptResolved = true;

  const ui = result.status === "fallback"
    ? mockToUiValues(state.data)
    : cuoptEnvelopeToUiValues(result.envelope, state.data);

  animateMetricBars(state.data.metrics.baseline, ui.metricRows);
  renderCapacityChart(ui.capacityRows, ui.status, ui.explanation);

  setMapStatus(result.status === "infeasible" ? "solving" : "solved");
  applyMapRoute("reveal-active");
  applyMapRoute("fade-baseline");
  setTimeout(() => applyMapRoute("reveal-supports"), 200);

  const penalty = CUOPT_SCORE_PENALTY[result.status] ?? CUOPT_SCORE_PENALTY.fallback;
  const targetScore = state.optimizedScore - penalty;
  animateScore(state.currentScore, Math.max(state.currentScore, targetScore), 1400);

  setStageSubstate("cuopt", "done");
  els.metricsEyebrow.textContent = "Optimized";

  if (result.status === "fallback") {
    showToast("warn", `cuOpt returned no usable data (${result.reason}) — showing reference plan.`);
    addConsoleEntry("cuopt", `cuOpt fallback (${result.reason}). Reference plan shown.`);
  } else if (result.status === "infeasible") {
    showToast("warn", "cuOpt returned a best-effort infeasible solution.");
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "infeasible"}`);
  } else {
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "solved"}`);
  }
}
```

`mockToUiValues(data)` and `cuoptEnvelopeToUiValues(envelope, data)` both take `state.data` and pluck `metrics.baseline`, `metrics.optimized`, `capacity.baseline`, `capacity.optimized` internally — simpler call sites, single argument to keep in sync.

### Removing the dead "leave cuopt idle" branch

`app.js:1159-1161` currently contains:

```js
} else if (state.stageState.cuopt === "idle" && stage === "general") {
  /* leave cuopt idle for skipping later */
}
```

This branch goes away.

The end-of-run "mark idle stages as skipped" loop in `finishRun` (app.js:1821-1823) stays — it still correctly handles the case where vision is skipped because no image was attached.

### Implicit cuopt fallback on never-called

Edge case: the agent ignores the prompt and goes straight to vision/AIQ without invoking `run.py`. Add a guard in `setStageSubstate`:

```js
function setStageSubstate(stage, substate) {
  if ((stage === "vision" || stage === "aiq") &&
      (substate === "calling" || substate === "streaming") &&
      state.stageState.cuopt === "idle" &&
      !state.cuoptResolved) {
    applyCuoptResult({ status: "fallback", reason: "not_invoked" });
    // applyCuoptResult sets cuoptResolved itself; no double-set here.
  }
  // ... existing body
}
```

This catches both the never-called case and the case where the agent reorders the calls. Once `cuoptResolved` is true, subsequent vision/aiq transitions are pass-through.

### State additions

In `state` (app.js:6-52):

```js
cuoptResolved: false,        // sticky; true after applyCuoptResult runs once
cuoptBackgroundBashId: null, // set when harness backgrounds the cuopt call
```

In `applyRunIdleSlate` (app.js:996-1020) — reset both alongside the other run-state resets:

```js
state.cuoptResolved = false;
state.cuoptBackgroundBashId = null;
```

In `applyIdleState` (full reset on Reset Run) — same two resets.

### New animation helper: `animateMetricBars`

Current `renderMetrics(phase)` does `innerHTML = ...` which destroys any in-progress width tween. Replace with:

```js
function animateMetricBars(fromRows, toRows) {
  // Ensures DOM has 4 .metric-row elements (renders skeleton if needed).
  // For each row, tweens the .bar-fill width from fromRows[i].value to toRows[i].value
  // over 900ms with easeOutCubic. After tween: swap display string + delta chip.
}
function renderMetricsSkeleton() {
  // 4 empty rows with pulsing bar-fills; eyebrow = "Solving…"
}
```

The existing `renderMetrics(phase)` is kept for the idle/reset path (baseline) but the optimized path is now driven through `animateMetricBars`.

### Map animation timing

`applyMapRoute` actions are append-only CSS classes. Safe to call repeatedly. The supporting routes (feeder, port) should reveal *after* the active-route reveal animation lands. Chain with `setTimeout(..., 200)`. No new event listeners needed.

### Capacity chart (new UI panel)

HTML (added to `index.html` inside `<div id="canvas-cuopt">`, after the metric-panel):

```html
<article class="panel capacity-panel" aria-labelledby="capacity-title">
  <div class="panel-heading">
    <div>
      <span class="eyebrow" id="capacity-eyebrow">Per-node utilization</span>
      <h2 id="capacity-title">Capacity pressure</h2>
    </div>
    <span class="confidence-chip is-quiet" id="capacity-source">reference plan</span>
  </div>
  <div class="capacity-bars" id="capacity-bars" role="list"></div>
  <p class="capacity-explanation" id="capacity-explanation" hidden></p>
</article>
```

`#capacity-source` chip states:

- `is-quiet` "reference plan" — fallback path
- `is-analyzing` "from cuOpt" — solved path
- `is-warn` "cuOpt partial" — infeasible path

`#capacity-explanation` shows `envelope.explanation` when present; hidden on fallback.

`renderCapacityChart(rows, status, explanation)` renders one horizontal-bar row per node:

```
Taipei      ████████░░░░░░░░░░░░ 52%   (was 56%)
Hsinchu     ████████████████░░░░ 82%   (was 93%)  -11
...
```

Each row is two overlaid bars (translucent baseline + gradient optimized) plus a numeric label and a colored delta. CSS adds ~50 lines to `styles.css` for `.capacity-panel`, `.capacity-bars`, `.capacity-row`, `.capacity-track`, `.capacity-fill-baseline`, `.capacity-fill-optimized`, `.capacity-delta`.

`renderCapacitySkeleton()` shows 7 pulsing empty rows during `cuopt:calling`.

### Failure modes — complete table

| Trigger | Detection | UI behavior |
|---|---|---|
| Clean solve | `isError=false`, JSON parses, `kind==="cuopt.result"`, `status==="solved"` | metrics + capacity + score animate from envelope; chip "from cuOpt"; explanation shown |
| Infeasible solve | same but `status==="infeasible"` | same path but chip "cuOpt partial"; toast warns; score animates to `optimized − 15` |
| Script exit 2/3/4 with valid envelope | `isError=true` but envelope present | route through `solved`/`infeasible` per envelope status; don't double-toast |
| Script exit non-zero, no envelope | `isError=true`, stdout empty/unparseable | fallback reason `"script_error"`; toast; metrics → mock optimized; score → `optimized − 20` |
| Stdout valid JSON, wrong shape | parse OK, missing `kind` or `metrics` | fallback reason `"bad_shape"` |
| Stdout non-JSON garbage | `JSON.parse` throws | fallback reason `"parse_failed"` |
| Stdout truncated mid-envelope | `JSON.parse` throws | fallback reason `"parse_failed"` |
| Agent never invokes cuopt | `state.stageState.cuopt === "idle"` when vision or aiq fires | implicit fallback via `setStageSubstate` guard; reason `"not_invoked"` |
| Agent invokes cuopt twice | `state.cuoptResolved === true` | second `tool.completed` is logged-only; no re-animation |
| Harness backgrounds cuopt | first `tool.completed` has `"Command running in background with ID:"` preamble | stash `cuoptBackgroundBashId`, wait for later tool.completed whose stdout passes `looksLikeCuoptResult` |

### `looksLikeCuoptResult` heuristic

```js
function looksLikeCuoptResult(text) {
  if (!text || text.length < 40) return false;
  const head = text.slice(0, 400);
  if (/"kind"\s*:\s*"cuopt\.result"/.test(head)) return true;
  if (/"selected_lanes"\s*:/.test(head) && /"objective_value"\s*:/.test(head)) return true;
  return false;
}
```

Mirrors `looksLikeVisionResult`. Two markers because the first is robust but if the agent pipes through `jq` or similar the quoting could vary.

### Race conditions

**cuopt completes after vision started**: cuopt is `streaming` (background) or `calling` (foreground) when vision fires. The `setStageSubstate` guard checks `cuopt === "idle"`, so it doesn't trigger the implicit fallback. When cuopt eventually completes, `applyCuoptResult` runs normally. The only collision concern is the score: if vision already animated it up via `finalizeVisionDone`, cuopt shouldn't drag it back down. Guarded:

```js
animateScore(state.currentScore, Math.max(state.currentScore, targetScore), 1400);
```

**User re-runs while cuopt is streaming**: `applyRunIdleSlate` already resets `state.stageState.cuopt = "idle"`. Add `state.cuoptResolved = false` and `state.cuoptBackgroundBashId = null` to the reset list.

**Client disconnects mid-cuopt**: handled by the existing orchestrator `res.on("close")` SIGTERM. No design change.

### State machine for the cuopt stage

```
idle ──[tool.invoked cuopt]──> calling ──[tool.completed cuopt OK]──> done
  │                              │
  │                              └─[tool.completed cuopt preamble]──> streaming ──[later tool.completed matches]──> done
  │                                                                       │
  └─[vision/aiq tool.invoked fires first]──> done (via implicit fallback) │
                                                                          └─[no further match before run end]──> done (forced via run.completed → applyCuoptResult fallback)
```

Edge: a `run.completed` while cuopt is `streaming` with no captured result. Add to `finishRun`:

```js
if (!state.cuoptResolved) {
  applyCuoptResult({
    status: "fallback",
    reason: state.cuoptBackgroundBashId ? "background_timeout" : "not_invoked"
  });
  // applyCuoptResult sets cuoptResolved itself.
}
```

This guarantees cuopt always ends in `done` (via the fallback path), never `skipped`, after a real run.

Reason codes summary (used in toast text + the run trace, so worth a fixed vocabulary):

- `script_error` — the `taiwan_supply_chain/run.py` process exited non-zero with no parseable stdout envelope.
- `parse_failed` — stdout couldn't be JSON-parsed (truncated, garbage, or missing).
- `bad_shape` — JSON parsed but the envelope is missing `kind` / `metrics`, or carries an unknown `status`.
- `not_invoked` — the agent never called the script before vision/aiq fired (caught by `setStageSubstate` guard).
- `background_timeout` — the agent backgrounded the call (Layer 2 preamble) but the result never showed up before `run.completed` (caught by `finishRun` safety-net).

### What stays in `data/supply-chain.json`

`metrics.baseline`, `metrics.optimized`, `capacity.baseline`, `capacity.optimized` all stay. New roles:

- `baseline.*` — initial idle state (unchanged).
- `optimized.*` — fallback target when the envelope is missing or malformed; supplies Taipei + Buffer rows on solved-path capacity chart.

Inline comment added near `metrics.optimized`: "Used as fallback when cuOpt envelope is missing/malformed. Keep numerically aligned with `run.py`'s heuristic outputs to avoid visual jitter between live and fallback paths."

---

## P0-2: Docs reconciliation

### Files in scope

| File | Action |
|---|---|
| `CLAUDE.md` | Fix event-kinds list. Add cuOpt fallback rule. Add new client-side cuopt parsing pattern. |
| `AGENTS.md` | Replace with byte-identical copy of CLAUDE.md. |
| `scripts/check.mjs` | Add byte-equality gate (CLAUDE.md ↔ AGENTS.md). Add system-prime smoke test. |
| `skills/aiq-research/SKILL.md` | Rewrite to the demo-correct `research "<q>" shallow_researcher` flow only. |
| `README.md` | Update intro + "Run" + "Intended Live Flow". |
| `docs/integration-plan.md` | Rewrite. |
| `docs/demo-script.md` | Light edit. |
| `data/default-prompt.txt` | Already updated in working tree; leave for user to commit. |

### Doc-equality gate

In `scripts/check.mjs`:

```js
const claudeMd = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");
const agentsMd = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
if (normalize(claudeMd) !== normalize(agentsMd)) {
  throw new Error("AGENTS.md and CLAUDE.md have diverged. They must be identical.");
}
```

Normalization handles CRLF↔LF, trailing whitespace, and trailing newline differences. Anything else is a real drift.

### System-prime smoke test

Also in `scripts/check.mjs`, after the data-shape checks:

```js
import { buildInvocation } from "../server/sandbox.mjs";
const inv = buildInvocation({
  harness: "claude",
  prompt: "smoke test",
  imagePath: "/data/sample-capacity.png",
  surface: "sandbox"
});
const prime = inv.stdin;
const required = [
  "taiwan_supply_chain/run.py",
  "shallow_researcher",
  "## Strategy",
  "## Market",
  "## Risk",
  "## Execution",
  "cuopt.result"
];
for (const tok of required) {
  if (!prime.includes(tok)) throw new Error(`System prime missing required token: ${tok}`);
}
```

This catches typos in `buildSystemPrime` (e.g. dropping `shallow_researcher`) that would silently break the demo.

### CLAUDE.md changes

1. Replace the event-contract section's "Notable kinds" list with the actually-emitted kinds: `surface.info`, `run.registered`, `run.started`, `tool.invoked`, `tool.completed`, `assistant.text`, `log`, `run.completed`, `run.failed`, `run.cancelled`. Remove `stage.started`, `stage.progress`, `artifact.created`, `stage.completed`.
2. Remove the line "`docs/integration-plan.md` documents the longer-term event types (`stage.*`, `run.*`) that the UI is designed around. Preserve those names when extending." Replace with a one-liner pointing to `docs/integration-plan.md` for extension guidance.
3. Add to "Skills the harness will call" a paragraph documenting the cuOpt skill is live: "`python3 skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py` — runs the Taiwan supply-chain solve against the local cuOpt REST server (host.openshell.internal:8002). Prints a JSON envelope `{kind:"cuopt.result", status, selected_lanes, metrics, capacity, explanation}` on stdout. The frontend parses this client-side via `parseCuoptToolOutput`. On any failure (script exit, parse failure, infeasible solve, agent skipped) the UI silently falls back to the reference plan in `data/supply-chain.json` and surfaces a warn toast."
4. Add to "What not to do": "Do not silently rename or remove cuOpt's stdout envelope fields without updating `app.js:cuoptEnvelopeToUiValues` and the smoke test in `scripts/check.mjs`."

### AGENTS.md

After CLAUDE.md is corrected, copy its full content verbatim to AGENTS.md. From this point on, the equality gate in `scripts/check.mjs` keeps them aligned.

### `skills/aiq-research/SKILL.md` rewrite

Frontmatter unchanged except `version: "3.0.0"` and an `audience: gtc-taipei-demo` tag.

Section list of the rewritten file (in order):

1. `# AIQ Research Skill` heading + one-paragraph purpose. Drops the deep-research entry point reference.
2. `## Purpose` — abridged; explicitly states "shallow research only in this context; deep research is disabled."
3. `## Prerequisites` — unchanged.
4. `## Escalated Permissions` — abridged (drops chat-specific permissions text).
5. `## Available Scripts` — table reduced to two rows: `check-auth` and `research "<query>" shallow_researcher`.
6. `## Instructions` — three bullets: (a) call `check-auth`; (b) if `need_browser_login`, stop and ask the user to authenticate out-of-band — do not try `login` from inside an agent run; (c) call `research "<query>" shallow_researcher` exactly once.
7. `## Usage` — auth flow + research flow; no `chat`, no polling, no `report`.
8. `## Examples` — three examples updated.
9. `## Security Notes` — unchanged.
10. `## Environment Variables` — unchanged.
11. `## Troubleshooting` — `need_browser_login`, SSL, sandbox-blocked, timeout.

Sections dropped: "Handling interruptions and timeouts", "Checking job progress and state", deep-research "Failure handling", "Cancelling a job", deep-research examples.

The "Do NOT call `deep_researcher`" rule is moved to the top of `## Purpose` so the agent encounters it before reading anything else.

### README.md

Three edits:

1. Replace paragraph 3 ("The current implementation is a runnable UI with mock skill adapters and realistic integration contracts…") with: "The demo runs real cuOpt, Vision Insights, and AIQ Research skill calls through a selectable Codex or Claude harness. If cuOpt is unreachable the UI falls back to a bundled reference plan so the demo never dead-ends. Vision and AIQ are always live."
2. In "Run", add: "First start verifies sandbox reachability and syncs the bundled sample image. AIQ auth tokens live in `~/.aiq/tokens/` and are synced into the sandbox automatically."
3. Rename "Intended Live Flow" → "Live Flow" and add one bullet mentioning the cuopt-fallback path.
4. Update the repo-layout entry for `skills/cuopt/contract.md` to mention the live solver wrapper at `skills/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py`.

### `docs/integration-plan.md` rewrite

The doc's original purpose (mocks → live) is mostly accomplished. New purpose: "How the live flow is wired and how to extend it."

Sections after rewrite:

1. `# Integration` (rename from "Integration Plan").
2. `## Current State` — paragraph: which skills are live, the surface auto/sandbox/host fallback, where the system prime is assembled.
3. `## Adding a new skill` — checklist: register in `buildSystemPrime`, add a `STAGE_HINTS` entry to both normalizers if you want a dedicated stage, add a parser in `app.js` if the stdout has structure, add a smoke-test assertion.
4. `## Event contract` — the actual NDJSON beat reference (mirrors corrected CLAUDE.md).
5. `## cuOpt envelope` — pointer to `skills/cuopt/contract.md` and a note on the `parseCuoptToolOutput` client-side parser.

Drop: the aspirational `stage.*` event names, the "intended" framing throughout.

### `docs/demo-script.md` light edit

1. Add "Pre-flight" section before "Opening State": confirm harness toggle, verify sandbox chip is green, optionally attach a chart image.
2. Expand "Stage 2: cuOpt Solve": mention the new capacity chart, the `explanation` caption, and the fallback path: "If the cuOpt server is unreachable, the capacity chart marks itself 'reference plan' and continues — call this out as deliberate demo-resilience rather than apologizing."
3. New trailing subsection "Re-running with the other harness": suggests re-running the same prompt with the other harness to demonstrate parity.

---

## Testing additions (consolidated)

`scripts/check.mjs` gains:

1. Doc-equality gate (CLAUDE.md ↔ AGENTS.md after normalization).
2. System-prime smoke test (assert required tokens in assembled stdin).
3. Optional: an inline check that the cuopt skill chip in `data.skills` has `match` patterns covering the new stage hints (`run.py`, `taiwan_supply_chain`, `cuopt.result`).

`npm test` remains the canonical pre-flight gate.

No new unit-test framework introduced. The existing pattern of a single check script is preserved.

## Implementation sequence

Suggested order for the implementation plan:

1. Add the `cuopt` hint to both normalizers. (Smallest blast radius; lets you eyeball stage tagging via the run trace.)
2. Add `parseCuoptToolOutput`, `cuoptEnvelopeToUiValues`, `mockToUiValues`, `looksLikeCuoptResult` to `app.js`. Stub `applyCuoptResult` to log only — verify parsing works on real envelopes.
3. Implement `animateMetricBars` + `renderMetricsSkeleton` and switch `applyCuoptResult` to drive them. Confirm metric bars animate baseline → optimized on a real run.
4. Add the capacity chart HTML, CSS, and `renderCapacityChart` / `renderCapacitySkeleton`.
5. Wire map animation triggers in `applyCuoptResult`. Tune the 200ms delay for reveal-supports.
6. Wire the score animation with the `Math.max` guard.
7. Remove the dead "leave cuopt idle for skipping later" branch. Add the `cuoptResolved` and `cuoptBackgroundBashId` state. Wire the `setStageSubstate` implicit-fallback guard. Add the `finishRun` safety-net for `cuoptResolved === false`.
8. Add the background-mode preamble handler (Layer 2 + Layer 3).
9. Doc reconciliation: fix CLAUDE.md, copy → AGENTS.md, rewrite SKILL.md, edit README/integration-plan/demo-script.
10. Add the `scripts/check.mjs` gates (doc equality + system-prime smoke test).
11. Final `npm test` and a real end-to-end run on both harnesses, both surfaces.

## What success looks like

- Run the demo. Watch the cuopt stage pill move from idle → calling → done. Watch the metric bars sweep from baseline to optimized values that match the envelope's printed numbers. Watch the capacity chart populate with envelope data. Watch the map routes animate. Watch the score climb to 91.
- Kill the cuopt server, re-run. Watch the same animation flow, but the capacity chip shows "reference plan", a toast appears, and the score climbs to 71. Vision and AIQ still run.
- Replace `taiwan_supply_chain/run.py` with `exit(1)`. Re-run. Same fallback path. Toast warns. Demo continues.
- Run with `surface=host` if the sandbox is unreachable. Same behavior.
- `npm test` passes. Any future doc drift between CLAUDE.md and AGENTS.md fails the test. Any future typo in `buildSystemPrime` fails the test.
