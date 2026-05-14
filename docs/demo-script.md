# Demo Script

## Pre-flight

Before pressing Run:

- Confirm the **harness toggle** state. Show Codex first (left), then re-run the same prompt with Claude (right) at the end to demonstrate parity.
- Look at the **sandbox chip** in the rail header. Green "openshell · my-assistant" means the run will execute inside the sandbox. Amber "host · sandbox bypassed" means the sandbox is unreachable — the demo still runs on the host, but call this out if asked.
- Optionally **attach a chart image** via the prompt panel. If you don't, the bundled `sample-capacity.png` is used. Vision Insights will read whichever image is attached.

## Opening state

The operator lands on a CUDA-X control surface for a Taiwan advanced manufacturing scenario. The visible state shows the selected harness, the packaged skill chips at the right, the Taiwan route map, and an empty run trace.

## Harness toggle

Codex and Claude are presented as peers. The same packaged skills, the same system prime, the same NDJSON event contract. Switching the toggle changes the child binary the orchestrator spawns and nothing else.

## Stage 1: Demand brief

The default prompt asks the agent to call cuOpt, then Vision, then AIQ. The operator can tweak it. On Run, the brief collapses to a read-only summary and the canvas auto-advances to Stage 2.

## Stage 2: cuOpt Solve

The agent invokes `taiwan_supply_chain/run.py`. cuOpt solves on the GB10 and the run.py wrapper prints a JSON envelope on stdout. The UI:

- Animates the metric bars baseline → optimized using the envelope's numbers (cost, cycle time, unassigned lots, peak pressure).
- Renders the per-node capacity chart: 5 envelope-sourced rows (Hsinchu, Taichung, Tainan, Port=Kaohsiung, Air=Taoyuan) plus mock Taipei + Buffer. The chip at the top right reads "from cuOpt".
- Animates the route on the map from the stressed baseline to the optimized lanes.
- Bumps the readiness score from 41 toward 91.
- Displays the envelope's `explanation` text under the capacity chart.

**Fallback behavior.** If cuOpt returns nothing parseable (server down, script error, infeasible solve), the same animation runs but with the bundled reference plan. The capacity chip flips to "reference plan" and a warn toast appears. **Call this out as a deliberate demo-resilience design choice rather than apologizing for it** — the live demo continues even when the GPU service is misbehaving.

## Stage 3: Vision Insights

The optimized capacity chart artifact (or the user's attached image) is sent to Nemotron Omni. The UI shows the model's "analyzing" state, then writes a one-line operator readout under the image.

## Stage 4: AIQ Research

The agent submits a shallow research request. The plan panel shows the streaming source-count, then transitions to a four-tab business plan (Strategy, Market, Risk, Execution).

## Close

CUDA-X libraries, packaged skills, and either harness can work together as one demo flow. Solve with cuOpt, interpret with Nemotron Omni, research with AIQ, present through one operator UI.

## Re-running with the other harness

Flip the toggle. Click Run with the same prompt. Same end state, different agent voice. The point: skills are portable; the harness is the user's choice.
