import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const OPENSHELL_BIN = "/home/nvidia/.local/bin/openshell";
const SANDBOX_NAME = "my-assistant";
const HOST_CLAUDE = "/home/nvidia/.local/bin/claude";
const HOST_CODEX = "/home/nvidia/.nvm/versions/node/v22.22.2/bin/codex";

const SANDBOX_SKILLS_DIR = "/sandbox/gtc-taipei-demo/skills";
const HOST_SKILLS_DIR = "/home/nvidia/gtc-taipei-demo/skills";
const SANDBOX_UPLOAD_DIR = "/sandbox/uploads";
const HOST_UPLOAD_DIR = "/tmp/uploads";
const SANDBOX_SAMPLE_PATH = "/sandbox/gtc-taipei-demo/data/sample-capacity.png";
const HOST_SAMPLE_PATH = "/home/nvidia/gtc-taipei-demo/data/sample-capacity.png";

export function uploadToSandbox(localPath, sandboxDest, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!existsSync(OPENSHELL_BIN) || !existsSync(localPath)) {
      resolve({ ok: false, reason: "missing binary or source file" });
      return;
    }
    const child = spawn(OPENSHELL_BIN, [
      "sandbox", "upload", "--no-git-ignore", SANDBOX_NAME, localPath, sandboxDest
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, reason: `upload timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "spawn error: " + err.message });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: `exit ${code}: ${stderr.trim().slice(0, 240)}` });
    });
  });
}

export async function syncSampleImage() {
  return uploadToSandbox(HOST_SAMPLE_PATH, "/sandbox/gtc-taipei-demo/data/");
}

export async function syncUploadedImage(hostPath) {
  return uploadToSandbox(hostPath, SANDBOX_UPLOAD_DIR + "/");
}

// Sync the NVAuth bearer token from the host's `~/.aiq/tokens/nvauth_token`
// to the sandbox's `/sandbox/.aiq/tokens/nvauth_token`. Idempotent — safe to
// run on every server startup. If the host file is missing we silently skip;
// the token may still be present in the sandbox from an earlier sync, or the
// agent may be relying on Starfleet auth.
//
// IMPORTANT: the token itself never appears in this repo or in environment
// variables we control. It lives only in the 0600 file on disk.
export async function syncNvauthToken() {
  const HOST_NVAUTH = process.env.HOME
    ? `${process.env.HOME}/.aiq/tokens/nvauth_token`
    : "/home/nvidia/.aiq/tokens/nvauth_token";
  if (!existsSync(HOST_NVAUTH)) {
    return { ok: false, reason: "no host NVAuth token at " + HOST_NVAUTH };
  }
  return uploadToSandbox(HOST_NVAUTH, "/sandbox/.aiq/tokens/");
}

export function checkSandbox(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!existsSync(OPENSHELL_BIN)) {
      resolve({ reachable: false, reason: "openshell binary not found at " + OPENSHELL_BIN });
      return;
    }
    const child = spawn(OPENSHELL_BIN, [
      "sandbox", "exec", "-n", SANDBOX_NAME, "--", "/bin/true"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ reachable: false, reason: `sandbox health check timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ reachable: false, reason: "spawn error: " + err.message });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ reachable: true });
      } else {
        resolve({ reachable: false, reason: `exit ${code}: ${stderr.trim().slice(0, 240)}` });
      }
    });
  });
}

function resolveImagePath(hostImagePath, surface) {
  if (!hostImagePath) return null;
  if (hostImagePath === HOST_SAMPLE_PATH || hostImagePath.endsWith("/data/sample-capacity.png")) {
    return surface === "sandbox" ? SANDBOX_SAMPLE_PATH : HOST_SAMPLE_PATH;
  }
  if (hostImagePath.startsWith(HOST_UPLOAD_DIR)) {
    const filename = hostImagePath.slice(HOST_UPLOAD_DIR.length);
    return surface === "sandbox" ? SANDBOX_UPLOAD_DIR + filename : HOST_UPLOAD_DIR + filename;
  }
  return hostImagePath;
}

function buildSystemPrime({ skillsDir, imagePath, harness }) {
  const lines = [
    "You are the orchestrator for an NVIDIA GTC Taipei demo about CUDA-X skills.",
    "",
    "Available skill scripts (call them directly via the Bash tool):",
    `  - cuOpt Routing:  python3 ${skillsDir}/cuopt/cuopt-server-api-python/assets/taiwan_supply_chain/run.py`,
    `    (Solves the Taiwan manufacturing supply-chain routing problem via the cuOpt REST server at`,
    `     host.openshell.internal:8002 — runs on the GB10 GPU on the host. Prints a single JSON envelope`,
    `     on stdout with shape {kind:"cuopt.result", status, objective_value, selected_lanes[], metrics{},`,
    `     capacity[], explanation}. No arguments; the scenario is encoded in the script. Typical runtime: 2-15s.)`,
    `  - Vision Insights: python3 ${skillsDir}/vision-insights/scripts/vision_analyze.py --preset chart --max-tokens 6000 <image-path>`,
    `    (analyzes a chart image with Nemotron Omni; returns the final summary on stdout)`,
    `  - AIQ Research:   python3 ${skillsDir}/aiq-research/scripts/aiq.py check-auth`,
    `                    python3 ${skillsDir}/aiq-research/scripts/aiq.py research "<query>" shallow_researcher`,
    `    (Submits a shallow async research job, polls server-side, and prints the final report JSON on stdout.`,
    `     The trailing \`shallow_researcher\` argument is REQUIRED — it forces the explicit-agent-type code path`,
    `     and bypasses the /chat endpoint's auto-router (which sometimes promotes broad queries to deep research`,
    `     even when the user asks for shallow). Do NOT use \`chat\`, \`submit\`, \`research_poll\`, or \`report\` here.`,
    `     Do NOT pass \`deep_researcher\` as the agent_type. Expect 20–60s of polling before stdout returns.)`,
    ""
  ];

  if (imagePath) {
    lines.push(`The user has attached an image at: ${imagePath}`);
    lines.push("Use Vision Insights on this image first; thread its summary into the AIQ Research prompt.");
    lines.push("");
  }

  lines.push("Guidance:");
  lines.push("- Call cuOpt FIRST. The optimized lanes, per-node utilization, and economic metrics it returns are the");
  lines.push("  factual basis the later stages depend on. Run it once, parse its stdout JSON envelope, and reference");
  lines.push("  its numbers (objective_value, selected_lanes, peak_capacity_pressure) in your synthesis. If cuOpt");
  lines.push("  fails or returns status != \"solved\", stop and report — do not fabricate routes.");
  lines.push("- Before calling AIQ Research, run `aiq.py check-auth`. If it returns need_browser_login, stop and report.");
  lines.push("- Issue exactly ONE AIQ research call as: `aiq.py research \"<query>\" shallow_researcher`.");
  lines.push("  The `shallow_researcher` argument is mandatory — do not omit it, do not substitute `deep_researcher`,");
  lines.push("  and do not fall back to `aiq.py chat`. The `research` command blocks for 20–60s while it polls server-side;");
  lines.push("  that wait is expected, not a failure. When it returns, its stdout will be the report JSON.");
  lines.push("- Keep each tool call focused; do not retry on transient errors more than twice.");
  lines.push("- Run every skill script (cuOpt, vision_analyze.py, aiq.py) SYNCHRONOUSLY in the foreground. Do NOT");
  lines.push("  invoke the Bash tool with `run_in_background: true` for these scripts — the UI relies on the tool's");
  lines.push("  stdout being the actual command output, not the harness's `Command running in background with ID:`");
  lines.push("  preamble. Each script blocks for tens of seconds; that wait is expected.");
  lines.push("");
  lines.push("Final synthesis output format (STRICT — the UI parses these headers):");
  lines.push("After your tool calls complete, emit the brief as your final assistant message,");
  lines.push("using EXACTLY these four level-2 markdown headers in this order, nothing else:");
  lines.push("");
  lines.push("    ## Strategy");
  lines.push("    <one focused paragraph on the recommended strategy>");
  lines.push("");
  lines.push("    ## Market");
  lines.push("    <one focused paragraph on the market / competitive landscape>");
  lines.push("");
  lines.push("    ## Risk");
  lines.push("    <one focused paragraph on the key risks>");
  lines.push("");
  lines.push("    ## Execution");
  lines.push("    <one focused paragraph on the phased execution plan>");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Use these four headers verbatim — no numbering, no extra words (not `## Strategic Plan`, not `## 1. Strategy`).");
  lines.push("- Do NOT add an executive summary, conclusion, or any other section before/between/after them.");
  lines.push("- Do NOT mention `Nemotron Omni`, `Vision Insights`, `AIQ Research`, or `aiq.py` in the synthesis body — those tool names confuse the UI's routing. Refer to findings without naming the skill.");
  lines.push("- Keep paragraphs concise (2–4 sentences each).");
  lines.push("");
  return lines.join("\n");
}

export function buildInvocation({ harness, prompt, imagePath, surface }) {
  const skillsDir = surface === "sandbox" ? SANDBOX_SKILLS_DIR : HOST_SKILLS_DIR;
  const resolvedImage = resolveImagePath(imagePath, surface);
  const systemPrime = buildSystemPrime({ skillsDir, imagePath: resolvedImage, harness });
  const stdinPayload = systemPrime + "\n--- USER REQUEST ---\n" + prompt + "\n";

  let innerBin;
  let innerArgs;

  if (harness === "claude") {
    innerBin = surface === "sandbox" ? "/sandbox/.local/bin/claude" : HOST_CLAUDE;
    // bypassPermissions is safe inside the openshell sandbox — egress and FS isolation
    // are enforced by the policy at policies/my-assistant-policy.yaml.
    innerArgs = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--add-dir", skillsDir
    ];
  } else if (harness === "codex") {
    innerBin = surface === "sandbox" ? "/sandbox/.local/bin/codex" : HOST_CODEX;
    // Inside openshell, Codex's own nested namespace sandbox cannot initialize and
    // its shell tool fails for every command. Explicitly bypass — openshell's
    // policy at policies/my-assistant-policy.yaml is the real boundary.
    // On the host fallback, keep Codex's own workspace-write sandbox enabled.
    innerArgs = surface === "sandbox"
      ? ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"]
      : ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"];
  } else {
    throw new Error(`Unsupported harness: ${harness}`);
  }

  if (surface === "sandbox") {
    return {
      cmd: OPENSHELL_BIN,
      args: ["sandbox", "exec", "-n", SANDBOX_NAME, "--", innerBin, ...innerArgs],
      env: { ...process.env },
      stdin: stdinPayload
    };
  }

  return {
    cmd: innerBin,
    args: innerArgs,
    env: { ...process.env },
    stdin: stdinPayload
  };
}

export const PATHS = {
  OPENSHELL_BIN,
  SANDBOX_NAME,
  SANDBOX_SKILLS_DIR,
  HOST_SKILLS_DIR,
  SANDBOX_UPLOAD_DIR,
  HOST_UPLOAD_DIR,
  SANDBOX_SAMPLE_PATH,
  HOST_SAMPLE_PATH
};
