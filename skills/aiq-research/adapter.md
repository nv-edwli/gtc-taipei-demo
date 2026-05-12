# AIQ Research Adapter

The existing AIQ Research skill should be called after cuOpt and Vision Insights finish.

## Prompt Shape

```text
Create an in-depth business plan for an advanced manufacturing supply-chain route through Taiwan.

Use these optimization facts:
- Weekly logistics cost changed from $7.2M to $5.6M.
- Mean route cycle changed from 6.4 days to 4.3 days.
- Unassigned priority lots changed from 31 to 4.
- Peak capacity pressure changed from 88% to 71%.

Use this visual insight:
<Vision Insights final answer>

Cover:
- strategic positioning
- competitive landscape
- feasibility
- operational risks
- execution plan
- partner motions for NVIDIA, Codex, Claude, and CUDA-X skills

Return a citation-backed report with source URLs.
```

## Runtime Notes

Run `check-auth` before starting the research job. If the response includes a deep-research job ID, stream job progress to the frontend and fetch the final report on completion.
