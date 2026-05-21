import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const OPENSHELL_BIN = "/home/nvidia/.local/bin/openshell";
const SANDBOX_NAME = "my-assistant";
const HOST_CLAUDE = "/home/nvidia/.local/bin/claude";
const HOST_CODEX      = "/tmp/npm-global/bin/codex";
const SANDBOX_CODEX   = "/tmp/npm-global/bin/codex";  // codex harness inside the sandbox — uses integrate.api.nvidia.com

// Vision skill hosted endpoint + auth (NGC key used for integrate.api.nvidia.com)
const VISION_ENDPOINT = process.env.VISION_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";
const VISION_API_KEY  = process.env.VISION_API_KEY  || process.env.NGC_API_KEY || "";


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
    `  - cuOpt MILP:     python3 ${skillsDir}/cuopt/max-supply/run.py`,
    `    (Solves the max-supply multi-period MILP what-if via the cuOpt REST server at`,
    `     host.openshell.internal:8002 — GPU-accelerated on the host. Runs two solves:`,
    `     baseline (zero opening inventory) and what-if (SA1=40, RM1=250, RM3=180 units).`,
    `     Prints a single JSON envelope on stdout with shape`,
    `     {kind:"cuopt.result", status, baseline{}, whatif{}, delta{}, opening_stock{}, explanation}.`,
    `     No arguments; the scenario is encoded in the script. Typical runtime: 10-60s.)`,
    `  - Nemotron Omni: python3 ${skillsDir}/vision-insights/scripts/vision_analyze.py --preset chart --max-tokens 6000 --reasoning-budget 1600 <image-path>`,
    `    (NVIDIA's multimodal vision-insights model — analyzes a chart image and returns the final summary on stdout. Nemotron`,
    `     is a reasoning model: it emits a hidden thinking trace BEFORE the final answer. We cap that`,
    `     trace at 1600 tokens via --reasoning-budget so the model stops thinking promptly, leaving`,
    `     ~4400 tokens inside --max-tokens=6000 for the structured Observations/Insights/Recommendations`,
    `     readout the UI parses. The preset itself asks the model to keep the final answer under`,
    `     ~1500 tokens, so the 6000 budget is headroom rather than the expected size. Wall time`,
    `     typically 40–120s. If the call still exits 2 (truncated), raise --max-tokens to 8000.)`,
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
    lines.push("Use Nemotron Omni on this image first; thread its summary into the AIQ Research prompt.");
    lines.push("");
  }

  lines.push("Guidance:");
  lines.push("- Call cuOpt FIRST. The baseline and what-if MILP results it returns are the");
  lines.push("  factual basis the later stages depend on. Run it once, parse its stdout JSON envelope, and reference");
  lines.push("  its numbers (delta.objective, delta.fg1_final, baseline.rm1_buy_total, whatif.rm1_buy_total) in your synthesis.");
  lines.push("  If cuOpt fails or returns status != \"solved\", stop and report — do not fabricate numbers.");
  lines.push("- Before calling AIQ Research, run `aiq.py check-auth`. If it returns need_browser_login, stop and report.");
  lines.push("- Issue exactly ONE AIQ research call as: `aiq.py research \"<query>\" shallow_researcher`.");
  lines.push("  The `shallow_researcher` argument is mandatory — do not omit it, do not substitute `deep_researcher`,");
  lines.push("  and do not fall back to `aiq.py chat`. The `research` command blocks for 20–60s while it polls server-side;");
  lines.push("  that wait is expected, not a failure. When it returns, its stdout will be the report JSON.");
  lines.push("- IMPORTANT — keep the AIQ query SCOPED TO PUBLIC SOURCES ONLY. The demo's NVAuth token does NOT grant");
  lines.push("  access to ECI (Enterprise Competitive Intelligence) or NVIDIA-internal proprietary data, and any query");
  lines.push("  that triggers an ECI lookup will fail server-side with an auth error after ~30s. To avoid this:");
  lines.push("    * Prefix the AIQ query with the directive: \"Using only publicly available web sources, …\".");
  lines.push("    * Ask about publicly observable topics (market reports, news, geopolitical and weather risk, supplier");
  lines.push("      concentration in published filings) — NOT about NVIDIA internal customer lists, proprietary deals,");
  lines.push("      enterprise pipeline data, or anything that names \"ECI\" / \"enterprise intelligence\".");
  lines.push("    * Frame the question as competitive/market analysis a public-source consultant could write.");
  lines.push("  If the AIQ result returns `\"error\": \"ECI search failed: No authentication token available...\"`, that");
  lines.push("  means the query asked for enterprise data. Do NOT retry — report the failure and let the UI fall back.");
  lines.push("- Keep each tool call focused; do not retry on transient errors more than twice.");
  lines.push("- Run every skill script (cuOpt, vision_analyze.py, aiq.py) SYNCHRONOUSLY in the foreground. Do NOT");
  lines.push("  invoke the Bash tool with `run_in_background: true` for these scripts — the UI relies on the tool's");
  lines.push("  stdout being the actual command output, not the harness's `Command running in background with ID:`");
  lines.push("  preamble. Each script blocks for tens of seconds; that wait is expected.");
  lines.push("- IMPORTANT — set a generous Bash-tool timeout for vision_analyze.py and aiq.py. Both can run");
  lines.push("  longer than the Bash tool's 2-minute default and the tool will kill them mid-flight otherwise.");
  lines.push("  When invoking vision_analyze.py, pass `timeout: 360000` (6 minutes in milliseconds). Nemotron");
  lines.push("  Omni at the chart preset with this brief lands typically around 60-120s, but the worst case");
  lines.push("  with the full 6000 max-tokens budget can run ~300s; the 360s ceiling leaves a 60s buffer.");
  lines.push("  When invoking aiq.py research, pass `timeout: 180000` (3 minutes). cuOpt typically finishes");
  lines.push("  in <15s and the default is fine for it.");
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
  lines.push("- Do NOT use the word `board` in any form anywhere in the synthesis — no `board-ready`, `board ready`, `board-level`, `board level`, `board meeting`, `the board`, etc. If you need to describe the deliverable or audience, say `executive brief` / `executive-level` / `leadership` / `C-suite`, or omit the descriptor entirely. This applies even when the underlying AIQ research output uses board-related phrasing — rewrite it.");
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
      "--dangerously-skip-permissions",
      "--add-dir", skillsDir
    ];
  } else if (harness === "codex") {
    innerBin = surface === "sandbox" ? SANDBOX_CODEX : HOST_CODEX;
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

  const extraEnv = { VISION_ENDPOINT, VISION_API_KEY };

  if (surface === "sandbox") {
    // openshell strips host env vars so .bashrc is not sourced for non-interactive
    // exec sessions. Wrap the inner command in bash -c that sources .bashrc first
    // so OPENAI_API_KEY (and any other keys stored there) reach the harness binary.
    const wrappedArgs = ["sandbox", "exec", "-n", SANDBOX_NAME, "--",
      "/bin/bash", "-c",
      `source ~/.bashrc 2>/dev/null; exec ${innerBin} ${innerArgs.map(a => `'${a}'`).join(" ")}`
    ];
    return {
      cmd: OPENSHELL_BIN,
      args: wrappedArgs,
      env: { ...process.env, ...extraEnv },
      stdin: stdinPayload
    };
  }

  return {
    cmd: innerBin,
    args: innerArgs,
    env: { ...process.env, ...extraEnv },
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
