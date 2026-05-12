---
name: aiq-research
description: Run deep enterprise research using NVIDIA AIQ Blueprint for in-depth, citation-backed analysis, especially when enterprise data sources would help.
version: "2.0.0"
metadata:
  author: "Chantal D Gama Rose <cdgamarose@nvidia.com>"
  tags:
    - research
    - deep-research
    - aiq
---

# AIQ Research Skill

Use this skill to call the NVIDIA AIQ Blueprint research backend through the local helper script at `skills/aiq-research/scripts/aiq.py`.

## Purpose

This skill is for deep, citation-backed research where NVIDIA enterprise sources or long-running AIQ jobs are useful.

Use it for:
- market or competitive analysis that needs citations
- technical investigation that benefits from enterprise sources
- long-running research jobs that produce a report artifact

## Prerequisites

- Network access to NVIDIA services
- Valid NVIDIA SSO login when AIQ authentication is required
- Python 3 available in the host environment

## Escalated Permissions

Commands that invoke `aiq.py` may require escalated permissions because browser launch, HTTPS access to NVIDIA services, or credential-cache access can be blocked by the sandbox.

## Available Scripts

| Script | Purpose | Arguments |
| --- | --- | --- |
| `skills/aiq-research/scripts/aiq.py check-auth` | Validate cached auth or attempt silent refresh | none |
| `skills/aiq-research/scripts/aiq.py login` | Start browser-based device login when silent refresh is unavailable | none |
| `skills/aiq-research/scripts/aiq.py chat "<query>"` | Submit a routed chat request that may return inline output or a deep-research job ID | query |
| `skills/aiq-research/scripts/aiq.py research_poll <job_id>` | Poll an existing deep-research job until completion | job id |
| `skills/aiq-research/scripts/aiq.py status <job_id>` | Fetch job status and stored job-state artifacts | job id |
| `skills/aiq-research/scripts/aiq.py report <job_id>` | Fetch the final report for a completed job | job id |
| `skills/aiq-research/scripts/aiq.py cancel <job_id>` | Cancel a running job | job id |

## Instructions

1. Decide whether AIQ is  needed.
2. Run `check-auth` first.
3. If `check-auth` prints `need_browser_login`, run `login` in the foreground and wait for the user to complete SSO.
4. Run `chat "<query>"` for the actual request.
5. If the response contains `{"status": "deep_research_running", "job_id": "..."}`, launch `research_poll <job_id>` using the runtime's non-blocking background execution mechanism.
6. When a report is returned, present it to the user. Ask before writing the report to a new file path.

## Usage

### Authentication flow

Run:

```bash
python3 skills/aiq-research/scripts/aiq.py check-auth
```

- If it prints `ok`, continue.
- If it prints `need_browser_login`, ask the user for approval to run the login flow and then run:

```bash
python3 skills/aiq-research/scripts/aiq.py login
```

### Research flow

Run:

```bash
python3 skills/aiq-research/scripts/aiq.py chat "USER QUESTION"
```

- The `/chat` endpoint routes the request to the right AIQ path.
- For shallow queries it returns a normal JSON response inline.
- For deep research it returns structured JSON containing `{"status": "deep_research_running", "job_id": "..."}`.

If the response is normal JSON:
- Present the result immediately.
- Do not force polling when there is no `job_id`.

If the response includes `deep_research_running`:
- Extract the `job_id`.
- Launch polling with the same absolute script path:

```bash
python3 skills/aiq-research/scripts/aiq.py research_poll <job_id>
```

- Use the runtime's non-blocking/background execution mechanism when available.
- If the chosen execution method requires escalated permissions, request explicit user approval first and explain why.
- Tell the user that deep research is running in the background.

If background polling exits with an auth-related error:
1. Run `check-auth` again in the foreground.
2. If needed, run `login`.
3. Resume with `research_poll <job_id>` or use `report <job_id>` if the job already completed.

### Presenting the report

- When `research_poll` completes successfully, fetch and present the full report.
- Ask before writing the report to a new path, especially outside the workspace.
- Do not truncate citations or source URLs from the returned report.

### Handling interruptions and timeouts

If polling is interrupted, the job continues server-side. Resume with:

```bash
python3 skills/aiq-research/scripts/aiq.py status <job_id>
python3 skills/aiq-research/scripts/aiq.py report <job_id>
python3 skills/aiq-research/scripts/aiq.py research_poll <job_id>
```

- Use `status` to inspect job status and saved artifacts.
- Use `report` when the job has already finished and you only need the final output.
- Use `research_poll` to keep waiting for completion.

### Checking job progress and state

Async jobs expose two useful progress views:

- `status <job_id>` returns top-level job status and also fetches `/state` artifacts.
- `state <job_id>` returns the event-store artifacts only, without refetching the outer status wrapper.

Run:

```bash
python3 skills/aiq-research/scripts/aiq.py status <job_id>
python3 skills/aiq-research/scripts/aiq.py state <job_id>
```

Treat the responses as follows:
- If `job_status.status` is `completed` or `success`, fetch or present the report.
- If status is `failed`, `failure`, or `cancelled`, show the error and do not silently retry.
- If status is still running, queued, or another non-terminal state, continue polling.

### Failure handling

If the job status is `failed` or `failure`:
- Show the user the error from the status response.
- Ask whether they want to retry with a narrower query or different approach.
- Do not retry automatically.

### Cancelling a job

```bash
python3 skills/aiq-research/scripts/aiq.py cancel <job_id>
```

## Examples

### Example 1: auth check

```bash
python3 /sandbox/.hermes-data/skills/aiq-research/scripts/aiq.py check-auth
```

### Example 2: start research

```bash
python3 /sandbox/.hermes-data/skills/aiq-research/scripts/aiq.py chat "Compare NVIDIA AIQ with internal enterprise research workflows"
```

### Example 3: resume polling

```bash
python3 /sandbox/.hermes-data/skills/aiq-research/scripts/aiq.py research_poll 12345678-1234-1234-1234-123456789abc
```

## Security Notes

- Escalated permissions can bypass sandbox protections. State that plainly before requesting them.
- Do not delete cached credentials unless the user explicitly asks for that action.
- Ask before saving reports outside the current workspace or in a user home directory.
- `AIQ_INSECURE=1` disables TLS verification and should be used only as a last-resort debugging step with a clear user warning.
- The login flow sends host identity details required by the NVIDIA OAuth device flow.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `AIQ_SERVER_URL` | No | Override the AIQ server base URL |
| `AIQ_CACERT` | No | CA bundle path for environments that do not trust the NVIDIA internal CA by default |
| `AIQ_INSECURE` | No | If set to `1`, disables TLS verification for curl. Avoid this in normal use |

## Troubleshooting

| Error | Cause | Solution |
| --- | --- | --- |
| `need_browser_login` | Cached token missing or expired | Run `login` with user approval |
| SSL verification failure | NVIDIA CA not trusted by curl | Set `AIQ_CACERT` to the correct CA bundle path |
| Request blocked by sandbox | Command needs browser or network access outside the sandbox | Request escalated permissions and explain why |
| Job remains running | Deep research is asynchronous | Resume with `research_poll <job_id>` or inspect with `status <job_id>` |
