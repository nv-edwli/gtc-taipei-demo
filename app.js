const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  data: null,
  harness: "codex",
  activeStage: "brief",
  activePlan: "strategy",
  running: false,
  completed: false,
  completedStages: new Set(),
  stageState: { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" },
  beatTimers: [],
  activeTweens: new Map(),
  typewriterTimer: null,
  progressFillTimer: null,
  runStartedAt: null,
  totalRunMs: 0,
  baselineScore: 41,
  optimizedScore: 91,
  currentScore: 41,
  scenarioDisplay: "— weekly lots"
};

const els = {};

const stageOrder = ["brief", "cuopt", "vision", "aiq"];

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function tween({ from, to, duration, easing = easeOutCubic, onUpdate, onComplete, key }) {
  if (REDUCED_MOTION) {
    onUpdate(to);
    if (onComplete) onComplete();
    return { cancel() {} };
  }

  if (key && state.activeTweens.has(key)) {
    state.activeTweens.get(key).cancel(false);
  }

  const start = performance.now();
  let cancelled = false;
  let frameId = null;

  function step(now) {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / duration);
    onUpdate(from + (to - from) * easing(t));
    if (t < 1) {
      frameId = requestAnimationFrame(step);
    } else {
      if (key) state.activeTweens.delete(key);
      if (onComplete) onComplete();
    }
  }

  frameId = requestAnimationFrame(step);

  const handle = {
    cancel(revealEnd = false) {
      cancelled = true;
      if (frameId) cancelAnimationFrame(frameId);
      if (revealEnd) onUpdate(to);
      if (key) state.activeTweens.delete(key);
    }
  };

  if (key) state.activeTweens.set(key, handle);
  return handle;
}

function cancelAllTweens() {
  for (const handle of state.activeTweens.values()) {
    handle.cancel(false);
  }
  state.activeTweens.clear();
}

async function boot() {
  state.data = await loadDemoData();
  state.baselineScore = state.data.scoreContext.baseline;
  state.optimizedScore = state.data.scoreContext.optimized;
  state.currentScore = state.baselineScore;

  collectEls();
  wireEvents();
  renderAll();
  applyIdleState();
}

async function loadDemoData() {
  const response = await fetch("./data/supply-chain.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load demo data: ${response.status}`);
  }
  return response.json();
}

function collectEls() {
  els.body = document.body;
  els.harnessName = document.querySelector("#harness-name");
  els.harnessToggle = document.querySelector("#harness-toggle");
  els.runStatus = document.querySelector("#run-status");
  els.runButton = document.querySelector("#run-demo");
  els.runLabel = els.runButton.querySelector(".run-label");
  els.resetButton = document.querySelector("#reset-run");
  els.console = document.querySelector("#run-console");
  els.consoleDot = document.querySelector("#console-dot");
  els.routeScore = document.querySelector("#route-score");
  els.routeScoreValue = document.querySelector("#route-score-value");
  els.routeScoreLabel = document.querySelector("#route-score-label");
  els.routeScoreDelta = document.querySelector("#route-score-delta");
  els.activeRoute = document.querySelector("#active-route");
  els.baselineRoute = document.querySelector("#baseline-route");
  els.feederRoute = document.querySelector("#feeder-route");
  els.portRoute = document.querySelector("#port-route");
  els.mapStatus = document.querySelector("#map-status");
  els.mapStatusText = document.querySelector("#map-status-text");
  els.scenarioLoad = document.querySelector("#scenario-load");
  els.skillStack = document.querySelector("#skill-stack");
  els.metricBars = document.querySelector("#metric-bars");
  els.metricsEyebrow = document.querySelector("#metrics-eyebrow");
  els.miniChart = document.querySelector("#mini-chart");
  els.visionCopy = document.querySelector("#vision-copy");
  els.visionConfidence = document.querySelector("#vision-confidence");
  els.researchDepth = document.querySelector("#research-depth");
  els.planTabs = document.querySelector("#plan-tabs");
  els.planBody = document.querySelector("#plan-body");
  els.progressFill = document.querySelector("#progress-rail-fill");
  els.runCompleteBar = document.querySelector("#run-complete-bar");
  els.runCompleteEyebrow = document.querySelector("#run-complete-eyebrow");
  els.runCompleteSummary = document.querySelector("#run-complete-summary");
  els.ctaReview = document.querySelector("#cta-review");
  els.ctaRerun = document.querySelector("#cta-rerun");
}

function wireEvents() {
  els.harnessToggle.querySelectorAll("[data-harness]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.running) return;
      setHarness(button.dataset.harness);
    });
  });

  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      const stage = button.dataset.stage;
      if (state.running) {
        highlightStagePanel(stage);
        return;
      }
      state.activeStage = stage;
      renderStages();
      renderSkillStack();
      highlightStagePanel(stage);
    });
  });

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      state.activePlan = button.dataset.plan;
      renderPlanTabs();
      renderPlanContent();
    });
  });

  els.runButton.addEventListener("click", () => {
    if (state.running) return;
    if (state.completed) {
      resetRun();
      requestAnimationFrame(() => startRun());
    } else {
      startRun();
    }
  });

  els.resetButton.addEventListener("click", resetRun);

  els.ctaRerun.addEventListener("click", () => {
    resetRun();
    requestAnimationFrame(() => startRun());
  });

  els.ctaReview.addEventListener("click", () => {
    const plan = document.querySelector(".plan-panel");
    if (plan && typeof plan.scrollIntoView === "function") {
      plan.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    triggerTabWave();
  });
}

/* ============================================================
 * Rendering — Idle state
 * ============================================================ */

function renderAll() {
  renderHarness();
  renderStages();
  renderSkillStack();
  renderMetrics("baseline");
  renderChart("baseline");
  renderPlanTabs();
  renderPlan();
}

function applyIdleState() {
  els.body.classList.remove("is-running", "is-run-complete", "is-plan-elevated");
  els.runButton.classList.remove("is-rerun");
  els.runButton.disabled = false;
  els.runLabel.textContent = "Run";
  els.runStatus.textContent = "Ready";
  els.consoleDot.classList.remove("is-running");
  els.harnessToggle.removeAttribute("aria-disabled");
  els.activeRoute.classList.remove("is-solved");
  els.baselineRoute.classList.remove("is-faded", "is-solving");
  els.feederRoute.classList.remove("is-revealed");
  els.portRoute.classList.remove("is-revealed");
  els.mapStatus.classList.remove("is-solving", "is-solved");
  els.mapStatus.classList.add("is-baseline");
  els.mapStatusText.textContent = state.data.mapStatus.baseline;
  els.scenarioLoad.textContent = state.data.scenarioLoad.placeholder;
  els.routeScoreValue.textContent = String(state.baselineScore);
  els.routeScoreLabel.textContent = state.data.scoreContext.baselineLabel;
  els.routeScoreDelta.hidden = true;
  els.routeScoreDelta.textContent = state.data.scoreContext.deltaLabel.split(" ")[0];
  els.console.innerHTML = "";
  els.visionConfidence.textContent = "standby";
  els.visionConfidence.className = "confidence-chip is-quiet";
  els.visionCopy.textContent = "Awaiting Nemotron Omni readout on optimized utilization.";
  els.researchDepth.textContent = "queued";
  els.researchDepth.className = "confidence-chip is-quiet";
  els.progressFill.style.width = "0%";
  els.runCompleteBar.hidden = true;
  els.runCompleteBar.classList.remove("is-visible");
  els.metricsEyebrow.textContent = "Baseline today";

  state.currentScore = state.baselineScore;
  state.completedStages = new Set();
  state.stageState = { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" };
  state.activeStage = "brief";
  state.activePlan = "strategy";
  state.completed = false;

  renderStages();
  renderSkillStack();
  renderPlan();
  renderPlanTabs();
}

function renderHarness() {
  const harness = state.data.harness[state.harness];
  els.harnessName.textContent = harness.name;
  els.body.dataset.harness = state.harness;

  els.harnessToggle.querySelectorAll("[data-harness]").forEach((button) => {
    const isActive = button.dataset.harness === state.harness;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  });
}

function renderStages() {
  document.querySelectorAll("[data-stage]").forEach((button) => {
    const stage = button.dataset.stage;
    const sub = state.stageState[stage];
    button.classList.toggle("is-active", stage === state.activeStage);
    button.classList.toggle("is-running", sub === "calling" || sub === "streaming");
    button.classList.toggle("is-complete", sub === "done");
  });
}

function renderSkillStack() {
  els.skillStack.innerHTML = state.data.skills.map((skill) => {
    const sub = state.stageState[skill.stage];
    const isRunning = sub === "calling" || sub === "streaming";
    const isDone = sub === "done";
    let stateLabel = "queued";
    if (sub === "calling") stateLabel = "calling";
    else if (sub === "streaming") stateLabel = "streaming";
    else if (isDone) stateLabel = "ready";
    return `
      <article class="skill-item ${isRunning ? "is-running" : ""} ${isDone ? "is-done" : ""}">
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

function renderMetrics(phase) {
  const isOptimized = phase === "optimized";
  const source = isOptimized ? state.data.metrics.optimized : state.data.metrics.baseline;
  const optimized = state.data.metrics.optimized;
  const max = Math.max(...optimized.map((metric) => metric.max));

  els.metricBars.classList.toggle("is-baseline", phase === "baseline");
  els.metricBars.classList.toggle("is-optimized", phase === "optimized");
  els.metricsEyebrow.textContent = isOptimized ? "Optimized" : "Baseline today";

  els.metricBars.innerHTML = source.map((metric, ix) => {
    const optimizedMetric = optimized[ix];
    const width = Math.round((metric.value / max) * 100);
    const deltaChip = optimizedMetric.delta
      ? `<span class="metric-delta">${optimizedMetric.delta}</span>`
      : "";
    return `
      <div class="metric-row" data-row="${ix}">
        <div class="metric-label">
          <div class="metric-label-row">
            <span>${metric.label}</span>
            <strong>${metric.display}</strong>
          </div>
          ${deltaChip}
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${width}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderChart(phase) {
  const isOptimized = phase === "optimized";
  const values = isOptimized ? state.data.capacity.optimized : state.data.capacity.baseline;

  els.miniChart.classList.toggle("is-baseline", phase === "baseline");
  els.miniChart.classList.toggle("is-optimized", phase === "optimized");
  els.miniChart.classList.toggle("is-analyzing", phase === "analyzing");

  els.miniChart.innerHTML = values.map((item, ix) => {
    const height = Math.max(8, Math.round(item.value));
    const isHot = isOptimized ? item.value > 84 : false;
    return `
      <div class="chart-bar ${isHot ? "is-hot" : ""}" data-bar="${ix}" style="--height: ${height}%">
        <span>${item.label}</span>
      </div>
    `;
  }).join("");
}

function renderPlanTabs() {
  const aiqDone = state.stageState.aiq === "done";
  document.querySelectorAll("[data-plan]").forEach((button) => {
    const isActive = button.dataset.plan === state.activePlan;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    if (aiqDone) {
      button.removeAttribute("aria-disabled");
    } else {
      button.setAttribute("aria-disabled", "true");
    }
  });
}

function renderPlan() {
  const sub = state.stageState.aiq;
  if (sub === "idle") return renderPlanSkeleton();
  if (sub === "calling") return renderPlanResearching(0);
  if (sub === "streaming") return; /* handled by beat actions */
  if (sub === "done") return renderPlanContent();
}

function renderPlanSkeleton() {
  els.planBody.innerHTML = `
    <div class="plan-skeleton" aria-hidden="true">
      <div class="skel line"></div>
      <div class="skel line"></div>
      <div class="skel short"></div>
      <div class="skel gap"></div>
      <div class="skel bullet"></div>
      <div class="skel bullet b"></div>
      <div class="skel bullet c"></div>
    </div>
  `;
}

function renderPlanResearching(fillPct) {
  const harness = state.data.harness[state.harness];
  els.planBody.innerHTML = `
    <div class="plan-researching">
      <div class="researching-head">
        <span class="dot-loader" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="researching-title">${harness.name} streaming AIQ Research…</span>
      </div>
      <p class="researching-subtitle">Pulling competitive landscape, risk register, and market segment evidence before synthesis.</p>
      <div class="source-counter">
        <div class="source-counter-label"><span>Source coverage</span><strong id="source-counter-pct">${Math.round(fillPct)}%</strong></div>
        <div class="source-counter-track"><div class="source-counter-fill" id="source-counter-fill" style="width: ${fillPct}%"></div></div>
      </div>
      <ul class="research-feed" id="research-feed"></ul>
    </div>
  `;
}

function appendResearchFeed(text, isCurrent) {
  const feed = document.querySelector("#research-feed");
  if (!feed) return;
  feed.querySelectorAll("li.is-current").forEach((el) => el.classList.remove("is-current"));
  const li = document.createElement("li");
  if (isCurrent) li.className = "is-current";
  li.textContent = text;
  feed.appendChild(li);
}

function setSourceCounter(toPct) {
  const fill = document.querySelector("#source-counter-fill");
  const label = document.querySelector("#source-counter-pct");
  if (!fill || !label) return;
  const fromPct = parseFloat(fill.style.width) || 0;
  tween({
    from: fromPct,
    to: toPct,
    duration: 600,
    easing: easeOutCubic,
    key: "source-counter",
    onUpdate: (v) => {
      fill.style.width = v + "%";
      label.textContent = Math.round(v) + "%";
    }
  });
}

function renderPlanContent() {
  const harness = state.data.harness[state.harness];
  const section = state.data.businessPlan[state.activePlan];
  if (!section) return;
  els.planBody.innerHTML = `
    <p><strong>${harness.planPrefix}:</strong> <span id="plan-summary-text">${section.summary}</span></p>
    <ul class="plan-points">
      ${section.points.map((p) => `<li>${p}</li>`).join("")}
    </ul>
  `;
}

function renderPlanStreaming(typeOnSummary) {
  const harness = state.data.harness[state.harness];
  const section = state.data.businessPlan[state.activePlan];
  if (!section) return;
  els.planBody.innerHTML = `
    <p><strong>${harness.planPrefix}:</strong> <span id="plan-summary-text"></span><span class="typewriter-caret" id="plan-caret"></span></p>
    <ul class="plan-points" id="plan-points-streaming"></ul>
  `;
  const target = document.querySelector("#plan-summary-text");
  typewrite(target, section.summary, 36, () => {
    const caret = document.querySelector("#plan-caret");
    if (caret) caret.remove();
    revealPlanPoints(section.points);
  });
}

function revealPlanPoints(points) {
  const list = document.querySelector("#plan-points-streaming");
  if (!list) return;
  points.forEach((point, ix) => {
    setTimeout(() => {
      const li = document.createElement("li");
      li.textContent = point;
      list.appendChild(li);
    }, ix * 140);
  });
}

/* ============================================================
 * Beat queue
 * ============================================================ */

function startRun() {
  if (state.running) return;
  cancelAllTweens();
  clearBeatTimers();
  stopProgressRail();

  state.running = true;
  state.completed = false;
  state.runStartedAt = performance.now();

  els.body.classList.add("is-running");
  els.body.classList.remove("is-run-complete", "is-plan-elevated");
  els.runButton.disabled = true;
  els.runButton.classList.remove("is-rerun");
  els.runLabel.textContent = "Running";
  els.runStatus.textContent = "Running";
  els.consoleDot.classList.add("is-running");
  els.harnessToggle.setAttribute("aria-disabled", "true");
  els.runCompleteBar.hidden = true;
  els.runCompleteBar.classList.remove("is-visible");

  els.console.innerHTML = "";

  const beats = buildBeatList(state.data, state.harness);
  const last = beats[beats.length - 1];
  state.totalRunMs = last ? last.at + 200 : 21200;

  beats.forEach((beat) => {
    const id = window.setTimeout(() => fireBeat(beat), beat.at);
    state.beatTimers.push(id);
  });

  startProgressRail();
}

function buildBeatList(data, harnessId) {
  const h = data.harness[harnessId];

  const beats = [
    /* --- BRIEF --- */
    { at: 0,    kind: "substate",     payload: { stage: "brief", substate: "calling" } },
    { at: 0,    kind: "console",      payload: { stage: "brief", text: h.stages.brief.calling } },
    { at: 400,  kind: "substate",     payload: { stage: "brief", substate: "streaming" } },
    { at: 400,  kind: "scenarioTween" },
    { at: 1100, kind: "console",      payload: { stage: "brief", text: h.stages.brief.streaming } },
    { at: 1600, kind: "substate",     payload: { stage: "brief", substate: "done" } },
    { at: 1600, kind: "console",      payload: { stage: "brief", text: h.stages.brief.done } },
    { at: 1600, kind: "handoff",      payload: { next: "cuopt" } },

    /* --- CUOPT --- */
    { at: 1900, kind: "substate",     payload: { stage: "cuopt", substate: "calling" } },
    { at: 1900, kind: "console",      payload: { stage: "cuopt", text: h.stages.cuopt.calling } },
    { at: 1900, kind: "mapStatus",    payload: { state: "solving" } },
    { at: 1900, kind: "mapRoute",     payload: { action: "shimmer" } },
    { at: 3400, kind: "substate",     payload: { stage: "cuopt", substate: "streaming" } },
    { at: 3400, kind: "mapRoute",     payload: { action: "reveal-active" } },
    { at: 3400, kind: "animateMetrics" },
    { at: 3400, kind: "scoreTween",   payload: { to: 74, duration: 1300 } },
    { at: 3700, kind: "console",      payload: { stage: "cuopt", text: h.stages.cuopt.streaming } },
    { at: 6600, kind: "mapRoute",     payload: { action: "fade-baseline" } },
    { at: 6600, kind: "mapRoute",     payload: { action: "reveal-supports" } },
    { at: 6600, kind: "mapStatus",    payload: { state: "solved" } },
    { at: 6600, kind: "console",      payload: { stage: "cuopt", text: h.stages.cuopt.secondary } },
    { at: 7300, kind: "substate",     payload: { stage: "cuopt", substate: "done" } },
    { at: 7300, kind: "console",      payload: { stage: "cuopt", text: h.stages.cuopt.done } },
    { at: 7300, kind: "handoff",      payload: { next: "vision" } },

    /* --- VISION --- */
    { at: 7600,  kind: "substate",    payload: { stage: "vision", substate: "calling" } },
    { at: 7600,  kind: "console",     payload: { stage: "vision", text: h.stages.vision.calling } },
    { at: 7600,  kind: "visionConfidence", payload: { value: "analyzing", klass: "is-analyzing" } },
    { at: 7600,  kind: "chartPhase",  payload: { phase: "analyzing" } },
    { at: 9000,  kind: "substate",    payload: { stage: "vision", substate: "streaming" } },
    { at: 9000,  kind: "animateChart" },
    { at: 9000,  kind: "scoreTween",  payload: { to: 83, duration: 1200 } },
    { at: 9400,  kind: "console",     payload: { stage: "vision", text: h.stages.vision.streaming } },
    { at: 11000, kind: "visionTypewrite" },
    { at: 11200, kind: "console",     payload: { stage: "vision", text: h.stages.vision.typing } },
    { at: 12500, kind: "visionConfidence", payload: { value: "high confidence" } },
    { at: 12600, kind: "substate",    payload: { stage: "vision", substate: "done" } },
    { at: 12600, kind: "console",     payload: { stage: "vision", text: h.stages.vision.done } },
    { at: 12600, kind: "handoff",     payload: { next: "aiq" } },

    /* --- AIQ --- */
    { at: 12900, kind: "substate",    payload: { stage: "aiq", substate: "calling" } },
    { at: 12900, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.calling } },
    { at: 12900, kind: "researchDepth", payload: { value: "researching", klass: "is-analyzing" } },
    { at: 12900, kind: "planResearching" },
    { at: 14200, kind: "substate",    payload: { stage: "aiq", substate: "streaming" } },
    { at: 14200, kind: "researchFeed", payload: { ix: 0, text: h.stages.aiq.streaming[0], current: true } },
    { at: 14200, kind: "sourceCounter", payload: { to: 28 } },
    { at: 14200, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.streaming[0] } },
    { at: 15000, kind: "researchFeed", payload: { ix: 1, text: h.stages.aiq.streaming[1], current: true } },
    { at: 15000, kind: "sourceCounter", payload: { to: 54 } },
    { at: 15000, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.streaming[1] } },
    { at: 15800, kind: "researchFeed", payload: { ix: 2, text: h.stages.aiq.streaming[2], current: true } },
    { at: 15800, kind: "sourceCounter", payload: { to: 78 } },
    { at: 15800, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.streaming[2] } },
    { at: 16600, kind: "researchFeed", payload: { ix: 3, text: h.stages.aiq.streaming[3], current: true } },
    { at: 16600, kind: "sourceCounter", payload: { to: 100 } },
    { at: 16600, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.streaming[3] } },
    { at: 17500, kind: "elevatePlan" },
    { at: 17500, kind: "scoreTween",  payload: { to: 91, duration: 1400 } },
    { at: 17500, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.elevate } },
    { at: 18200, kind: "planTypewrite" },
    { at: 18400, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.summary } },
    { at: 20800, kind: "researchDepth", payload: { value: "deep research" } },
    { at: 21200, kind: "substate",    payload: { stage: "aiq", substate: "done" } },
    { at: 21200, kind: "console",     payload: { stage: "aiq", text: h.stages.aiq.done } },
    { at: 21200, kind: "completeRun" }
  ];

  return beats;
}

function fireBeat(beat) {
  switch (beat.kind) {
    case "substate":
      setStageSubstate(beat.payload.stage, beat.payload.substate);
      break;
    case "console":
      addConsoleEntry(beat.payload.stage, beat.payload.text);
      break;
    case "handoff":
      triggerHandoffPulse(beat.payload.next);
      break;
    case "mapStatus":
      setMapStatus(beat.payload.state);
      break;
    case "mapRoute":
      applyMapRoute(beat.payload.action);
      break;
    case "scoreTween":
      animateScore(state.currentScore, beat.payload.to, beat.payload.duration);
      break;
    case "scenarioTween":
      animateScenarioLoad();
      break;
    case "animateMetrics":
      animateMetricRows();
      break;
    case "animateChart":
      animateChartBars();
      break;
    case "chartPhase":
      renderChart(beat.payload.phase);
      break;
    case "visionConfidence":
      els.visionConfidence.textContent = beat.payload.value;
      els.visionConfidence.className = "confidence-chip" + (beat.payload.klass ? " " + beat.payload.klass : "");
      break;
    case "visionTypewrite":
      visionTypewriter();
      break;
    case "researchDepth":
      els.researchDepth.textContent = beat.payload.value;
      els.researchDepth.className = "confidence-chip" + (beat.payload.klass ? " " + beat.payload.klass : "");
      break;
    case "planResearching":
      renderPlanResearching(0);
      break;
    case "researchFeed":
      appendResearchFeed(beat.payload.text, beat.payload.current);
      break;
    case "sourceCounter":
      setSourceCounter(beat.payload.to);
      break;
    case "elevatePlan":
      els.body.classList.add("is-plan-elevated");
      break;
    case "planTypewrite":
      renderPlanStreaming(true);
      break;
    case "completeRun":
      finishRun();
      break;
  }
}

/* ============================================================
 * Substates / stage transitions
 * ============================================================ */

function setStageSubstate(stage, substate) {
  state.stageState[stage] = substate;
  if (substate === "calling" || substate === "streaming") {
    state.activeStage = stage;
  }
  if (substate === "done") {
    state.completedStages.add(stage);
  }
  renderStages();
  renderSkillStack();
  renderPlanTabs();
}

function triggerHandoffPulse(nextStage) {
  const pill = document.querySelector(`[data-stage="${nextStage}"]`);
  if (!pill) return;
  pill.classList.remove("is-handoff");
  void pill.offsetWidth;
  pill.classList.add("is-handoff");
  setTimeout(() => pill.classList.remove("is-handoff"), 720);
}

function highlightStagePanel(stage) {
  let panel = null;
  if (stage === "brief" || stage === "cuopt") panel = document.querySelector(".route-panel");
  else if (stage === "vision") panel = document.querySelector(".chart-panel");
  else if (stage === "aiq") panel = document.querySelector(".plan-panel");
  if (!panel) return;
  panel.classList.add("is-highlight");
  setTimeout(() => panel.classList.remove("is-highlight"), 800);
}

/* ============================================================
 * Map state
 * ============================================================ */

function setMapStatus(name) {
  const status = state.data.mapStatus;
  els.mapStatus.classList.remove("is-baseline", "is-solving", "is-solved");
  els.mapStatus.classList.add("is-" + name);
  els.mapStatusText.textContent = status[name];
}

function applyMapRoute(action) {
  switch (action) {
    case "shimmer":
      els.baselineRoute.classList.add("is-solving");
      break;
    case "reveal-active":
      els.activeRoute.classList.add("is-solved");
      els.baselineRoute.classList.remove("is-solving");
      break;
    case "fade-baseline":
      els.baselineRoute.classList.add("is-faded");
      break;
    case "reveal-supports":
      els.feederRoute.classList.add("is-revealed");
      els.portRoute.classList.add("is-revealed");
      break;
  }
}

/* ============================================================
 * Numeric animations
 * ============================================================ */

function animateScore(from, to, duration = 1000) {
  tween({
    from,
    to,
    duration,
    easing: easeOutCubic,
    key: "route-score",
    onUpdate: (v) => {
      const rounded = Math.round(v);
      state.currentScore = rounded;
      els.routeScoreValue.textContent = String(rounded);
    },
    onComplete: () => {
      state.currentScore = to;
      els.routeScoreValue.textContent = String(to);
      if (to >= state.optimizedScore - 1) {
        els.routeScoreLabel.textContent = state.data.scoreContext.optimizedLabel;
      } else if (to > state.baselineScore + 5) {
        els.routeScoreLabel.textContent = "in-flight";
      }
    }
  });
}

function animateScenarioLoad() {
  const sc = state.data.scenarioLoad;
  tween({
    from: 0,
    to: sc.total,
    duration: 1000,
    easing: easeOutCubic,
    key: "scenario-load",
    onUpdate: (v) => {
      const n = Math.round(v);
      els.scenarioLoad.textContent = n.toLocaleString() + " " + sc.unit;
    },
    onComplete: () => {
      els.scenarioLoad.textContent = sc.display;
    }
  });
}

function animateMetricRows() {
  const baseline = state.data.metrics.baseline;
  const optimized = state.data.metrics.optimized;
  const max = Math.max(...optimized.map((m) => m.max));

  els.metricBars.classList.remove("is-baseline");
  els.metricBars.classList.add("is-optimized");
  els.metricsEyebrow.textContent = "Optimized";

  const rows = els.metricBars.querySelectorAll(".metric-row");
  rows.forEach((row, ix) => {
    const fromMetric = baseline[ix];
    const toMetric = optimized[ix];
    const fromValue = parseMetricNumeric(fromMetric.display);
    const toValue = parseMetricNumeric(toMetric.display);
    const fromWidth = (fromMetric.value / max) * 100;
    const toWidth = (toMetric.value / max) * 100;
    const fill = row.querySelector(".bar-fill");
    const displayEl = row.querySelector("strong");

    setTimeout(() => {
      tween({
        from: fromWidth,
        to: toWidth,
        duration: 950,
        easing: easeOutCubic,
        key: `metric-bar-${ix}`,
        onUpdate: (v) => {
          fill.style.width = v + "%";
        }
      });
      tween({
        from: fromValue,
        to: toValue,
        duration: 950,
        easing: easeOutCubic,
        key: `metric-value-${ix}`,
        onUpdate: (v) => {
          displayEl.textContent = formatMetricValue(fromMetric.label, v);
        },
        onComplete: () => {
          displayEl.textContent = toMetric.display;
        }
      });
    }, ix * 220);
  });
}

function animateChartBars() {
  const baseline = state.data.capacity.baseline;
  const optimized = state.data.capacity.optimized;

  els.miniChart.classList.remove("is-baseline", "is-analyzing");
  els.miniChart.classList.add("is-optimized");

  const bars = els.miniChart.querySelectorAll(".chart-bar");
  bars.forEach((bar, ix) => {
    const fromVal = baseline[ix].value;
    const toVal = optimized[ix].value;
    setTimeout(() => {
      bar.classList.toggle("is-hot", toVal > 84);
      tween({
        from: Math.max(8, fromVal),
        to: Math.max(8, toVal),
        duration: 1100,
        easing: easeOutCubic,
        key: `chart-bar-${ix}`,
        onUpdate: (v) => {
          bar.style.setProperty("--height", v + "%");
        }
      });
    }, ix * 90);
  });
}

function parseMetricNumeric(display) {
  const match = String(display).match(/-?[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function formatMetricValue(label, value) {
  const lower = label.toLowerCase();
  if (lower.includes("cost")) return "$" + value.toFixed(1) + "M";
  if (lower.includes("cycle")) return value.toFixed(1) + " days";
  if (lower.includes("lots")) return Math.round(value) + " lots";
  if (lower.includes("pressure") || lower.includes("capacity")) return Math.round(value) + "%";
  return value.toFixed(1);
}

/* ============================================================
 * Typewriter
 * ============================================================ */

function typewrite(el, text, charsPerSec = 32, onDone) {
  if (state.typewriterTimer) {
    window.clearInterval(state.typewriterTimer);
    state.typewriterTimer = null;
  }
  if (REDUCED_MOTION) {
    el.textContent = text;
    if (onDone) onDone();
    return { cancel() {} };
  }
  const interval = Math.max(8, 1000 / charsPerSec);
  el.textContent = "";
  let i = 0;
  state.typewriterTimer = window.setInterval(() => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i >= text.length) {
      window.clearInterval(state.typewriterTimer);
      state.typewriterTimer = null;
      if (onDone) onDone();
    }
  }, interval);
  return {
    cancel(revealAll = true) {
      if (state.typewriterTimer) {
        window.clearInterval(state.typewriterTimer);
        state.typewriterTimer = null;
      }
      if (revealAll) {
        el.textContent = text;
        if (onDone) onDone();
      }
    }
  };
}

function visionTypewriter() {
  const text = state.data.insights.vision[state.harness];
  els.visionCopy.textContent = "";
  typewrite(els.visionCopy, text, 28);
}

/* ============================================================
 * Progress rail
 * ============================================================ */

function startProgressRail() {
  stopProgressRail();
  if (REDUCED_MOTION) {
    els.progressFill.style.width = "100%";
    return;
  }
  state.progressFillTimer = window.setInterval(() => {
    if (!state.runStartedAt) return;
    const elapsed = performance.now() - state.runStartedAt;
    const pct = Math.min(100, (elapsed / state.totalRunMs) * 100);
    els.progressFill.style.width = pct + "%";
    if (pct >= 100) {
      stopProgressRail();
    }
  }, 60);
}

function stopProgressRail() {
  if (state.progressFillTimer) {
    window.clearInterval(state.progressFillTimer);
    state.progressFillTimer = null;
  }
}

/* ============================================================
 * Console
 * ============================================================ */

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

/* ============================================================
 * Closing
 * ============================================================ */

function finishRun() {
  state.running = false;
  state.completed = true;
  const elapsedSec = ((performance.now() - state.runStartedAt) / 1000).toFixed(1);

  els.body.classList.remove("is-running");
  els.body.classList.add("is-run-complete");
  els.consoleDot.classList.remove("is-running");
  els.runButton.disabled = false;
  els.runButton.classList.add("is-rerun");
  els.runLabel.textContent = "Re-run";
  els.runStatus.textContent = `Complete · ${elapsedSec}s`;
  els.harnessToggle.removeAttribute("aria-disabled");
  els.progressFill.style.width = "100%";

  els.routeScoreDelta.hidden = false;
  els.routeScoreDelta.textContent = state.data.scoreContext.deltaLabel.split(" ")[0];

  els.runCompleteEyebrow.textContent = `${state.data.closing.eyebrow} · ${elapsedSec}s`;
  els.runCompleteBar.hidden = false;
  requestAnimationFrame(() => {
    els.runCompleteBar.classList.add("is-visible");
  });
  els.ctaReview.textContent = state.data.closing.ctaPrimary;
  els.ctaRerun.textContent = state.data.closing.ctaSecondary;

  // Make sure final plan content is rendered (in case typewriter was mid-stream)
  setTimeout(() => {
    if (state.stageState.aiq === "done" && !document.querySelector(".plan-points li:nth-child(3)")) {
      renderPlanContent();
    }
  }, 100);

  triggerTabWave();
  stopProgressRail();
}

function triggerTabWave() {
  els.planTabs.classList.remove("is-wave");
  void els.planTabs.offsetWidth;
  els.planTabs.classList.add("is-wave");
  setTimeout(() => els.planTabs.classList.remove("is-wave"), 900);
}

/* ============================================================
 * Reset / harness toggle
 * ============================================================ */

function clearBeatTimers() {
  state.beatTimers.forEach((id) => window.clearTimeout(id));
  state.beatTimers = [];
}

function resetRun() {
  clearBeatTimers();
  cancelAllTweens();
  stopProgressRail();
  if (state.typewriterTimer) {
    window.clearInterval(state.typewriterTimer);
    state.typewriterTimer = null;
  }
  state.running = false;
  state.completed = false;
  state.currentScore = state.baselineScore;
  state.runStartedAt = null;

  applyIdleState();
  renderMetrics("baseline");
  renderChart("baseline");
}

function setHarness(harness) {
  if (!harness || harness === state.harness) return;
  if (state.running) return;
  state.harness = harness;
  els.body.dataset.harness = harness;
  renderHarness();
  if (state.stageState.aiq === "done") {
    renderPlanContent();
  } else if (state.stageState.aiq === "calling" || state.stageState.aiq === "streaming") {
    /* keep streaming state */
  }
}

/* ============================================================
 * Boot
 * ============================================================ */

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="app-shell"><section class="panel"><div class="panel-heading"><h1>Demo failed to load</h1></div><p class="insight-copy">${error.message}</p></section></main>`;
});
