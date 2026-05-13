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
    `  - Vision Insights: python3 ${skillsDir}/vision-insights/scripts/vision_analyze.py --preset chart --max-tokens 6000 <image-path>`,
    `    (analyzes a chart image with Nemotron Omni; returns the final summary on stdout)`,
    `  - AIQ Research:   python3 ${skillsDir}/aiq-research/scripts/aiq.py check-auth`,
    `                    python3 ${skillsDir}/aiq-research/scripts/aiq.py chat "<query>"`,
    `    (shallow research with citations; chat returns the response inline within seconds.`,
    `     This demo runs in shallow mode for snappy turnaround — do NOT request the deep_researcher`,
    `     agent type, and do not invoke research_poll / report. If chat ever returns`,
    `     {"status":"deep_research_running",...}, treat that as an error and stop.)`,
    ""
  ];

  if (imagePath) {
    lines.push(`The user has attached an image at: ${imagePath}`);
    lines.push("Use Vision Insights on this image first; thread its summary into the AIQ Research prompt.");
    lines.push("");
  }

  lines.push("Guidance:");
  lines.push("- Before calling AIQ Research, run aiq.py check-auth. If it returns need_browser_login, stop and report.");
  lines.push("- Use a single shallow aiq.py chat call — do not initiate deep research jobs.");
  lines.push("- Keep each tool call focused; do not retry on transient errors more than twice.");
  lines.push("- When the run is complete, output a short final synthesis covering strategy, market, risk, and execution.");
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
