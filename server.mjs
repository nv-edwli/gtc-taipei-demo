import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml"
};

function resolveRequest(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const cleanPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const target = cleanPath === "/" ? "/index.html" : cleanPath;
  return join(root, target);
}

const server = createServer((req, res) => {
  let filePath = resolveRequest(req.url || "/");

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
});

server.listen(port, "0.0.0.0", () => {
  console.log(`GTC Taipei demo running at http://localhost:${port}`);
});
