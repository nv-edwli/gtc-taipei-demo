# Demo Script

## Opening State

The operator lands in a CUDA-X control surface for a Taiwan advanced manufacturing scenario. The visible state shows the selected harness, the shared packaged skill chain, the Taiwan route map, and the run trace.

## Harness Toggle

Switch between Codex and Claude before starting the run. The route, data, and skill chain remain the same, but the progress messages and synthesis copy reflect the selected harness. This reinforces that both agent environments can consume the same packaged skills.

## Stage 1: Demand Brief

The frontend loads a scenario with weekly lot demand, supplier nodes, port and air constraints, and capacity pressure. The operator sees the baseline supply-chain economics and the first route map.

## Stage 2: cuOpt Solve

The cuOpt skill receives the routing problem and returns an optimized assignment. The UI animates the Taiwan route, updates the readiness score, and swaps baseline metrics for optimized route economics.

## Stage 3: Vision Insights

The optimized plan produces a chart artifact. Vision Insights analyzes the chart with Nemotron Omni and returns a summary about capacity pressure, bottlenecks, and planning confidence.

## Stage 4: AIQ Research

AIQ Research receives the optimized supply-chain facts and visual insight summary. The final business-plan panel presents strategy, market, risk, and execution sections for a board-level planning conversation.

## Close

The conclusion is that CUDA-X libraries, packaged skills, and agent harnesses can work together as one demo flow: solve with cuOpt, interpret with Nemotron Omni, research with AIQ, and present the outcome through a polished operator UI.
