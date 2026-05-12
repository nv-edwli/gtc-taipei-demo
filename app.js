const state = {
  data: null,
  harness: "codex",
  activeStage: "brief",
  activePlan: "strategy",
  runTimer: null,
  running: false,
  completedStages: new Set(["brief"])
};

const harnessCopy = {
  codex: {
    name: "Codex",
    voice: "Codex routes file-backed skill context into a repo-native run trace.",
    progress: {
      brief: "Codex loaded the Taiwan demand brief, constraints, and partner skill manifests from the workspace.",
      cuopt: "Codex invoked the cuOpt skill contract and normalized the optimized lanes for frontend display.",
      vision: "Codex passed the resulting chart artifact to Vision Insights for Nemotron Omni review.",
      aiq: "Codex launched AIQ Research with the optimized supply-chain facts appended to the research brief."
    },
    planPrefix: "Codex synthesis"
  },
  claude: {
    name: "Claude",
    voice: "Claude streams skill progress as a conversational agent harness using the same packaged skills.",
    progress: {
      brief: "Claude staged the Taiwan demand brief and prepared the cuOpt skill inputs.",
      cuopt: "Claude called the cuOpt skill contract and summarized the route changes for operators.",
      vision: "Claude attached the utilization chart to Vision Insights for Nemotron Omni interpretation.",
      aiq: "Claude submitted the business-plan request to AIQ Research with optimization evidence included."
    },
    planPrefix: "Claude synthesis"
  }
};

const stageOrder = ["brief", "cuopt", "vision", "aiq"];

const els = {
  harnessName: document.querySelector("#harness-name"),
  runStatus: document.querySelector("#run-status"),
  runButton: document.querySelector("#run-demo"),
  resetButton: document.querySelector("#reset-run"),
  console: document.querySelector("#run-console"),
  consoleDot: document.querySelector("#console-dot"),
  routeScore: document.querySelector("#route-score-value"),
  activeRoute: document.querySelector("#active-route"),
  scenarioLoad: document.querySelector("#scenario-load"),
  skillStack: document.querySelector("#skill-stack"),
  metricBars: document.querySelector("#metric-bars"),
  miniChart: document.querySelector("#mini-chart"),
  visionCopy: document.querySelector("#vision-copy"),
  visionConfidence: document.querySelector("#vision-confidence"),
  researchDepth: document.querySelector("#research-depth"),
  planBody: document.querySelector("#plan-body")
};

async function boot() {
  state.data = await loadDemoData();
  wireEvents();
  renderAll();
  addConsoleEntry("brief", harnessCopy[state.harness].progress.brief);
}

async function loadDemoData() {
  const response = await fetch("./data/supply-chain.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load demo data: ${response.status}`);
  }
  return response.json();
}

function wireEvents() {
  document.querySelectorAll("[data-harness]").forEach((button) => {
    button.addEventListener("click", () => {
      setHarness(button.dataset.harness);
    });
  });

  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeStage = button.dataset.stage;
      renderStages();
      renderSkillStack();
    });
  });

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activePlan = button.dataset.plan;
      renderPlanTabs();
      renderPlan();
    });
  });

  els.runButton.addEventListener("click", startRun);
  els.resetButton.addEventListener("click", resetRun);
}

function setHarness(harness) {
  if (!harness || harness === state.harness) return;
  state.harness = harness;
  addConsoleEntry(state.activeStage, harnessCopy[harness].voice);
  renderHarness();
  renderPlan();
}

function startRun() {
  if (state.running) return;

  state.running = true;
  els.runButton.disabled = true;
  els.consoleDot.classList.add("is-running");
  els.runStatus.textContent = "Running";

  const sequence = [
    { stage: "brief", delay: 0, score: 28 },
    { stage: "cuopt", delay: 900, score: 74 },
    { stage: "vision", delay: 1800, score: 83 },
    { stage: "aiq", delay: 2800, score: 91 }
  ];

  sequence.forEach((item) => {
    window.setTimeout(() => {
      completeStage(item.stage, item.score);
      if (item.stage === "aiq") {
        state.running = false;
        els.runButton.disabled = false;
        els.consoleDot.classList.remove("is-running");
        els.runStatus.textContent = "Complete";
      }
    }, item.delay);
  });
}

function resetRun() {
  state.completedStages = new Set(["brief"]);
  state.activeStage = "brief";
  state.activePlan = "strategy";
  state.running = false;
  els.runButton.disabled = false;
  els.consoleDot.classList.remove("is-running");
  els.console.innerHTML = "";
  els.runStatus.textContent = "Ready";
  els.activeRoute.classList.remove("is-solved");
  addConsoleEntry("brief", harnessCopy[state.harness].progress.brief);
  renderAll();
}

function completeStage(stage, score) {
  state.activeStage = stage;
  state.completedStages.add(stage);
  addConsoleEntry(stage, harnessCopy[state.harness].progress[stage]);

  if (stage === "cuopt") {
    els.activeRoute.classList.add("is-solved");
  }

  animateScore(score);
  renderAll();
}

function renderAll() {
  renderHarness();
  renderStages();
  renderSkillStack();
  renderMetrics();
  renderChart();
  renderPlanTabs();
  renderPlan();
}

function renderHarness() {
  const harness = harnessCopy[state.harness];
  els.harnessName.textContent = harness.name;

  document.querySelectorAll("[data-harness]").forEach((button) => {
    const isActive = button.dataset.harness === state.harness;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  });
}

function renderStages() {
  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.stage === state.activeStage);
  });
}

function renderSkillStack() {
  els.skillStack.innerHTML = state.data.skills.map((skill) => {
    const isActive = skill.stage === state.activeStage;
    const isComplete = state.completedStages.has(skill.stage);
    const stateLabel = isComplete ? "ready" : "queued";
    return `
      <article class="skill-item ${isActive ? "is-active" : ""}">
        <span class="skill-icon" aria-hidden="true">${skill.icon}</span>
        <span>
          <span class="skill-name">${skill.name}</span>
          <span class="skill-detail">${skill.detail}</span>
        </span>
        <span class="skill-state">${stateLabel}</span>
      </article>
    `;
  }).join("");
}

function renderMetrics() {
  const optimized = state.completedStages.has("cuopt");
  const metrics = optimized ? state.data.metrics.optimized : state.data.metrics.baseline;
  const max = Math.max(...metrics.map((metric) => metric.max));

  els.metricBars.innerHTML = metrics.map((metric) => {
    const width = Math.round((metric.value / max) * 100);
    return `
      <div class="metric-row">
        <div class="metric-label">
          <span>${metric.label}</span>
          <strong>${metric.display}</strong>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${width}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderChart() {
  const solved = state.completedStages.has("vision");
  const values = solved ? state.data.capacity.optimized : state.data.capacity.baseline;

  els.miniChart.innerHTML = values.map((item) => {
    const height = Math.max(8, Math.round(item.value));
    return `
      <div class="chart-bar ${item.value > 84 ? "is-hot" : ""}" style="--height: ${height}%">
        <span>${item.label}</span>
      </div>
    `;
  }).join("");

  if (solved) {
    els.visionConfidence.textContent = "high confidence";
    els.visionCopy.textContent = state.data.insights.vision[state.harness];
  } else {
    els.visionConfidence.textContent = "standby";
    els.visionCopy.textContent = "Awaiting optimized routing output.";
  }
}

function renderPlanTabs() {
  document.querySelectorAll("[data-plan]").forEach((button) => {
    const isActive = button.dataset.plan === state.activePlan;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
}

function renderPlan() {
  const ready = state.completedStages.has("aiq");
  const section = state.data.businessPlan[state.activePlan];
  els.researchDepth.textContent = ready ? "deep research" : "queued";

  if (!ready) {
    els.planBody.innerHTML = `
      <p>AIQ Research will assemble the business plan after cuOpt and Vision Insights complete.</p>
      <ul class="plan-points">
        <li>Optimization facts, chart observations, competitive landscape, risk, and feasibility are passed into one research brief.</li>
        <li>${harnessCopy[state.harness].name} remains the active harness for progress and synthesis.</li>
      </ul>
    `;
    return;
  }

  els.planBody.innerHTML = `
    <p><strong>${harnessCopy[state.harness].planPrefix}:</strong> ${section.summary}</p>
    <ul class="plan-points">
      ${section.points.map((point) => `<li>${point}</li>`).join("")}
    </ul>
  `;
}

function addConsoleEntry(stage, message) {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const stageLabel = state.data?.stageLabels?.[stage] || "demo";
  const li = document.createElement("li");
  li.innerHTML = `
    <time>${stamp}</time>
    <p><strong>${stageLabel}:</strong> ${message}</p>
  `;
  els.console.prepend(li);
}

function animateScore(target) {
  const current = Number(els.routeScore.textContent) || 0;
  const steps = 18;
  const delta = target - current;
  let frame = 0;

  window.clearInterval(state.runTimer);
  state.runTimer = window.setInterval(() => {
    frame += 1;
    const eased = 1 - Math.pow(1 - frame / steps, 3);
    els.routeScore.textContent = Math.round(current + delta * eased);
    if (frame >= steps) {
      window.clearInterval(state.runTimer);
      els.routeScore.textContent = target;
    }
  }, 28);
}

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="app-shell"><section class="panel"><div class="panel-heading"><h1>Demo failed to load</h1></div><p class="insight-copy">${error.message}</p></section></main>`;
});
