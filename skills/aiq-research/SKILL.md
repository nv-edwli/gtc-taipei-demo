---
name: aiq-research
description: Run shallow, citation-backed enterprise research via NVIDIA AIQ Blueprint's shallow_researcher agent. Deep research is intentionally disabled in this demo context.
version: "3.0.0"
metadata:
  author: "Chantal D Gama Rose <cdgamarose@nvidia.com>"
  audience: gtc-taipei-demo
  tags:
    - research
    - aiq
    - shallow-only
---

# AIQ Research Skill

Use this skill to run a **shallow** research query against the NVIDIA AIQ Blueprint backend through the local helper script at `skills/aiq-research/scripts/aiq.py`.

> **Important — read first.** This skill is configured for the GTC Taipei demo, which deliberately uses only the shallow research path. Do NOT call `aiq.py chat`, `aiq.py submit`, `aiq.py research_poll`, `aiq.py status`, `aiq.py state`, or `aiq.py report`. Do NOT pass `deep_researcher` as the agent type. Only `aiq.py check-auth` and `aiq.py research "<query>" shallow_researcher` are supported here.

## Purpose

A single, server-polled shallow research request that returns a final report JSON on stdout, typically in 20–60s.

Use it for:
- short citation-backed answers (market sizing, competitive context, risk surveys)
- enterprise-source enrichment where NVIDIA AIQ Blueprint adds value

Do **not** use it for:
- long-running deep research jobs (disabled)
- chat-style interactive queries (the `/chat` endpoint's auto-router may upgrade broad queries to deep research and is intentionally bypassed)

## Prerequisites

- Network access to `api.aiq.nvidia.com` (open under the openshell sandbox's `allow_api_aiq_nvidia_com_443` policy).
- A valid NVAuth token at `$HOME/.aiq/tokens/nvauth_token` (0600) OR in the `AIQ_NVAUTH_TOKEN` env var. The orchestrator syncs the host token into the sandbox on startup; you generally do not need to manage it from within an agent run.
- Python 3 available in the host environment.

## Escalated Permissions

If `check-auth` fails with `need_browser_login`, stop and ask the user to authenticate out-of-band. **Do not attempt `aiq.py login` from inside an agent run** — the browser device-flow needs interactive user attention and the demo's run loop does not wait for it.

## Available Scripts

| Script | Purpose | Arguments |
| --- | --- | --- |
| `skills/aiq-research/scripts/aiq.py check-auth` | Validate cached auth or attempt silent refresh | none |
| `skills/aiq-research/scripts/aiq.py research "<query>" shallow_researcher` | Run a shallow async research job, server-polled. Final report JSON printed on stdout. | query, agent type |

## Instructions

1. Run `check-auth` first.
2. If `check-auth` prints `need_browser_login`, stop and report. Do not attempt `login`.
3. Run `research "<query>" shallow_researcher` exactly once. The `shallow_researcher` argument is mandatory — it forces the explicit-agent-type code path and bypasses the `/chat` endpoint's auto-router.

The `research` command blocks for 20–60s while it polls server-side. That wait is expected, not a failure. When it returns, stdout contains the report JSON.

## Usage

### Authentication flow

```bash
python3 skills/aiq-research/scripts/aiq.py check-auth
```

- Prints `ok` on success — continue.
- Prints `need_browser_login` — stop, ask the user to authenticate, do not retry from inside the agent.

### Research flow

```bash
python3 skills/aiq-research/scripts/aiq.py research "USER QUESTION" shallow_researcher
```

The command exits 0 with the report JSON on stdout on success, or exits non-zero with a status dict on failure. Parse the stdout as JSON.

### Presenting the report

- Present the final report content to the user.
- Do not truncate citations or source URLs.
- Ask before writing the report to a new file path.

## Examples

### Example 1 — auth check

```bash
python3 skills/aiq-research/scripts/aiq.py check-auth
```

### Example 2 — shallow research

```bash
python3 skills/aiq-research/scripts/aiq.py research "What is the competitive landscape for premium contract manufacturing routed through Taiwan?" shallow_researcher
```

### Example 3 — error handling

If the call returns `{"status":"deep_research_running",...}`, treat it as an error and surface it to the user. This indicates the agent routed to deep research when it should not have.

## Security Notes

- Escalated permissions can bypass sandbox protections. State that plainly before requesting them.
- Do not delete cached credentials unless the user explicitly asks for that action.
- Ask before saving reports outside the current workspace or in a user home directory.
- `AIQ_INSECURE=1` disables TLS verification and should be used only as a last-resort debugging step with a clear user warning.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `AIQ_SERVER_URL` | No | Override the AIQ server base URL |
| `AIQ_NVAUTH_TOKEN` | No | NVAuth bearer token; takes precedence over the file at `~/.aiq/tokens/nvauth_token` |
| `AIQ_CACERT` | No | CA bundle path for environments that do not trust the NVIDIA internal CA by default |
| `AIQ_INSECURE` | No | If set to `1`, disables TLS verification for curl. Avoid in normal use |

## Troubleshooting

| Error | Cause | Solution |
| --- | --- | --- |
| `need_browser_login` | NVAuth token missing or expired | Ask the user to mint a token at https://nv-auth.nvidia.com/tokens and drop it at `~/.aiq/tokens/nvauth_token` (0600), then restart `npm start` |
| `deep_research_running` returned | Agent type was omitted or wrong | Re-run with the explicit `shallow_researcher` agent type |
| SSL verification failure | NVIDIA CA not trusted by curl | Set `AIQ_CACERT` to the correct CA bundle path |
| Request blocked by sandbox | Endpoint missing from policy | Update `policies/my-assistant-policy.yaml` and re-apply via `openshell policy set my-assistant ...` |
| Timeout | AIQ backend slow | Re-run; do not split into smaller queries unless the user asks |
