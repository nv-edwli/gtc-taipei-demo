const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SAMPLE_IMAGE_PATH = "/home/nvidia/gtc-taipei-demo/data/sample-capacity.png";
const PROMPT_STORAGE_KEY = "gtc-taipei-prompt-draft";

const state = {
  data: null,
  harness: "codex",
  activeStage: "brief",
  activePlan: "strategy",
  running: false,
  completed: false,
  completedStages: new Set(),
  stageState: { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" },
  activeTweens: new Map(),
  typewriterTimer: null,
  progressFillTimer: null,
  runStartedAt: null,
  totalRunMs: 0,
  baselineScore: 41,
  optimizedScore: 91,
  currentScore: 41,

  // Live wiring
  runId: null,
  abortController: null,
  surface: null,                 // "sandbox" | "host" | "unknown"
  sandboxStatus: null,           // { reachable, reason }
  attachedImagePath: null,
  attachedImageLabel: null,
  attachedImageState: "sample",  // "sample" | "upload" | "none"
  policyText: null,
  policyDrawerOpen: false,
  planModalOpen: false,
  planModalAutoShown: false,
  visionTextAccumulator: "",
  planTextAccumulator: "",
  planSections: null,
  aiqJobId: null,
  hasInitializedVisionTypewriter: false
};

const els = {};
const toastTimers = new Map();

const stageOrder = ["brief", "cuopt", "vision", "aiq"];

/* ============================================================
 * Easing + tween primitives
 * ============================================================ */

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

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
  for (const handle of state.activeTweens.values()) handle.cancel(false);
  state.activeTweens.clear();
}

/* ============================================================
 * Boot
 * ============================================================ */

async function boot() {
  state.data = await loadDemoData();
  state.baselineScore = state.data.scoreContext.baseline;
  state.optimizedScore = state.data.scoreContext.optimized;
  state.currentScore = state.baselineScore;

  collectEls();
  wireEvents();

  state.attachedImagePath = (state.data.sample && state.data.sample.imagePath) || SAMPLE_IMAGE_PATH;
  state.attachedImageLabel = (state.data.sample && state.data.sample.imageLabel) || "sample-capacity.png";
  state.attachedImageState = "sample";

  await loadDefaultPrompt();
  const stored = (typeof sessionStorage !== "undefined") && sessionStorage.getItem(PROMPT_STORAGE_KEY);
  if (stored) els.promptInput.value = stored;

  renderAll();
  applyIdleState();

  loadSandboxStatus();
}

async function loadDemoData() {
  const response = await fetch("./data/supply-chain.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load demo data: ${response.status}`);
  return response.json();
}

async function loadDefaultPrompt() {
  try {
    const r = await fetch("/data/default-prompt.txt", { cache: "no-store" });
    if (r.ok) {
      const text = await r.text();
      if (els.promptInput && !els.promptInput.value.trim()) {
        els.promptInput.value = text.trim();
      }
    }
  } catch (_) { /* keep placeholder */ }
}

async function loadSandboxStatus() {
  try {
    const r = await fetch("/api/sandbox/status", { cache: "no-store" });
    if (!r.ok) throw new Error("status " + r.status);
    const data = await r.json();
    updateSandboxChip(data.surface, data.sandboxReachable, data.reason);
  } catch (err) {
    updateSandboxChip("unknown", null, err.message);
  }
}

/* ============================================================
 * DOM refs + events
 * ============================================================ */

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
  els.progressRail = document.querySelector(".workspace-progress-rail");
  els.progressFill = document.querySelector("#progress-rail-fill");
  els.runCompleteBar = document.querySelector("#run-complete-bar");
  els.runCompleteEyebrow = document.querySelector("#run-complete-eyebrow");
  els.runCompleteSummary = document.querySelector("#run-complete-summary");
  els.ctaReview = document.querySelector("#cta-review");
  els.ctaRerun = document.querySelector("#cta-rerun");

  els.promptInput = document.querySelector("#prompt-input");
  els.promptAttached = document.querySelector("#prompt-attached");
  els.promptAttachedName = document.querySelector("#prompt-attached-name");
  els.promptAttachedClear = document.querySelector("#prompt-attached-clear");
  els.promptAttachInput = document.querySelector("#prompt-attach-input");
  els.promptResetSample = document.querySelector("#prompt-reset-sample");
  els.promptError = document.querySelector("#prompt-error");

  els.sandboxChip = document.querySelector("#sandbox-chip");
  els.sandboxChipText = document.querySelector("#sandbox-chip-text");

  els.policyDrawer = document.querySelector("#policy-drawer");
  els.policyDrawerContent = document.querySelector("#policy-drawer-content");
  els.policyDrawerBackdrop = document.querySelector("#policy-drawer-backdrop");
  els.policyDrawerClose = document.querySelector("#policy-drawer-close");

  els.planExpand = document.querySelector("#plan-expand");
  els.planModal = document.querySelector("#plan-modal");
  els.planModalBackdrop = document.querySelector("#plan-modal-backdrop");
  els.planModalBody = document.querySelector("#plan-modal-body");
  els.planModalClose = document.querySelector("#plan-modal-close");
  els.planModalChip = document.querySelector("#plan-modal-chip");

  els.toastStack = document.querySelector("#toast-stack");
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
      renderPlanLive();
    });
  });

  els.runButton.addEventListener("click", () => {
    if (state.running) return;
    if (state.completed) {
      resetRun().then(() => requestAnimationFrame(() => startRun()));
    } else {
      startRun();
    }
  });

  els.resetButton.addEventListener("click", () => { resetRun(); });

  els.ctaRerun.addEventListener("click", () => {
    resetRun().then(() => requestAnimationFrame(() => startRun()));
  });

  els.ctaReview.addEventListener("click", () => {
    if (state.planTextAccumulator) {
      openPlanModal();
    } else {
      const plan = document.querySelector(".plan-panel");
      if (plan && typeof plan.scrollIntoView === "function") {
        plan.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      triggerTabWave();
    }
  });

  els.planExpand.addEventListener("click", () => {
    if (els.planExpand.disabled) return;
    openPlanModal();
  });

  els.planModalClose.addEventListener("click", () => closePlanModal());
  els.planModalBackdrop.addEventListener("click", () => closePlanModal());

  // Prompt
  els.promptInput.addEventListener("input", () => {
    try { sessionStorage.setItem(PROMPT_STORAGE_KEY, els.promptInput.value); } catch (_) {}
    clearPromptError();
  });

  els.promptAttachInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await attachImage(file);
    e.target.value = "";  // reset so the same file can be re-selected
  });

  els.promptResetSample.addEventListener("click", () => resetSampleImage());

  els.promptAttachedClear.addEventListener("click", () => {
    if (state.attachedImageState === "sample") {
      detachImage();
    } else {
      resetSampleImage();
    }
  });

  // Sandbox chip + policy drawer
  els.sandboxChip.addEventListener("click", () => openPolicyDrawer());
  els.policyDrawerClose.addEventListener("click", () => closePolicyDrawer());
  els.policyDrawerBackdrop.addEventListener("click", () => closePolicyDrawer());
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.planModalOpen) closePlanModal();
    else if (state.policyDrawerOpen) closePolicyDrawer();
  });
}

/* ============================================================
 * Render — idle + general
 * ============================================================ */

function renderAll() {
  renderHarness();
  renderStages();
  renderSkillStack();
  renderMetrics("baseline");
  renderChart("baseline");
  renderPlanTabs();
  renderPlan();
  renderAttachedChip();
}

function applyIdleState() {
  els.body.classList.remove("is-running", "is-run-complete");
  closePlanModal(true);
  els.runButton.classList.remove("is-rerun", "is-running");
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
  els.progressRail.classList.remove("is-indeterminate");
  els.progressFill.style.width = "0%";
  els.progressFill.style.marginLeft = "";
  els.runCompleteBar.hidden = true;
  els.runCompleteBar.classList.remove("is-visible");
  els.metricsEyebrow.textContent = "Baseline today";

  state.currentScore = state.baselineScore;
  state.completedStages = new Set();
  state.stageState = { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" };
  state.activeStage = "brief";
  state.activePlan = "strategy";
  state.completed = false;
  state.runId = null;
  state.visionTextAccumulator = "";
  state.planTextAccumulator = "";
  state.planSections = null;
  state.aiqJobId = null;
  state.hasInitializedVisionTypewriter = false;
  state.planModalAutoShown = false;
  if (els.planExpand) els.planExpand.disabled = true;

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
    button.classList.toggle("is-skipped", sub === "skipped");
  });
}

function renderSkillStack() {
  els.skillStack.innerHTML = state.data.skills.map((skill) => {
    const sub = state.stageState[skill.stage];
    const isRunning = sub === "calling" || sub === "streaming";
    const isDone = sub === "done";
    const isSkipped = sub === "skipped";
    let stateLabel = "queued";
    if (sub === "calling") stateLabel = "calling";
    else if (sub === "streaming") stateLabel = "streaming";
    else if (isDone) stateLabel = "ready";
    else if (isSkipped) stateLabel = "skipped";
    return `
      <article class="skill-item ${isRunning ? "is-running" : ""} ${isDone ? "is-done" : ""} ${isSkipped ? "is-skipped" : ""}">
        <span class="skill-icon" aria-hidden="true">${escapeHtml(skill.icon)}</span>
        <span>
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <span class="skill-detail">${escapeHtml(skill.detail)}</span>
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
  const max = Math.max(...optimized.map((m) => m.max));

  els.metricBars.classList.toggle("is-baseline", phase === "baseline");
  els.metricBars.classList.toggle("is-optimized", phase === "optimized");
  els.metricsEyebrow.textContent = isOptimized ? "Optimized" : "Baseline today";

  els.metricBars.innerHTML = source.map((metric, ix) => {
    const optimizedMetric = optimized[ix];
    const width = Math.round((metric.value / max) * 100);
    const deltaChip = optimizedMetric.delta
      ? `<span class="metric-delta">${escapeHtml(optimizedMetric.delta)}</span>`
      : "";
    return `
      <div class="metric-row" data-row="${ix}">
        <div class="metric-label">
          <div class="metric-label-row">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.display)}</strong>
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
        <span>${escapeHtml(item.label)}</span>
      </div>
    `;
  }).join("");
}

function renderPlanTabs() {
  const aiqDone = state.stageState.aiq === "done";
  const sectionsAvailable = state.planSections ? new Set(Object.keys(state.planSections)) : null;
  document.querySelectorAll("[data-plan]").forEach((button) => {
    const key = button.dataset.plan;
    const isActive = key === state.activePlan;
    const isAvailable = !sectionsAvailable || sectionsAvailable.has(key);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    if (aiqDone && isAvailable) {
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
  if (sub === "streaming") return renderPlanLive();
  if (sub === "done") return renderPlanLive();
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
        <span class="researching-title">${escapeHtml(harness.name)} streaming AIQ Research…</span>
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

function buildPlanBodyHtml() {
  const harness = state.data.harness[state.harness];
  const prefix = harness.planPrefix || (capitalize(state.harness) + " synthesis");

  let body;
  if (state.planSections && state.planSections[state.activePlan]) {
    body = formatPlanText(state.planSections[state.activePlan]);
  } else if (state.planSections) {
    body = `
      <p class="plan-no-section">No content for <strong>${escapeHtml(state.activePlan)}</strong>. Try:</p>
      <div class="plan-sections-jump">
        ${Object.keys(state.planSections).map(k => `<button class="ghost-action" type="button" data-jump="${escapeHtml(k)}">${escapeHtml(capitalize(k))}</button>`).join("")}
      </div>
      <hr style="border:0;border-top:1px solid var(--border);margin:14px 0;">
      <details><summary>Show all sections</summary>${formatPlanText(state.planTextAccumulator)}</details>
    `;
  } else {
    body = formatPlanText(state.planTextAccumulator);
  }

  return `
    <p class="plan-prefix"><strong>${escapeHtml(prefix)}:</strong></p>
    <div class="plan-live-body">${body}</div>
  `;
}

function wirePlanJumpButtons(scope) {
  scope.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePlan = btn.dataset.jump;
      renderPlanTabs();
      renderPlanLive();
    });
  });
}

function renderPlanLive() {
  if (!state.planTextAccumulator) {
    renderPlanSkeleton();
    return;
  }
  const html = buildPlanBodyHtml();
  els.planBody.innerHTML = html;
  wirePlanJumpButtons(els.planBody);
  if (els.planModalBody) {
    els.planModalBody.innerHTML = html;
    wirePlanJumpButtons(els.planModalBody);
  }
}

function formatPlanText(text) {
  if (!text) return "";
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => "<p>" + para.replace(/\n/g, "<br>") + "</p>")
    .join("");
}

function parsePlanSections(text) {
  const sectionRegex = /(?:^|\n)\s*(?:#{1,3}\s+|\*\*\s*)?(strategy|market(?:\s+analysis)?|risk(?:s)?(?:\s+(?:analysis|register))?|execution(?:\s+plan)?)\s*(?:\*\*)?\s*[:\n-]+/gi;
  const matches = [];
  let m;
  while ((m = sectionRegex.exec(text)) !== null) {
    matches.push({ key: normalizeSectionKey(m[1]), index: m.index, headerLen: m[0].length });
  }
  if (matches.length < 2) return null;
  const sections = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const start = cur.index + cur.headerLen;
    const end = next ? next.index : text.length;
    const body = text.slice(start, end).trim();
    if (body) sections[cur.key] = body;
  }
  return Object.keys(sections).length >= 2 ? sections : null;
}

function normalizeSectionKey(raw) {
  const lower = raw.toLowerCase();
  if (lower.startsWith("strategy")) return "strategy";
  if (lower.startsWith("market")) return "market";
  if (lower.startsWith("risk")) return "risk";
  if (lower.startsWith("execution")) return "execution";
  return lower;
}

/* ============================================================
 * Stream consumption
 * ============================================================ */

async function startRun() {
  if (state.running) return;
  const prompt = (els.promptInput.value || "").trim();
  if (!prompt) {
    setPromptError("Add a research brief before running.");
    return;
  }
  if (prompt.length > 32 * 1024) {
    setPromptError("Prompt is too long (max 32 KB).");
    return;
  }
  clearPromptError();

  cancelAllTweens();
  stopProgressRail();
  applyRunIdleSlate();

  state.running = true;
  state.completed = false;
  state.runStartedAt = performance.now();

  els.body.classList.add("is-running");
  els.body.classList.remove("is-run-complete");
  els.runButton.disabled = true;
  els.runButton.classList.remove("is-rerun");
  els.runButton.classList.add("is-running");
  els.runLabel.textContent = "Running";
  els.runStatus.textContent = "Starting…";
  els.consoleDot.classList.add("is-running");
  els.harnessToggle.setAttribute("aria-disabled", "true");
  els.runCompleteBar.hidden = true;
  els.runCompleteBar.classList.remove("is-visible");

  startIndeterminateProgressRail();
  state.abortController = new AbortController();

  let response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: state.harness,
        prompt,
        imagePath: state.attachedImagePath || null
      }),
      signal: state.abortController.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") return finishRunCancelled();
    return handleStreamError("connect: " + (err && err.message));
  }

  if (!response.ok) {
    let detail = `server returned ${response.status}`;
    try { const t = await response.text(); detail += " — " + t.slice(0, 200); } catch (_) {}
    return handleStreamError(detail);
  }

  try {
    await consumeNdjson(response.body, (beat) => fireBeat(beat));
  } catch (err) {
    if (err && err.name === "AbortError") return finishRunCancelled();
    return handleStreamError("stream: " + (err && err.message));
  }

  if (state.running) {
    fireBeat({ kind: "run.completed", data: { exitCode: 0, durationMs: performance.now() - state.runStartedAt } });
  }
}

function applyRunIdleSlate() {
  els.console.innerHTML = "";
  state.visionTextAccumulator = "";
  state.planTextAccumulator = "";
  state.planSections = null;
  state.aiqJobId = null;
  state.hasInitializedVisionTypewriter = false;
  state.planModalAutoShown = false;
  if (els.planExpand) els.planExpand.disabled = true;
  closePlanModal(true);
  state.stageState = { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" };
  state.completedStages = new Set();
  state.currentScore = state.baselineScore;
  els.routeScoreValue.textContent = String(state.baselineScore);
  els.routeScoreLabel.textContent = state.data.scoreContext.baselineLabel;
  els.routeScoreDelta.hidden = true;
  els.visionConfidence.textContent = "standby";
  els.visionConfidence.className = "confidence-chip is-quiet";
  els.visionCopy.textContent = "Awaiting Nemotron Omni readout on optimized utilization.";
  els.researchDepth.textContent = "queued";
  els.researchDepth.className = "confidence-chip is-quiet";
  renderStages();
  renderSkillStack();
  renderPlanSkeleton();
}

async function consumeNdjson(stream, callback) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = buffer.trim();
        if (tail) {
          try { callback(JSON.parse(tail)); } catch (_) {}
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          callback(JSON.parse(line));
        } catch (err) {
          console.warn("malformed beat:", line.slice(0, 200));
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

/* ============================================================
 * Beat dispatcher
 * ============================================================ */

function fireBeat(beat) {
  if (!beat || !beat.kind) return;
  switch (beat.kind) {
    case "run.registered":
      state.runId = beat.data && beat.data.runId;
      if (beat.data && beat.data.surface) updateSandboxChip(beat.data.surface, beat.data.surface === "sandbox", null);
      addConsoleEntry("general", `Run registered · ${beat.data.runId.slice(0, 8)} · ${beat.data.surface}`);
      break;
    case "run.started":
      els.runStatus.textContent = "Running";
      addConsoleEntry("general",
        `${capitalize(beat.data.harness || state.harness)} session ${(beat.data.sessionId || "").slice(0, 8) || "(no id)"} started` +
        (beat.data.model ? ` · ${beat.data.model}` : "")
      );
      break;
    case "surface.info":
      updateSandboxChip(beat.data.surface, beat.data.sandboxReachable, beat.data.reason);
      addConsoleEntry("general",
        `Executing on ${beat.data.surface === "sandbox" ? "openshell sandbox" : "host"}` +
        (beat.data.reason ? ` · ${beat.data.reason}` : "")
      );
      break;
    case "assistant.text":
      handleAssistantText(beat.data || {});
      break;
    case "tool.invoked":
      handleToolInvoked(beat.data || {});
      break;
    case "tool.completed":
      handleToolCompleted(beat.data || {});
      break;
    case "stage.skipped":
      setStageSubstateSkipped(beat.data && beat.data.stage);
      break;
    case "run.completed":
      finishRun(beat.data || {});
      break;
    case "run.failed":
      failRun(beat.data || {});
      break;
    case "run.cancelled":
      finishRunCancelled();
      break;
    case "log":
      handleLogBeat(beat.data || {});
      break;
    default:
      // unknown beat
      console.warn("unknown beat:", beat.kind);
  }
}

function handleAssistantText({ stage, text }) {
  if (!text) return;
  if (stage === "vision") {
    setStageSubstate("vision", "streaming");
    state.visionTextAccumulator = appendText(state.visionTextAccumulator, text);
    updateVisionCopy(state.visionTextAccumulator);
    addConsoleEntry("vision", truncate(text, 240));
  } else if (stage === "aiq") {
    setStageSubstate("aiq", "streaming");
    state.planTextAccumulator = appendText(state.planTextAccumulator, text);
    state.planSections = parsePlanSections(state.planTextAccumulator);
    renderPlanLive();
    renderPlanTabs();
    addConsoleEntry("aiq", truncate(text, 240));
  } else {
    addConsoleEntry("general", truncate(text, 400));
  }
}

function handleToolInvoked({ id, name, input, stage }) {
  if (stage === "vision") {
    setStageSubstate("vision", "calling");
    els.visionConfidence.textContent = "analyzing";
    els.visionConfidence.className = "confidence-chip is-analyzing";
    els.miniChart.classList.add("is-analyzing");
  } else if (stage === "aiq") {
    setStageSubstate("aiq", "calling");
    els.researchDepth.textContent = "researching";
    els.researchDepth.className = "confidence-chip is-analyzing";
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
  } else if (state.stageState.cuopt === "idle" && stage === "general") {
    /* leave cuopt idle for skipping later */
  }
  renderToolEntry({ id, name, stage, input, status: "running" });
}

function handleToolCompleted({ id, name, stage, stdout, stderr, isError, durationMs }) {
  updateToolEntry({ id, status: isError ? "error" : "done", stdout, stderr, durationMs });

  if (isError) {
    addConsoleEntry(stage || "general", `Tool ${name || ""} failed · expand entry for stderr.`);
  }

  if (stage === "vision" && !isError) {
    const cleaned = (stdout || "").trim();
    if (cleaned) {
      const summary = extractVisionSummary(cleaned);
      state.visionTextAccumulator = summary;
      updateVisionCopy(summary);
    }
    els.visionConfidence.textContent = "high confidence";
    els.visionConfidence.className = "confidence-chip";
    els.miniChart.classList.remove("is-analyzing");
    els.miniChart.classList.add("is-optimized");
    animateChartBars();
    setStageSubstate("vision", "done");
    const newScore = Math.min(state.optimizedScore - 8, state.baselineScore + 35);
    if (newScore > state.currentScore) animateScore(state.currentScore, newScore, 1200);
  }

  if (stage === "aiq" && !isError) {
    parseAiqToolOutput(stdout || "", name);
  }
}

function parseAiqToolOutput(stdout, _name) {
  // Detect deep_research_running job start
  const drMatch = stdout.match(/"status"\s*:\s*"deep_research_running"[^}]*?"job_id"\s*:\s*"([^"]+)"/);
  if (drMatch) {
    state.aiqJobId = drMatch[1];
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
    appendResearchFeed("Deep research job started · " + state.aiqJobId.slice(0, 8), true);
    setSourceCounter(15);
    return;
  }

  // Status update
  const statusMatch = stdout.match(/"status"\s*:\s*"(running|completed|success|failed|failure|cancelled|TIMEOUT)"/i);
  if (statusMatch && state.aiqJobId) {
    const status = statusMatch[1].toLowerCase();
    appendResearchFeed(`Job ${state.aiqJobId.slice(0, 8)} · ${status}`, true);
    if (status === "running") {
      const fill = document.querySelector("#source-counter-fill");
      const cur = fill ? parseFloat(fill.style.width) || 0 : 0;
      setSourceCounter(Math.min(95, cur + 20));
    } else if (status === "completed" || status === "success") {
      setSourceCounter(100);
    }
  }

  // Final content
  const contentMatch = stdout.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (contentMatch) {
    const decoded = jsonStringDecode(contentMatch[1]);
    if (decoded.length > 80) {
      state.planTextAccumulator = decoded;
      state.planSections = parsePlanSections(decoded);
      renderPlanLive();
      renderPlanTabs();
      setSourceCounter(100);
      const newScore = Math.min(state.optimizedScore, state.currentScore + 12);
      if (newScore > state.currentScore) animateScore(state.currentScore, newScore, 1100);
    }
    return;
  }

  // Detect need_browser_login
  if (stdout.includes("need_browser_login")) {
    showToast("error", "AIQ auth required — run `python3 skills/aiq-research/scripts/aiq.py login` on the host.");
    addConsoleEntry("aiq", "AIQ auth needed: agent reported need_browser_login.");
  }
}

function extractVisionSummary(text) {
  if (!text) return "";
  const sectionRegex = /#{1,3}\s*(Observations?|Insights?|Summary|TL;DR|Conclusion)\s*\n([\s\S]*?)(?=\n#{1,3}\s|\n\*\*[A-Z]|$)/i;
  const m = text.match(sectionRegex);
  if (m && m[2].trim().length > 40) {
    return collapseMarkdown(m[2]).slice(0, 700);
  }
  // Fallback: first ~400 chars of prose-looking lines
  const lines = text.split(/\n+/).filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith("|")) return false;     // table
    if (t.startsWith("#")) return false;     // heading
    if (t.startsWith("**") && t.endsWith("**")) return false;  // bold heading
    return true;
  });
  return collapseMarkdown(lines.join(" ")).slice(0, 500);
}

function collapseMarkdown(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[\s\-*]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonStringDecode(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function updateVisionCopy(text) {
  if (!text) return;
  const trimmed = text.trim();
  if (REDUCED_MOTION || state.hasInitializedVisionTypewriter) {
    els.visionCopy.textContent = trimmed;
  } else {
    state.hasInitializedVisionTypewriter = true;
    typewrite(els.visionCopy, trimmed, 40);
  }
}

function handleLogBeat({ level, text }) {
  if (level === "debug") return;
  const prefix = level === "warn" ? "⚠" : level === "stderr" ? "stderr" : level || "info";
  addConsoleEntry("general", `[${prefix}] ${text || ""}`.slice(0, 400));
}

/* ============================================================
 * Tool console entries
 * ============================================================ */

function summarizeToolInput(name, input) {
  if (!input) return "";
  if (typeof input === "string") return truncate(input, 200);
  const n = (name || "").toLowerCase();
  if (n === "bash") return truncate((input.command || "").split("\n")[0], 240);
  if (n === "read" || n === "read_file") return truncate(input.file_path || input.path || "", 240);
  if (n === "write" || n === "write_file") return truncate((input.file_path || input.path || "") + " (write)", 240);
  if (n === "edit" || n === "edit_file") return truncate((input.file_path || input.path || "") + " (edit)", 240);
  const json = (() => { try { return JSON.stringify(input); } catch (_) { return "(unstringifiable)"; } })();
  return truncate(json, 240);
}

function renderToolEntry({ id, name, stage, input, status }) {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const li = document.createElement("li");
  li.className = "tool-entry";
  li.dataset.toolId = id || ("tu_" + Math.random().toString(36).slice(2, 8));
  li.dataset.status = status;
  const inputPreview = summarizeToolInput(name, input);
  li.innerHTML = `
    <time>${stamp}</time>
    <div>
      <div class="tool-meta">
        <span class="tool-pip" aria-hidden="true">${statusPipChar(status)}</span>
        <span class="tool-name">${escapeHtml(name || "tool")}</span>
        <span class="tool-stage" data-stage="${escapeHtml(stage || "general")}">${escapeHtml(stage || "general")}</span>
      </div>
      <pre class="tool-preview">${escapeHtml(inputPreview || "(no input)")}</pre>
    </div>
  `;
  els.console.prepend(li);
}

function updateToolEntry({ id, status, stdout, stderr, durationMs }) {
  const sel = `.tool-entry[data-tool-id="${cssEscape(id)}"]`;
  const li = els.console.querySelector(sel);
  if (!li) return;
  li.dataset.status = status;
  const pip = li.querySelector(".tool-pip");
  if (pip) pip.textContent = statusPipChar(status);

  const preview = li.querySelector(".tool-preview");
  if (preview) {
    let text = "";
    if (stdout && stdout.trim()) text += stdout.trim();
    if (stderr && stderr.trim()) text += (text ? "\n--- stderr ---\n" : "") + stderr.trim();
    if (!text) text = status === "error" ? "(error · no output)" : "(no output)";
    preview.textContent = text;

    const innerWrap = li.querySelector("div > div");
    if (innerWrap && text.length > 200 && !li.querySelector(".tool-toggle")) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tool-toggle";
      toggle.textContent = "Show full output";
      toggle.addEventListener("click", () => {
        const expanded = li.classList.toggle("is-expanded");
        toggle.textContent = expanded ? "Collapse" : "Show full output";
      });
      innerWrap.parentNode.appendChild(toggle);
    }
  }

  if (typeof durationMs === "number") {
    const meta = li.querySelector(".tool-meta");
    if (meta && !meta.querySelector(".tool-duration")) {
      const dur = document.createElement("span");
      dur.className = "tool-duration";
      dur.textContent = formatDuration(durationMs);
      dur.style.cssText = "margin-left:6px;color:var(--muted);font-size:0.7rem;font-weight:700;";
      meta.appendChild(dur);
    }
  }
}

function statusPipChar(status) {
  if (status === "running") return "•";
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "?";
}

function formatDuration(ms) {
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
}

/* ============================================================
 * Stage substates + map + animation
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

function setStageSubstateSkipped(stage) {
  if (!stage) return;
  state.stageState[stage] = "skipped";
  renderStages();
  renderSkillStack();
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

function setMapStatus(name) {
  const status = state.data.mapStatus;
  els.mapStatus.classList.remove("is-baseline", "is-solving", "is-solved");
  els.mapStatus.classList.add("is-" + name);
  els.mapStatusText.textContent = status[name];
}

function applyMapRoute(action) {
  switch (action) {
    case "shimmer": els.baselineRoute.classList.add("is-solving"); break;
    case "reveal-active":
      els.activeRoute.classList.add("is-solved");
      els.baselineRoute.classList.remove("is-solving");
      break;
    case "fade-baseline": els.baselineRoute.classList.add("is-faded"); break;
    case "reveal-supports":
      els.feederRoute.classList.add("is-revealed");
      els.portRoute.classList.add("is-revealed");
      break;
  }
}

function animateScore(from, to, duration = 1000) {
  tween({
    from, to, duration, easing: easeOutCubic, key: "route-score",
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
        from: Math.max(8, fromVal), to: Math.max(8, toVal),
        duration: 1100, easing: easeOutCubic, key: `chart-bar-${ix}`,
        onUpdate: (v) => bar.style.setProperty("--height", v + "%")
      });
    }, ix * 90);
  });
}

/* ============================================================
 * Typewriter + console
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

function addConsoleEntry(stage, message) {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const stageLabel = (state.data && state.data.stageLabels && state.data.stageLabels[stage]) || stage || "demo";
  const li = document.createElement("li");
  li.innerHTML = `
    <time>${stamp}</time>
    <p><strong>${escapeHtml(stageLabel)}:</strong> ${escapeHtml(message)}</p>
  `;
  els.console.prepend(li);
}

/* ============================================================
 * Progress rail
 * ============================================================ */

function startIndeterminateProgressRail() {
  els.progressRail.classList.add("is-indeterminate");
  els.progressFill.style.width = "";
}

function stopProgressRail() {
  if (state.progressFillTimer) {
    window.clearInterval(state.progressFillTimer);
    state.progressFillTimer = null;
  }
}

function stopIndeterminateRail() {
  els.progressRail.classList.remove("is-indeterminate");
  els.progressFill.style.marginLeft = "";
}

/* ============================================================
 * Closing / failure / cancellation
 * ============================================================ */

function finishRun(data) {
  if (!state.running && state.completed) return;
  state.running = false;
  state.completed = true;
  const elapsedMs = performance.now() - state.runStartedAt;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  if (data && data.result && (!state.planTextAccumulator || state.planTextAccumulator.length < data.result.length)) {
    state.planTextAccumulator = data.result;
    state.planSections = parsePlanSections(data.result);
  }

  if (state.stageState.aiq === "streaming" || state.stageState.aiq === "calling") {
    setStageSubstate("aiq", "done");
  }
  // mark idle stages as skipped at end
  for (const stage of stageOrder) {
    if (state.stageState[stage] === "idle") setStageSubstateSkipped(stage);
  }

  els.body.classList.remove("is-running");
  els.body.classList.add("is-run-complete");
  els.consoleDot.classList.remove("is-running");
  els.runButton.disabled = false;
  els.runButton.classList.remove("is-running");
  els.runButton.classList.add("is-rerun");
  els.runLabel.textContent = "Re-run";
  els.runStatus.textContent = `Complete · ${elapsedSec}s`;
  els.harnessToggle.removeAttribute("aria-disabled");
  stopIndeterminateRail();
  els.progressFill.style.width = "100%";

  if (state.currentScore > state.baselineScore) {
    els.routeScoreDelta.hidden = false;
    els.routeScoreDelta.textContent = "+" + (state.currentScore - state.baselineScore);
  }

  els.runCompleteEyebrow.textContent = `${state.data.closing.eyebrow} · ${elapsedSec}s`;
  els.ctaReview.textContent = state.data.closing.ctaPrimary;
  els.ctaRerun.textContent = state.data.closing.ctaSecondary;
  els.runCompleteBar.hidden = false;
  requestAnimationFrame(() => els.runCompleteBar.classList.add("is-visible"));

  // Re-render the plan body in case typewriter was mid-stream
  if (state.planTextAccumulator) renderPlanLive();
  renderPlanTabs();

  // Enable the Expand button + auto-open the modal once when synthesis is available
  if (state.planTextAccumulator) {
    els.planExpand.disabled = false;
    if (!state.planModalAutoShown) {
      state.planModalAutoShown = true;
      setTimeout(() => openPlanModal(), 1100);
    }
  }

  triggerTabWave();
  const cost = data && data.costUsd ? ` · $${Number(data.costUsd).toFixed(4)}` : "";
  addConsoleEntry("general", `Run complete · ${elapsedSec}s${cost}`);
}

function failRun(data) {
  state.running = false;
  state.completed = false;
  els.body.classList.remove("is-running");
  els.runButton.disabled = false;
  els.runButton.classList.remove("is-running");
  els.runLabel.textContent = "Run";
  els.runStatus.textContent = "Failed";
  els.consoleDot.classList.remove("is-running");
  els.harnessToggle.removeAttribute("aria-disabled");
  stopProgressRail();
  stopIndeterminateRail();
  const message = (data && (data.error || data.stderr)) || "run failed";
  showToast("error", "Run failed — " + truncate(message, 240));
  addConsoleEntry("general", "Run failed: " + truncate(message, 400));
}

function finishRunCancelled() {
  if (!state.running && !state.completed) return;
  state.running = false;
  state.completed = false;
  els.body.classList.remove("is-running");
  els.runButton.disabled = false;
  els.runButton.classList.remove("is-running");
  els.runLabel.textContent = "Run";
  els.runStatus.textContent = "Cancelled";
  els.consoleDot.classList.remove("is-running");
  els.harnessToggle.removeAttribute("aria-disabled");
  stopProgressRail();
  stopIndeterminateRail();
  addConsoleEntry("general", "Run cancelled.");
}

function handleStreamError(message) {
  failRun({ error: message });
}

function triggerTabWave() {
  els.planTabs.classList.remove("is-wave");
  void els.planTabs.offsetWidth;
  els.planTabs.classList.add("is-wave");
  setTimeout(() => els.planTabs.classList.remove("is-wave"), 900);
}

/* ============================================================
 * Reset + harness toggle
 * ============================================================ */

async function resetRun() {
  if (state.abortController) {
    try { state.abortController.abort(); } catch (_) {}
    state.abortController = null;
  }
  if (state.runId) {
    try {
      await fetch(`/api/run/${encodeURIComponent(state.runId)}/cancel`, { method: "POST" });
    } catch (_) {}
  }
  cancelAllTweens();
  stopProgressRail();
  stopIndeterminateRail();
  if (state.typewriterTimer) {
    window.clearInterval(state.typewriterTimer);
    state.typewriterTimer = null;
  }
  state.running = false;
  state.completed = false;
  state.runId = null;
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
  if (state.stageState.aiq === "done") renderPlanLive();
}

/* ============================================================
 * Image upload + attached chip
 * ============================================================ */

async function attachImage(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    setPromptError("Image must be under 8 MB.");
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    setPromptError("Image must be PNG, JPEG, or WebP.");
    return;
  }
  clearPromptError();
  try {
    const r = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": file.type, "X-Upload-Filename": encodeURIComponent(file.name) },
      body: file
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      setPromptError(err.error || `upload failed (${r.status})`);
      return;
    }
    const data = await r.json();
    state.attachedImagePath = data.imagePath;
    state.attachedImageLabel = file.name;
    state.attachedImageState = "upload";
    renderAttachedChip();
  } catch (err) {
    setPromptError("upload error: " + (err && err.message));
  }
}

function resetSampleImage() {
  state.attachedImagePath = (state.data.sample && state.data.sample.imagePath) || SAMPLE_IMAGE_PATH;
  state.attachedImageLabel = (state.data.sample && state.data.sample.imageLabel) || "sample-capacity.png";
  state.attachedImageState = "sample";
  renderAttachedChip();
}

function detachImage() {
  state.attachedImagePath = null;
  state.attachedImageLabel = null;
  state.attachedImageState = "none";
  renderAttachedChip();
}

function renderAttachedChip() {
  if (state.attachedImageState === "none" || !state.attachedImageLabel) {
    els.promptAttached.hidden = true;
    return;
  }
  els.promptAttached.hidden = false;
  els.promptAttached.dataset.state = state.attachedImageState;
  els.promptAttachedName.textContent = state.attachedImageLabel;
}

/* ============================================================
 * Sandbox chip + policy drawer
 * ============================================================ */

function updateSandboxChip(surface, reachable, reason) {
  state.surface = surface;
  state.sandboxStatus = { reachable, reason };
  els.sandboxChip.classList.remove("is-sandbox", "is-host", "is-unknown");
  if (surface === "sandbox") {
    els.sandboxChip.classList.add("is-sandbox");
    els.sandboxChipText.textContent = "openshell · my-assistant";
    els.sandboxChip.title = "Running inside openshell sandbox (my-assistant). Click for policy.";
  } else if (surface === "host") {
    els.sandboxChip.classList.add("is-host");
    els.sandboxChipText.textContent = "host · sandbox bypassed";
    els.sandboxChip.title = reason ? "Sandbox unreachable: " + reason : "Running on host";
  } else {
    els.sandboxChip.classList.add("is-unknown");
    els.sandboxChipText.textContent = "checking sandbox…";
    els.sandboxChip.title = "Probing sandbox status…";
  }
}

async function openPolicyDrawer() {
  if (state.policyDrawerOpen) return;
  state.policyDrawerOpen = true;
  els.policyDrawer.hidden = false;
  els.policyDrawerBackdrop.hidden = false;
  els.policyDrawer.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    els.policyDrawer.classList.add("is-visible");
    els.policyDrawerBackdrop.classList.add("is-visible");
  });
  if (!state.policyText) {
    try {
      const r = await fetch("/api/policy", { cache: "no-store" });
      if (r.ok) {
        state.policyText = await r.text();
        els.policyDrawerContent.textContent = state.policyText;
      } else {
        els.policyDrawerContent.textContent = `Policy not available (status ${r.status}).`;
      }
    } catch (err) {
      els.policyDrawerContent.textContent = "Failed to load policy: " + (err && err.message);
    }
  } else {
    els.policyDrawerContent.textContent = state.policyText;
  }
}

function closePolicyDrawer() {
  if (!state.policyDrawerOpen) return;
  state.policyDrawerOpen = false;
  els.policyDrawer.classList.remove("is-visible");
  els.policyDrawerBackdrop.classList.remove("is-visible");
  setTimeout(() => {
    els.policyDrawer.hidden = true;
    els.policyDrawerBackdrop.hidden = true;
    els.policyDrawer.setAttribute("aria-hidden", "true");
  }, 280);
}

/* ============================================================
 * Plan modal
 * ============================================================ */

function openPlanModal() {
  if (state.planModalOpen) return;
  if (!state.planTextAccumulator) return;
  state.planModalOpen = true;
  renderPlanLive();
  if (els.planModalChip) {
    els.planModalChip.textContent = els.researchDepth.textContent || "deep research";
  }
  els.planModal.hidden = false;
  els.planModalBackdrop.hidden = false;
  els.planModal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    els.planModal.classList.add("is-visible");
    els.planModalBackdrop.classList.add("is-visible");
  });
  setTimeout(() => {
    try { els.planModalBody.focus({ preventScroll: true }); } catch (_) {}
  }, 60);
}

function closePlanModal(immediate = false) {
  if (!state.planModalOpen) return;
  state.planModalOpen = false;
  els.planModal.classList.remove("is-visible");
  els.planModalBackdrop.classList.remove("is-visible");
  const finalize = () => {
    els.planModal.hidden = true;
    els.planModalBackdrop.hidden = true;
    els.planModal.setAttribute("aria-hidden", "true");
  };
  if (immediate) finalize();
  else setTimeout(finalize, 280);
}

/* ============================================================
 * Toast + prompt error
 * ============================================================ */

function showToast(level, text, timeoutMs = 6000) {
  const stack = els.toastStack;
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast " + (level === "error" ? "is-error" : "is-info");
  toast.textContent = text;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  const timer = setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 240);
  }, timeoutMs);
  toast.addEventListener("click", () => {
    clearTimeout(timer);
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 240);
  });
}

function setPromptError(message) {
  els.promptError.textContent = message;
  els.promptError.hidden = false;
}

function clearPromptError() {
  els.promptError.textContent = "";
  els.promptError.hidden = true;
}

/* ============================================================
 * Misc helpers
 * ============================================================ */

function appendText(existing, addition) {
  if (!existing) return addition;
  return existing + "\n\n" + addition;
}

function truncate(s, n) {
  if (!s) return "";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssEscape(s) {
  if (s == null) return "";
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(s));
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/* ============================================================
 * Boot
 * ============================================================ */

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="app-shell"><section class="panel"><div class="panel-heading"><h1>Demo failed to load</h1></div><p class="insight-copy">${escapeHtml(error && error.message)}</p></section></main>`;
});
