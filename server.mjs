import { createServer } from "node:http";
import { createReadStream, statSync, mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { handleRun, cancelRun } from "./server/orchestrator.mjs";
import { checkSandbox, syncSampleImage, syncUploadedImage, syncNvauthToken } from "./server/sandbox.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const UPLOAD_DIR = "/tmp/uploads";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const POLICY_PATH = join(root, "policies", "my-assistant-policy.yaml");

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

function parseArg(name) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const hostArg = parseArg("host");
const portArg = parseArg("port");
const host = typeof hostArg === "string" ? hostArg : "0.0.0.0";
const port = Number(portArg || process.env.PORT || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8"
};

function resolveStatic(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const cleanPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const target = cleanPath === "/" ? "/index.html" : cleanPath;
  return join(root, target);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve({});
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function handleUpload(req, res) {
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_UPLOAD_MIME.has(contentType)) {
    return sendJson(res, 415, { error: `unsupported mime: ${contentType || "(missing)"}; allowed: ${[...ALLOWED_UPLOAD_MIME].join(", ")}` });
  }
  let buf;
  try {
    buf = await readBinaryBody(req, MAX_UPLOAD_BYTES);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message });
  }
  if (buf.length === 0) {
    return sendJson(res, 400, { error: "empty upload" });
  }

  // Sniff first bytes to validate the MIME claim
  const sig = buf.slice(0, 16);
  const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
  const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
  const isWebp = sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46 &&
                 sig[8] === 0x57 && sig[9] === 0x45 && sig[10] === 0x42 && sig[11] === 0x50;
  if (!(isPng || isJpeg || isWebp)) {
    return sendJson(res, 415, { error: "file content does not match an allowed image format" });
  }

  const ext = isPng ? "png" : isJpeg ? "jpg" : "webp";
  const filename = `${randomUUID()}.${ext}`;
  const dest = join(UPLOAD_DIR, filename);
  await writeFile(dest, buf);

  // Mirror to the sandbox so vision_analyze.py can read it from inside.
  // Non-blocking from caller's perspective: we await but don't fail the request if it errors.
  const sandboxResult = await syncUploadedImage(dest);
  if (!sandboxResult.ok) {
    console.warn("[upload] sandbox mirror skipped:", sandboxResult.reason);
  }

  sendJson(res, 200, {
    imagePath: dest,
    filename,
    bytes: buf.length,
    sandboxMirrored: sandboxResult.ok,
    sandboxError: sandboxResult.ok ? null : sandboxResult.reason
  });
}

async function handleSandboxStatus(req, res) {
  const health = await checkSandbox(5000);
  sendJson(res, 200, {
    sandboxReachable: health.reachable,
    surface: health.reachable ? "sandbox" : "host",
    reason: health.reason || null
  });
}

async function handlePolicy(req, res) {
  try {
    const yaml = await readFile(POLICY_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-store" });
    res.end(yaml);
  } catch (err) {
    sendJson(res, 404, { error: "policy file not found at " + POLICY_PATH });
  }
}

async function handleStaticFile(req, res) {
  let filePath = resolveStatic(req.url || "/");
  try {
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const contentType = types[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentType
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";
  const method = (req.method || "GET").toUpperCase();

  try {
    if (method === "POST" && url === "/api/run") {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked"
      });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.write(JSON.stringify({ kind: "run.failed", data: { error: "bad json: " + err.message } }) + "\n");
        res.end();
        return;
      }
      await handleRun(body, res);
      return;
    }

    if (method === "POST" && url === "/api/upload") {
      await handleUpload(req, res);
      return;
    }

    if (method === "GET" && url === "/api/sandbox/status") {
      await handleSandboxStatus(req, res);
      return;
    }

    if (method === "GET" && url === "/api/policy") {
      await handlePolicy(req, res);
      return;
    }

    if (method === "POST" && url.startsWith("/api/run/") && url.endsWith("/cancel")) {
      const runId = url.slice("/api/run/".length, url.length - "/cancel".length);
      const ok = cancelRun(runId);
      sendJson(res, ok ? 204 : 404, { cancelled: ok });
      return;
    }

    // Serve uploaded files for browser preview when needed
    if (method === "GET" && url.startsWith("/uploads/")) {
      const filename = decodeURIComponent(url.slice("/uploads/".length));
      const filePath = join(UPLOAD_DIR, filename);
      if (!filePath.startsWith(UPLOAD_DIR)) {
        res.writeHead(403); res.end("forbidden"); return;
      }
      try {
        statSync(filePath);
      } catch {
        res.writeHead(404); res.end("not found"); return;
      }
      const ct = types[extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
      createReadStream(filePath).pipe(res);
      return;
    }

    if (method === "GET" || method === "HEAD") {
      await handleStaticFile(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD, POST" });
    res.end("Method not allowed");
  } catch (err) {
    console.error("[server] unhandled:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(port, host, async () => {
  console.log(`GTC Taipei demo running:`);
  console.log(`  Local:    http://localhost:${port}`);
  if (host === "0.0.0.0") {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (iface.family === "IPv4" && !iface.internal) {
          console.log(`  Network:  http://${iface.address}:${port}`);
        }
      }
    }
  }
  const health = await checkSandbox(5000);
  console.log(`  Sandbox:  ${health.reachable ? "reachable (my-assistant)" : "unreachable — runs will use host (" + (health.reason || "unknown") + ")"}`);
  if (health.reachable) {
    const sample = await syncSampleImage();
    console.log(`  Sample:   ${sample.ok ? "uploaded to sandbox" : "sandbox sync failed (" + sample.reason + ")"}`);
    const nv = await syncNvauthToken();
    console.log(`  NVAuth:   ${nv.ok ? "uploaded to sandbox" : "skipped (" + nv.reason + ")"}`);
  }
});
