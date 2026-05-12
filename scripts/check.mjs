import { readFile } from "node:fs/promises";

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "server.mjs",
  "data/supply-chain.json",
  "docs/demo-script.md",
  "docs/integration-plan.md"
];

async function assertFile(path) {
  const content = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
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

for (const skill of data.skills) {
  if (!stages.has(skill.stage)) {
    throw new Error(`Skill ${skill.name} references missing stage ${skill.stage}`);
  }
}

for (const harness of ["codex", "claude"]) {
  if (!data.insights.vision[harness]) {
    throw new Error(`Missing Vision Insights copy for ${harness}`);
  }
}

console.log("Static demo checks passed");
