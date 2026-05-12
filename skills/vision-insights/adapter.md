# Vision Insights Adapter

Vision Insights should analyze charts generated from cuOpt output. For the GTC Taipei demo, the most useful artifact is a capacity utilization chart comparing baseline and optimized node pressure.

## Command

```bash
python3 ~/.claude/skills/vision-insights/scripts/vision_analyze.py \
  --preset chart \
  --max-tokens 6000 \
  ./artifacts/cuopt-capacity.png
```

## Frontend Mapping

Use the final answer as the Vision Insights summary. Keep the debug reasoning trace out of the UI.

Expected frontend fields:

```json
{
  "confidence": "high confidence",
  "summary": "Nemotron Omni flags the optimized plan as more balanced..."
}
```
