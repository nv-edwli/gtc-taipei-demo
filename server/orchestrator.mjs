import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { checkSandbox, buildInvocation } from "./sandbox.mjs";
import { createClaudeNormalizer } from "./normalize-claude.mjs";
import { createCodexNormalizer } from "./normalize-codex.mjs";

const RUNS = new Map(); // runId → { child, harness, surface, startedAt, stderrTail }
const STDERR_TAIL_LINES = 16;
const MAX_PROMPT_BYTES = 32 * 1024;

function writeBeat(res, beat) {
  if (res.writableEnded) return;
  try {
    res.write(JSON.stringify(beat) + "\n");
  } catch (_) {
    /* connection lost; ignore */
  }
}

function validateRunBody(body) {
  if (!body || typeof body !== "object") return "body must be JSON";
  if (body.harness !== "codex" && body.harness !== "claude") return "harness must be 'codex' or 'claude'";
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "prompt is required";
  if (Buffer.byteLength(body.prompt, "utf8") > MAX_PROMPT_BYTES) return "prompt too large (max 32KB)";
  if (body.surface && !["auto", "sandbox", "host"].includes(body.surface)) return "surface must be auto|sandbox|host";
  if (body.imagePath && typeof body.imagePath !== "string") return "imagePath must be a string or null";
  if (body.imagePath) {
    // imagePath must be either a /tmp/uploads/ path or the bundled sample
    const ok =
      body.imagePath.startsWith("/tmp/uploads/") ||
      body.imagePath === "/data/sample-capacity.png" ||
      body.imagePath.endsWith("/data/sample-capacity.png");
    if (!ok) return "imagePath must be an uploaded path or the bundled sample";
  }
  return null;
}

export async function handleRun(body, res) {
  const validationError = validateRunBody(body);
  if (validationError) {
    res.statusCode = 400;
    writeBeat(res, { kind: "run.failed", data: { error: validationError } });
    res.end();
    return;
  }

  const requestedSurface = body.surface || "auto";
  let surface = requestedSurface;
  if (requestedSurface === "auto") {
    const health = await checkSandbox(5000);
    surface = health.reachable ? "sandbox" : "host";
    writeBeat(res, {
      kind: "surface.info",
      data: {
        surface,
        sandboxReachable: health.reachable,
        reason: health.reason || null,
        harness: body.harness
      }
    });
  } else if (requestedSurface === "sandbox") {
    const health = await checkSandbox(5000);
    if (!health.reachable) {
      writeBeat(res, { kind: "run.failed", data: { error: "sandbox unreachable: " + (health.reason || "unknown") } });
      res.end();
      return;
    }
    writeBeat(res, { kind: "surface.info", data: { surface, sandboxReachable: true, reason: null, harness: body.harness } });
  } else {
    writeBeat(res, { kind: "surface.info", data: { surface, sandboxReachable: null, reason: "host-only requested", harness: body.harness } });
  }

  let invocation;
  try {
    invocation = buildInvocation({
      harness: body.harness,
      prompt: body.prompt,
      imagePath: body.imagePath || null,
      surface
    });
  } catch (err) {
    writeBeat(res, { kind: "run.failed", data: { error: "build invocation: " + err.message } });
    res.end();
    return;
  }

  const runId = randomUUID();
  const startedAt = Date.now();
  const child = spawn(invocation.cmd, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: invocation.env
  });

  // Pipe the prompt via stdin (avoids openshell's argv-newline restriction)
  if (invocation.stdin) {
    child.stdin.on("error", (err) => {
      writeBeat(res, { kind: "log", data: { level: "warn", text: "stdin write error: " + err.message } });
    });
    try {
      child.stdin.write(invocation.stdin);
      child.stdin.end();
    } catch (err) {
      writeBeat(res, { kind: "log", data: { level: "warn", text: "stdin error: " + err.message } });
    }
  } else if (child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
  }

  const runEntry = { child, harness: body.harness, surface, startedAt, stderrTail: [], emittedTerminal: false };
  RUNS.set(runId, runEntry);

  writeBeat(res, {
    kind: "run.registered",
    data: { runId, harness: body.harness, surface, cmd: invocation.cmd, argv: invocation.args.slice(0, 4) }
  });

  const normalize = body.harness === "claude" ? createClaudeNormalizer() : createCodexNormalizer();

  const stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutReader.on("line", (line) => {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch (err) {
      writeBeat(res, { kind: "log", data: { level: "warn", text: "malformed json: " + line.slice(0, 200) } });
      return;
    }
    const beats = normalize(evt);
    for (const beat of beats) {
      writeBeat(res, beat);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    runEntry.stderrTail.push(text);
    while (runEntry.stderrTail.length > STDERR_TAIL_LINES) {
      runEntry.stderrTail.shift();
    }
    // also surface stderr lines as low-priority logs for debugging
    for (const ln of text.split(/\r?\n/)) {
      if (ln.trim()) {
        writeBeat(res, { kind: "log", data: { level: "stderr", text: ln.slice(0, 480) } });
      }
    }
  });

  // Handle client disconnect: kill the child cleanly
  const onClientClose = () => {
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill("SIGKILL"); } catch (_) {}
        }
      }, 1500);
    }
  };
  res.on("close", onClientClose);

  child.on("error", (err) => {
    if (runEntry.emittedTerminal) return;
    runEntry.emittedTerminal = true;
    writeBeat(res, { kind: "run.failed", data: { error: "spawn error: " + err.message } });
    cleanup();
  });

  child.on("exit", (code, signal) => {
    if (runEntry.emittedTerminal) {
      cleanup();
      return;
    }
    runEntry.emittedTerminal = true;
    const durationMs = Date.now() - startedAt;
    const stderr = runEntry.stderrTail.join("");
    if (code === 0) {
      writeBeat(res, { kind: "run.completed", data: { exitCode: 0, durationMs, signal: signal || null } });
    } else if (signal === "SIGTERM" || signal === "SIGKILL") {
      writeBeat(res, { kind: "run.cancelled", data: { exitCode: code, signal, durationMs } });
    } else {
      writeBeat(res, {
        kind: "run.failed",
        data: { exitCode: code, signal: signal || null, durationMs, stderr: stderr.slice(-2000) }
      });
    }
    cleanup();
  });

  function cleanup() {
    RUNS.delete(runId);
    res.off("close", onClientClose);
    if (!res.writableEnded) {
      try { res.end(); } catch (_) {}
    }
  }
}

export function cancelRun(runId) {
  const entry = RUNS.get(runId);
  if (!entry) return false;
  if (!entry.child.killed) {
    try { entry.child.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => {
      if (!entry.child.killed) {
        try { entry.child.kill("SIGKILL"); } catch (_) {}
      }
    }, 1000);
  }
  return true;
}

export function listRuns() {
  return Array.from(RUNS.entries()).map(([id, entry]) => ({
    runId: id,
    harness: entry.harness,
    surface: entry.surface,
    uptimeMs: Date.now() - entry.startedAt
  }));
}
