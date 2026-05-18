import { readFile, stat } from "node:fs/promises";
import { buildInvocation } from "../server/sandbox.mjs";

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "server.mjs",
  "server/orchestrator.mjs",
  "server/sandbox.mjs",
  "server/normalize-claude.mjs",
  "server/normalize-codex.mjs",
  "data/supply-chain.json",
  "data/default-prompt.txt",
  "data/sample-capacity.png",
  "docs/demo-script.md",
  "docs/integration-plan.md",
  "policies/my-assistant-policy.yaml"
];

async function assertFile(path) {
  const url = new URL(`../${path}`, import.meta.url);
  let content;
  try {
    content = await readFile(url, "utf8");
  } catch (err) {
    // binary files (PNG): fall back to stat
    const s = await stat(url);
    if (s.size === 0) throw new Error(`${path} is empty`);
    return null;
  }
  if (!content.trim()) {
    throw new Error(`${path} is empty`);
  }
  return content;
}

for (const path of requiredFiles) {
  await assertFile(path);
}

const data = JSON.parse(await assertFile("data/supply-chain.json"));
const stages = new Set(Object.keys(data.stageLabels));

const skillIds = new Set();
for (const skill of data.skills) {
  if (!skill.id || !skill.name || !skill.icon || !skill.detail) {
    throw new Error(`Skill entry missing required fields (id, name, icon, detail): ${JSON.stringify(skill)}`);
  }
  if (skillIds.has(skill.id)) {
    throw new Error(`Duplicate skill id: ${skill.id}`);
  }
  skillIds.add(skill.id);
  if (!Array.isArray(skill.match) || skill.match.length === 0) {
    throw new Error(`Skill ${skill.id} must define a non-empty match[] array of detection patterns`);
  }
}

for (const harness of ["codex", "claude"]) {
  if (!data.insights?.vision?.[harness]) {
    throw new Error(`Missing Vision Insights copy for ${harness}`);
  }
  if (!data.harness?.[harness]) {
    throw new Error(`Missing harness configuration for ${harness}`);
  }
  const stageCopy = data.harness[harness].stages;
  if (!stageCopy) {
    throw new Error(`Missing harness.${harness}.stages`);
  }
  for (const stage of stages) {
    if (!stageCopy[stage]) {
      throw new Error(`Missing harness.${harness}.stages.${stage}`);
    }
    if (!stageCopy[stage].calling || !stageCopy[stage].done) {
      throw new Error(`harness.${harness}.stages.${stage} must include calling and done copy`);
    }
  }
  if (!Array.isArray(stageCopy.aiq.streaming) || stageCopy.aiq.streaming.length < 3) {
    throw new Error(`harness.${harness}.stages.aiq.streaming must be an array of 3+ entries`);
  }
}

for (const key of ["mapStatus", "closing", "scoreContext", "scenarioLoad", "skillMap", "sample"]) {
  if (!data[key]) {
    throw new Error(`Missing top-level data block: ${key}`);
  }
}

for (const phase of ["baseline", "solving", "solved"]) {
  if (!data.mapStatus[phase]) {
    throw new Error(`Missing mapStatus.${phase}`);
  }
}

if (typeof data.scoreContext.baseline !== "number" || typeof data.scoreContext.optimized !== "number") {
  throw new Error("scoreContext.baseline and scoreContext.optimized must be numbers");
}

if (!data.skillMap["vision_analyze.py"] || !data.skillMap["aiq.py"]) {
  throw new Error("skillMap must include entries for vision_analyze.py and aiq.py");
}

if (!data.sample.imagePath || !data.sample.imageLabel) {
  throw new Error("sample.imagePath and sample.imageLabel are required");
}

// Doc-equality gate: AGENTS.md and CLAUDE.md must be byte-identical (after
// normalizing line endings + trailing whitespace + trailing newline). They
// are read by Codex and Claude respectively when working in this repo, and
// drift between them causes one harness to act on stale guidance.
{
  const claudeMd = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");
  const agentsMd = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
  if (normalize(claudeMd) !== normalize(agentsMd)) {
    throw new Error("AGENTS.md and CLAUDE.md have diverged. They must be byte-identical (after whitespace normalization). Run: cp CLAUDE.md AGENTS.md");
  }
}

// Static-file MIME gate: server.mjs must declare a JavaScript content type for
// every script extension it serves. Modern browsers REJECT ES-module imports
// served with the default `application/octet-stream` fallback, which silently
// kills `app.js`'s entire boot chain (no event handlers wire up, no prompt
// loads, no buttons work). Reproduced once — never again.
{
  const serverMjs = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const requiredMimes = [
    { ext: '".js"', mime: "text/javascript" },
    { ext: '".mjs"', mime: "text/javascript" }
  ];
  for (const { ext, mime } of requiredMimes) {
    const re = new RegExp(`${ext.replace(/\./g, "\\.")}\\s*:\\s*"${mime}`);
    if (!re.test(serverMjs)) {
      throw new Error(`server.mjs MIME map missing or wrong for ${ext} (expected ${mime}). Browsers reject module imports without a JavaScript MIME type.`);
    }
  }
}

// System-prime smoke test: assemble a fake invocation and assert the resulting
// stdin payload contains the tokens the demo depends on. Catches typos in
// buildSystemPrime that would silently break the demo at runtime.
{
  const inv = buildInvocation({
    harness: "claude",
    prompt: "smoke test",
    imagePath: "/data/sample-capacity.png",
    surface: "sandbox"
  });
  const prime = inv.stdin || "";
  const required = [
    "cuopt/max-supply/run.py",
    "shallow_researcher",
    "## Strategy",
    "## Market",
    "## Risk",
    "## Execution",
    "cuopt.result"
  ];
  for (const tok of required) {
    if (!prime.includes(tok)) {
      throw new Error(`System prime missing required token: "${tok}". Check server/sandbox.mjs:buildSystemPrime.`);
    }
  }
}

console.log("Static demo checks passed");
