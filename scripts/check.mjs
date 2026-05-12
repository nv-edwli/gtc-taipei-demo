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

for (const key of ["mapStatus", "closing", "scoreContext", "scenarioLoad"]) {
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

console.log("Static demo checks passed");
