import {
  parseCuoptToolOutput,
  cuoptEnvelopeToUiValues,
  mockToUiValues,
  looksLikeCuoptResult,
  CUOPT_SCORE_PENALTY
} from "./app-cuopt.mjs";

const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SAMPLE_IMAGE_PATH = "/home/nvidia/gtc-taipei-demo/data/sample-capacity.png";
const PROMPT_STORAGE_KEY = "gtc-taipei-prompt-draft";

const state = {
  data: null,
  harness: "codex",
  activeStage: "brief",            // Canvas the user is viewing
  autoFollowStage: "brief",        // Stage the agent is actually on
  peekMode: false,                 // True when user has clicked away during a run
  activePlan: "strategy",
  running: false,
  completed: false,
  completedStages: new Set(),
  stageState: { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" },
  activeTweens: new Map(),
  typewriterTimer: null,
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
  attachedImageState: "none",    // "sample" | "upload" | "none". Default is "none" —
                                 // the user clicks "load sample query" to attach the
                                 // bundled sample, or "attach image" to upload their own.
  policyText: null,
  policyDrawerOpen: false,
  visionTextAccumulator: "",
  planTextAccumulator: "",
  planSections: null,
  aiqJobId: null,
  hasInitializedVisionTypewriter: false,

  // Skill-stack live state (decoupled from stage flow).
  // skillState[id] ∈ "idle" | "calling" | "done"
  skillState: {},
  skillFadeTimers: new Map(),

  // When Claude Code's harness backgrounds the vision_analyze.py Bash call
  // (`run_in_background: true`), the first tool result is just the
  // harness's "Command running in background with ID: …" preamble, not the
  // real Nemotron output. We stash the bash_id here and watch subsequent
  // tool results for the actual vision content. See handleToolCompleted.
  visionBackgroundBashId: null,

  // Same pattern for the cuopt script.
  cuoptBackgroundBashId: null,

  // Sticky: true once applyCuoptResult has committed once for this run.
  // Guards against double-fire (e.g. agent invokes cuopt twice) and lets
  // the setStageSubstate guard + finishRun safety-net know cuopt is settled.
  cuoptResolved: false,

  // Raw aiq.py report text (the "report" field from the envelope). The plan
  // tabs render the agent's curated synthesis only, but we surface this full
  // research body below the active section in a collapsible details element
  // so users can dig into the underlying sources.
  planReportRaw: null,

  // Open/closed state for the full-report <details> element. The same report
  // appears under every plan tab, so the user's toggle decision should
  // persist when they switch tabs. Default: open (so users see the full
  // research body the first time AIQ lands; one click hides it everywhere).
  planFullReportOpen: true,

  // Raw vision_analyze.py stdout for the same reason — the Vision panel
  // shows a curated Insights paragraph at the top, with the full analysis
  // (5 numbered detail sections + observations + recommendations) available
  // under an "Expand full analysis" details element.
  visionFullText: null
};

const SKILL_ACTIVE_FADE_MS = 1400;

const STAGE_LABELS = {
  brief: "Task Overview",
  cuopt: "cuOpt Solve",
  vision: "Vision Insights",
  aiq: "AIQ Research"
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

  // Initial state: empty terminal, no attached image. The user can click
  // "load sample query" to populate the textarea + attach the bundled sample
  // image in one go. We DO still restore an in-flight sessionStorage draft so
  // an accidental refresh-during-typing doesn't lose work.
  state.attachedImagePath = null;
  state.attachedImageLabel = null;
  state.attachedImageState = "none";

  const stored = (typeof sessionStorage !== "undefined") && sessionStorage.getItem(PROMPT_STORAGE_KEY);
  if (stored) els.promptInput.value = stored;

  if (els.promptZone) {
    els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
  }

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
  els.cockpit = document.querySelector("main.cockpit");
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
  els.capacityBars = document.querySelector("#capacity-bars");
  els.capacityExplanation = document.querySelector("#capacity-explanation");
  els.capacitySource = document.querySelector("#capacity-source");
  els.visionImage = document.querySelector("#vision-image");
  els.visionImageWrap = document.querySelector(".vision-image-wrap");
  els.visionImageCaption = document.querySelector("#vision-image-caption");
  els.visionImagePlaceholder = document.querySelector("#vision-image-placeholder");
  els.visionCopy = document.querySelector("#vision-copy");
  els.visionFullRow = document.querySelector("#vision-full-row");
  els.visionConfidence = document.querySelector("#vision-confidence");
  els.researchDepth = document.querySelector("#research-depth");
  els.planTabs = document.querySelector("#plan-tabs");
  els.planBody = document.querySelector("#plan-body");

  els.stagePills = Array.from(document.querySelectorAll(".stage-pill[data-stage]"));
  els.railResume = document.querySelector("#rail-resume");

  els.promptZone = document.querySelector("#prompt-zone");
  els.promptSummary = document.querySelector("#prompt-summary");
  els.promptSummaryText = document.querySelector("#prompt-summary-text");
  els.promptSummaryAttached = document.querySelector("#prompt-summary-attached");
  els.promptEditButton = document.querySelector("#prompt-edit-button");
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

  els.toastStack = document.querySelector("#toast-stack");
}

function wireEvents() {
  els.harnessToggle.querySelectorAll("[data-harness]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.running) return;
      setHarness(button.dataset.harness);
    });
  });

  // Stage rail — click navigation (with peek-mode during run)
  els.stagePills.forEach((button) => {
    button.addEventListener("click", () => {
      const stage = button.dataset.stage;
      navigateToStage(stage, { source: "click" });
    });
    button.addEventListener("keydown", (e) => handleStageRailKey(e, button));
  });

  // Resume-follow pill (only visible during peek mode mid-run)
  els.railResume.addEventListener("click", () => resumeAutoFollow());

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

  // Prompt
  els.promptInput.addEventListener("input", () => {
    try { sessionStorage.setItem(PROMPT_STORAGE_KEY, els.promptInput.value); } catch (_) {}
    clearPromptError();
    if (els.promptZone) {
      els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
    }
  });

  els.promptAttachInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await attachImage(file);
    e.target.value = "";  // reset so the same file can be re-selected
  });

  els.promptResetSample.addEventListener("click", () => resetToSample());

  els.promptAttachedClear.addEventListener("click", () => {
    if (state.attachedImageState === "sample") {
      detachImage();
    } else {
      resetSampleImage();
    }
  });

  els.promptEditButton.addEventListener("click", () => {
    setPromptView("editable");
    navigateToStage("brief", { source: "click" });
    requestAnimationFrame(() => {
      try { els.promptInput.focus({ preventScroll: false }); } catch (_) {}
    });
  });

  // Sandbox chip + policy drawer
  els.sandboxChip.addEventListener("click", () => openPolicyDrawer());
  els.policyDrawerClose.addEventListener("click", () => closePolicyDrawer());
  els.policyDrawerBackdrop.addEventListener("click", () => closePolicyDrawer());
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.policyDrawerOpen) closePolicyDrawer();
  });
}

function handleStageRailKey(e, currentPill) {
  const idx = els.stagePills.indexOf(currentPill);
  if (idx < 0) return;
  let nextIdx = null;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowRight":
      nextIdx = (idx + 1) % els.stagePills.length;
      break;
    case "ArrowUp":
    case "ArrowLeft":
      nextIdx = (idx - 1 + els.stagePills.length) % els.stagePills.length;
      break;
    case "Home":
      nextIdx = 0;
      break;
    case "End":
      nextIdx = els.stagePills.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const nextPill = els.stagePills[nextIdx];
  navigateToStage(nextPill.dataset.stage, { source: "keyboard" });
  try { nextPill.focus({ preventScroll: false }); } catch (_) {}
}

/* ============================================================
 * Render — idle + general
 * ============================================================ */

function renderAll() {
  renderHarness();
  renderStages();
  renderSkillStack();
  renderMetrics("baseline");
  updateVisionImage();
  renderPlanTabs();
  renderPlan();
  renderAttachedChip();
  setActiveCanvas(state.activeStage, { animate: false });
  setPromptView("editable");
  updateRunSubstatus();
}

function applyIdleState() {
  els.body.classList.remove("is-running", "is-run-complete");
  els.runButton.classList.remove("is-rerun", "is-running");
  els.runButton.disabled = false;
  els.runLabel.textContent = "Run";
  els.runStatus.textContent = "Ready";
  els.consoleDot.classList.remove("is-running");
  els.harnessToggle.removeAttribute("aria-disabled");
  els.activeRoute?.classList.remove("is-solved");
  els.baselineRoute?.classList.remove("is-faded", "is-solving");
  els.feederRoute?.classList.remove("is-revealed");
  els.portRoute?.classList.remove("is-revealed");
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
  renderVisionSkeleton();
  // Baseline capacity chart so the panel isn't empty before the first run.
  const baselineCapRows = state.data.capacity.baseline.map((row, i) => ({
    label: row.label,
    value: row.value,                                      // current = baseline
    baseline: row.value,                                   // baseline-line same as value
    dataSource: "mock"
  }));
  renderCapacityChart(baselineCapRows, "fallback", "");
  els.researchDepth.textContent = "queued";
  els.researchDepth.className = "confidence-chip is-quiet";
  els.metricsEyebrow.textContent = "Baseline today";

  state.currentScore = state.baselineScore;
  state.completedStages = new Set();
  state.stageState = { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" };
  state.activeStage = "brief";
  state.autoFollowStage = "brief";
  state.peekMode = false;
  state.activePlan = "strategy";
  state.completed = false;
  state.runId = null;
  state.visionTextAccumulator = "";
  state.visionBackgroundBashId = null;
  state.visionFullText = null;
  state.cuoptBackgroundBashId = null;
  state.cuoptResolved = false;
  state.planTextAccumulator = "";
  state.planSections = null;
  state.planReportRaw = null;
  state.planFullReportOpen = true;
  state.aiqJobId = null;
  state.hasInitializedVisionTypewriter = false;
  resetSkillState();

  setPromptView("editable");
  setActiveCanvas("brief", { animate: false });
  hideResumePill();
  renderStages();
  renderSkillStack();
  renderPlan();
  renderPlanTabs();
}

function renderHarness() {
  els.body.dataset.harness = state.harness;
  els.harnessToggle.querySelectorAll("[data-harness]").forEach((button) => {
    const isActive = button.dataset.harness === state.harness;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  });
}

function renderStages() {
  els.stagePills.forEach((button) => {
    const stage = button.dataset.stage;
    const sub = state.stageState[stage];
    const isActive = stage === state.activeStage;
    button.classList.toggle("is-active", isActive);
    button.classList.toggle("is-running", sub === "calling" || sub === "streaming");
    button.classList.toggle("is-complete", sub === "done");
    button.classList.toggle("is-skipped", sub === "skipped");
    button.classList.toggle("is-failed", sub === "failed");
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });
}

/* ============================================================
 * Canvas routing + auto-follow
 * ============================================================ */

function setActiveCanvas(stage, opts = {}) {
  if (!stage || !stageOrder.includes(stage)) return;
  const animate = opts.animate !== false && !REDUCED_MOTION;
  state.activeStage = stage;
  els.cockpit.dataset.activeStage = stage;
  if (animate) {
    document.querySelectorAll(`[data-stage-canvas]`).forEach((el) => {
      if (el.matches(`[data-stage-canvas~="${stage}"]`)) {
        el.classList.remove("is-entering");
        // force reflow so the animation restarts
        void el.offsetWidth;
        el.classList.add("is-entering");
        setTimeout(() => el.classList.remove("is-entering"), 260);
      }
    });
  }
  renderStages();
  highlightStagePanel(stage);
}

function navigateToStage(stage, opts = {}) {
  if (!stage || !stageOrder.includes(stage)) return;
  if (state.running && stage !== state.autoFollowStage) {
    state.peekMode = true;
    showResumePill();
  } else if (stage === state.autoFollowStage) {
    state.peekMode = false;
    hideResumePill();
  }
  setActiveCanvas(stage);
}

function autoAdvance(stage) {
  if (!stage || !stageOrder.includes(stage)) return;
  state.autoFollowStage = stage;
  if (!state.peekMode) {
    setActiveCanvas(stage);
  } else {
    // In peek mode, just update the rail visuals; canvas stays on the user's pick.
    renderStages();
  }
  updateRunSubstatus();
}

function resumeAutoFollow() {
  state.peekMode = false;
  hideResumePill();
  setActiveCanvas(state.autoFollowStage);
}

function showResumePill() {
  els.railResume.hidden = false;
  const stageLabel = STAGE_LABELS[state.autoFollowStage] || state.autoFollowStage;
  const span = els.railResume.querySelector("span:last-child");
  if (span) span.textContent = `Resume follow · ${stageLabel}`;
}

function hideResumePill() {
  els.railResume.hidden = true;
}

function updateRunSubstatus() {
  if (state.completed) return; // finishRun handles its own substatus
  if (!state.running) {
    els.runStatus.textContent = "Ready";
    return;
  }
  const stage = state.autoFollowStage || "brief";
  const i = stageOrder.indexOf(stage);
  const idx = i >= 0 ? String(i + 1).padStart(2, "0") : "01";
  const labels = { brief: "Task Overview", cuopt: "cuOpt Solve", vision: "Vision Insights", aiq: "AIQ Research" };
  els.runStatus.textContent = `Stage ${idx} · ${labels[stage] || stage}`;
}

/* ============================================================
 * Prompt view toggle (editable vs summary)
 * ============================================================ */

function setPromptView(mode) {
  // mode: "editable" | "summary"
  if (mode === "summary") {
    const text = (els.promptInput.value || "").trim();
    // Show the full submitted prompt — the terminal-submitted container is
    // full-height with pre-wrap text, so long briefs render legibly. The old
    // truncate-to-360 was for the compact pre-terminal summary view.
    els.promptSummaryText.textContent = text || "(no brief submitted)";
    if (state.attachedImageState !== "none" && state.attachedImageLabel) {
      els.promptSummaryAttached.textContent = state.attachedImageLabel;
      els.promptSummaryAttached.hidden = false;
    } else {
      els.promptSummaryAttached.hidden = true;
    }
    els.promptZone.hidden = true;
    els.promptSummary.hidden = false;
  } else {
    els.promptZone.hidden = false;
    els.promptSummary.hidden = true;
  }
}

function resetSkillState() {
  state.skillState = {};
  if (state.skillFadeTimers) {
    for (const t of state.skillFadeTimers.values()) clearTimeout(t);
    state.skillFadeTimers.clear();
  }
}

function matchSkill(name, input) {
  if (!state.data || !state.data.skills) return null;
  const probe = (String(name || "") + " " + (() => {
    if (!input) return "";
    if (typeof input === "string") return input;
    try { return JSON.stringify(input); } catch (_) { return ""; }
  })()).toLowerCase();
  for (const skill of state.data.skills) {
    const patterns = skill.match || [];
    for (const pat of patterns) {
      if (probe.includes(String(pat).toLowerCase())) return skill.id;
    }
  }
  return null;
}

// Authoritative stage → skill mapping. The orchestrator already infers a
// stage per tool beat (see server/normalize-claude.mjs / normalize-codex.mjs
// STAGE_HINTS) and that signal is more reliable than substring-matching the
// tool input, which trips on broad cross-references (e.g. an AIQ query that
// threads cuopt's numbers contains the literal "cuopt" and would otherwise
// route to the wrong chip). Returns null for "general" so callers can fall
// back to matchSkill.
function skillIdForStage(stage) {
  switch (stage) {
    case "cuopt":  return "cuopt";
    case "vision": return "vision-insights";
    case "aiq":    return "aiq-research";
    default:       return null;
  }
}

function markSkillCalled(skillId) {
  if (!skillId) return;
  state.skillState[skillId] = "calling";
  if (state.skillFadeTimers.has(skillId)) {
    clearTimeout(state.skillFadeTimers.get(skillId));
    state.skillFadeTimers.delete(skillId);
  }
  renderSkillStack();
}

function markSkillCompleted(skillId) {
  if (!skillId) return;
  state.skillState[skillId] = "done";
  if (state.skillFadeTimers.has(skillId)) {
    clearTimeout(state.skillFadeTimers.get(skillId));
  }
  const timer = setTimeout(() => {
    state.skillFadeTimers.delete(skillId);
    renderSkillStack();
  }, SKILL_ACTIVE_FADE_MS);
  state.skillFadeTimers.set(skillId, timer);
  renderSkillStack();
}

function renderSkillStack() {
  els.skillStack.innerHTML = state.data.skills.map((skill) => {
    const sub = state.skillState[skill.id];
    const isCalling = sub === "calling";
    const isDone = sub === "done";
    let stateLabel = "idle";
    if (isCalling) stateLabel = "calling";
    else if (isDone) stateLabel = "ready";
    const aria = `${skill.name} — ${skill.detail}`;
    return `
      <article class="skill-chip ${isCalling ? "is-running" : ""} ${isDone ? "is-done" : ""}"
               role="listitem"
               data-skill="${escapeHtml(skill.id)}"
               data-tooltip="${escapeHtml(skill.detail)}"
               aria-label="${escapeHtml(aria)}">
        <span class="skill-chip-glow" aria-hidden="true"></span>
        <span class="skill-chip-icon" aria-hidden="true">${escapeHtml(skill.icon)}</span>
        <span class="skill-chip-name">${escapeHtml(skill.name)}</span>
        <span class="skill-chip-state">${stateLabel}</span>
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

function renderMetricsSkeleton() {
  // 4 empty rows with pulsing bar-fills. Matches the structure of renderMetrics
  // so animateMetricBars can find .metric-row .bar-fill and tween them.
  const rows = [0, 1, 2, 3].map((ix) => `
    <div class="metric-row is-skeleton" data-row="${ix}">
      <div class="metric-label">
        <div class="metric-label-row">
          <span class="skel-line"></span>
          <strong class="skel-line short"></strong>
        </div>
      </div>
      <div class="bar-track">
        <div class="bar-fill is-pulsing" style="width: 0%"></div>
      </div>
    </div>
  `).join("");
  els.metricBars.innerHTML = rows;
  els.metricBars.classList.add("is-skeleton");
  els.metricsEyebrow.textContent = "Solving…";
}

function animateMetricBars(fromRows, toRows) {
  // If the DOM doesn't currently hold 4 .metric-row elements (e.g. coming out
  // of skeleton or first run), re-render the structure now. We do this in
  // baseline state so animateMetricBars can tween from there.
  if (els.metricBars.querySelectorAll(".metric-row").length !== 4 ||
      els.metricBars.classList.contains("is-skeleton")) {
    renderMetrics("baseline");
  }
  els.metricBars.classList.remove("is-skeleton");
  els.metricBars.classList.remove("is-baseline");
  els.metricBars.classList.add("is-optimized");

  const rowEls = els.metricBars.querySelectorAll(".metric-row");
  toRows.forEach((target, ix) => {
    const li = rowEls[ix];
    if (!li) return;
    const fill = li.querySelector(".bar-fill");
    const fromVal = fromRows[ix].value;
    const toVal = target.value;
    if (fill) {
      tween({
        from: fromVal, to: toVal, duration: 900, easing: easeOutCubic,
        key: `metric-bar-${ix}`,
        onUpdate: (v) => { fill.style.width = v + "%"; }
      });
    }
    // After the bar tween starts, swap in the new display string + delta chip
    // with a small fade so the text doesn't pop while the bar is still moving.
    const labelStrong = li.querySelector(".metric-label-row strong");
    if (labelStrong) {
      labelStrong.style.opacity = "0";
      setTimeout(() => {
        labelStrong.textContent = target.display;
        labelStrong.style.opacity = "1";
      }, 250);
    }
    // Delta chip lives under .metric-label as .metric-delta. Insert or update.
    const labelBlock = li.querySelector(".metric-label");
    let delta = labelBlock.querySelector(".metric-delta");
    if (target.delta) {
      if (!delta) {
        delta = document.createElement("span");
        delta.className = "metric-delta";
        labelBlock.appendChild(delta);
      }
      delta.style.opacity = "0";
      setTimeout(() => {
        delta.textContent = target.delta;
        delta.style.opacity = "1";
      }, 300);
    }
    // Visual hint that this row's value came from a fallback rather than the
    // envelope. CSS uses [data-source="mock"] to tint the bar slightly.
    li.setAttribute("data-source", target.dataSource || "envelope");
  });
}

function renderCapacitySkeleton() {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((ix) => `
    <div class="capacity-row is-skeleton" role="listitem" data-row="${ix}">
      <span class="capacity-label">…</span>
      <div class="capacity-track">
        <div class="capacity-fill-baseline" style="--baseline-pct: 0%"></div>
        <div class="capacity-fill-optimized" style="--optimized-pct: 0%"></div>
      </div>
      <span class="capacity-delta">—</span>
    </div>
  `).join("");
  els.capacityBars.innerHTML = rows;
  els.capacityExplanation.hidden = true;
  els.capacitySource.className = "confidence-chip is-quiet";
  els.capacitySource.textContent = "solving…";
}

function renderCapacityChart(rows, status, explanation) {
  const chipText = status === "solved" ? "from cuOpt"
                  : status === "infeasible" ? "cuOpt partial"
                  : "reference plan";
  const chipClass = status === "solved" ? "confidence-chip"
                   : status === "infeasible" ? "confidence-chip is-warn"
                   : "confidence-chip is-quiet";
  els.capacitySource.className = chipClass;
  els.capacitySource.textContent = chipText;

  els.capacityBars.innerHTML = rows.map((row) => {
    const delta = row.value - row.baseline;
    // Buffer is the only node where a positive delta (higher utilization) is good.
    const isBuffer = row.label === "Buffer";
    const deltaClass = isBuffer && delta > 0 ? "capacity-delta is-buffer-positive"
                      : "capacity-delta";
    const deltaText = delta === 0 ? "—"
                     : (delta < 0 ? "−" : "+") + Math.abs(delta);
    return `
      <div class="capacity-row" role="listitem" data-source="${escapeHtml(row.dataSource)}" data-node="${escapeHtml(row.label)}">
        <span class="capacity-label">${escapeHtml(row.label)}</span>
        <div class="capacity-track">
          <div class="capacity-fill-baseline" style="--baseline-pct: ${row.baseline}%"></div>
          <div class="capacity-fill-optimized" style="--optimized-pct: 0%"></div>
        </div>
        <span class="${deltaClass}">${escapeHtml(deltaText)}</span>
      </div>
    `;
  }).join("");

  // Trigger the optimized-fill animation with a one-frame delay so the
  // browser commits the initial 0% width before transitioning to the target.
  requestAnimationFrame(() => {
    els.capacityBars.querySelectorAll(".capacity-row").forEach((el, ix) => {
      const opt = el.querySelector(".capacity-fill-optimized");
      if (opt) opt.style.setProperty("--optimized-pct", rows[ix].value + "%");
    });
  });

  if (explanation) {
    els.capacityExplanation.textContent = explanation;
    els.capacityExplanation.hidden = false;
  } else {
    els.capacityExplanation.hidden = true;
  }
}

function toBrowserImageUrl(hostPath) {
  if (!hostPath) return null;
  if (hostPath.startsWith("/tmp/uploads/")) {
    return "/uploads/" + hostPath.slice("/tmp/uploads/".length);
  }
  // Sample image lives at /data/sample-capacity.png in the repo, served as-is
  // by the static handler. The host-absolute form lands here too.
  if (hostPath === SAMPLE_IMAGE_PATH || hostPath.endsWith("/data/sample-capacity.png")) {
    return "/data/sample-capacity.png";
  }
  // Already a browser-relative URL (e.g. "/data/sample-capacity.png").
  if (hostPath.startsWith("/")) return hostPath;
  return null;
}

function updateVisionImage() {
  if (!els.visionImage) return;
  const url = toBrowserImageUrl(state.attachedImagePath);
  if (url) {
    if (els.visionImage.getAttribute("src") !== url) {
      els.visionImage.setAttribute("src", url);
    }
    els.visionImage.removeAttribute("hidden");
    if (els.visionImagePlaceholder) {
      els.visionImagePlaceholder.setAttribute("hidden", "");
    }
    if (els.visionImageCaption) {
      els.visionImageCaption.textContent = state.attachedImageLabel || "attached image";
    }
  } else {
    els.visionImage.removeAttribute("src");
    els.visionImage.setAttribute("hidden", "");
    if (els.visionImagePlaceholder) {
      els.visionImagePlaceholder.removeAttribute("hidden");
    }
    if (els.visionImageCaption) {
      els.visionImageCaption.textContent = "no image attached";
    }
  }
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

function renderVisionSkeleton() {
  if (!els.visionCopy) return;
  // Reuse the .plan-skeleton classes for visual consistency with the
  // AIQ Research idle state — shimmer rectangles stacked vertically.
  els.visionCopy.innerHTML = `
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
  if (els.visionFullRow) {
    els.visionFullRow.innerHTML = "";
    els.visionFullRow.hidden = true;
  }
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

  // Surface the full aiq.py report below the curated synthesis. This is the
  // evidence layer: tabs show the agent's 4-paragraph summary, and the
  // details element exposes the underlying research body with citations.
  // Only render when we have the raw report AND the section UI is already
  // showing the synthesis (otherwise the full content is the main render).
  // The open/closed state is persisted in state.planFullReportOpen so it
  // survives tab switches (same report on every tab — toggle once).
  const fullReportBlock = (state.planReportRaw && state.planSections && state.planSections[state.activePlan])
    ? `
      <details class="plan-full-report"${state.planFullReportOpen ? " open" : ""}>
        <summary>
          <span class="full-summary-label">Full research report (${state.planReportRaw.length.toLocaleString()} chars)</span>
          <button class="print-pdf-button" type="button" data-print-pdf="plan" aria-label="Print research report as PDF">
            <svg class="print-pdf-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 3h10v5H7zM5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2zm2 10h10v3H7zm12-6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"></path>
            </svg>
            <span>Print as PDF</span>
          </button>
        </summary>
        <div class="plan-full-report-body">${formatPlanText(state.planReportRaw)}</div>
      </details>
    `
    : "";

  return `
    <p class="plan-prefix"><strong>${escapeHtml(prefix)}:</strong></p>
    <div class="plan-live-body">${body}</div>
    ${fullReportBlock}
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

function wirePlanFullReportToggle(scope) {
  // The <details> element is recreated each renderPlanLive (innerHTML rewrite
  // destroys listeners), so we reattach the toggle handler every render. The
  // user's open/closed choice persists in state.planFullReportOpen.
  const details = scope.querySelector(".plan-full-report");
  if (!details) return;
  details.addEventListener("toggle", () => {
    state.planFullReportOpen = details.open;
  });
  const printBtn = details.querySelector('[data-print-pdf="plan"]');
  if (printBtn) {
    printBtn.addEventListener("click", (e) => {
      // Clicks inside <summary> toggle <details> by default — suppress so the
      // user's open/closed choice stays put when they hit the print button.
      e.preventDefault();
      e.stopPropagation();
      printAsPdf("AIQ Research — Full Report", state.planReportRaw || "");
    });
  }
}

function renderPlanLive() {
  if (!state.planTextAccumulator) {
    renderPlanSkeleton();
    return;
  }
  const html = buildPlanBodyHtml();
  els.planBody.innerHTML = html;
  wirePlanJumpButtons(els.planBody);
  wirePlanFullReportToggle(els.planBody);
}

function formatPlanText(text) {
  if (!text) return "";
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => "<p>" + para.replace(/\n/g, "<br>") + "</p>")
    .join("");
}

function parsePlanSections(text) {
  // Line-based parser. A header line is one whose stripped content starts
  // with a canonical section keyword AND has a recognised separator after
  // the keyword (`:`, `**`, `-`, `&`, or end-of-line).
  //
  // We capture body content from two places:
  //   - inline on the header line itself (after a `:` or `**` separator),
  //     e.g. `**Strategy:** the recommended strategy is …`
  //   - subsequent lines up to the next header
  // Both are joined into the section's body.
  const HEADER_KEYWORD = /^(strategy|strategic|market(?:\s+(?:analysis|outlook|landscape))?|risk(?:s)?(?:\s+(?:analysis|register|assessment))?|execution(?:\s+plan)?|implementation(?:\s+plan)?)\b/i;

  const lines = text.split("\n");
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].trim();
    if (!s) continue;
    // Repeatedly strip leading decorations: blockquote/list markers (only
    // when followed by whitespace, so we don't chew a `*` off `**bold**`),
    // markdown header `#`s, bold openers `**`, and numeric prefixes `1.`/
    // `1)`/`1:`. The loop handles stacked decorations like `**1. Strategy`.
    let prev;
    do {
      prev = s;
      s = s.replace(/^[>*\-]\s+/, "");
      s = s.replace(/^#{1,6}\s*/, "");
      s = s.replace(/^\*\*\s*/, "");
      s = s.replace(/^\d+[.):]\s*/, "");
    } while (s !== prev);

    const m = s.match(HEADER_KEYWORD);
    if (!m) continue;

    const after = s.slice(m[0].length);
    // Header gate: what follows the keyword must be one of:
    //   - end-of-line (after trim)                    → `## Strategy`
    //   - `:` `**` `-` `–` `—` `&` (separators)       → `**Strategy:**`, `## Strategy & Recs`
    // If anything else follows (e.g. "Strategy is the most important..."),
    // this is prose, not a header — skip.
    if (after.trim() && !/^[\s:\-–—&*]/.test(after)) continue;

    // Pull inline body iff a clear separator (`:` or `**`) is present —
    // a title extension like " & Recommendations" stays in the title.
    const hasInlineSep = /[:*]/.test(after);
    let inline = "";
    if (hasInlineSep) {
      inline = after
        .replace(/^\s*\*+\s*/, "")   // bold close before `:`
        .replace(/^\s*:\s*/, "")     // colon separator
        .replace(/^\s*\*+\s*/, "")   // bold close after `:`
        .replace(/\s*\*+\s*$/, "")   // trailing bold close
        .trim();
    }

    headers.push({ key: normalizeSectionKey(m[1]), lineIndex: i, inline });
  }
  if (headers.length < 2) return null;

  const sections = {};
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const next = headers[i + 1];
    const startLine = cur.lineIndex + 1;
    const endLine = next ? next.lineIndex : lines.length;
    const trailing = lines.slice(startLine, endLine).join("\n").trim();
    const body = [cur.inline, trailing].filter(Boolean).join("\n\n").trim();
    if (body) sections[cur.key] = body;
  }
  return Object.keys(sections).length >= 2 ? sections : null;
}

function normalizeSectionKey(raw) {
  const lower = raw.toLowerCase();
  if (lower.startsWith("strateg")) return "strategy";          // strategy, strategic
  if (lower.startsWith("market")) return "market";
  if (lower.startsWith("risk")) return "risk";
  if (lower.startsWith("execution") || lower.startsWith("implementation")) return "execution";
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
  applyRunIdleSlate();

  state.running = true;
  state.completed = false;
  state.peekMode = false;
  state.runStartedAt = performance.now();

  els.body.classList.add("is-running");
  els.body.classList.remove("is-run-complete");
  els.runButton.disabled = true;
  els.runButton.classList.remove("is-rerun");
  els.runButton.classList.add("is-running");
  els.runLabel.textContent = "Running";
  els.runStatus.textContent = "Submitting…";
  els.consoleDot.classList.add("is-running");
  els.harnessToggle.setAttribute("aria-disabled", "true");
  hideResumePill();

  // Brief is "submitted" the moment Run is clicked. Collapse the prompt
  // into a read-only summary and auto-advance the canvas to Stage 2.
  setPromptView("summary");
  setStageSubstate("brief", "done");
  autoAdvance("cuopt");

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
  state.visionBackgroundBashId = null;
  state.visionFullText = null;
  state.cuoptBackgroundBashId = null;
  state.cuoptResolved = false;
  state.planTextAccumulator = "";
  state.planSections = null;
  state.planReportRaw = null;
  state.planFullReportOpen = true;
  state.aiqJobId = null;
  state.hasInitializedVisionTypewriter = false;
  resetSkillState();
  state.stageState = { brief: "idle", cuopt: "idle", vision: "idle", aiq: "idle" };
  state.completedStages = new Set();
  state.autoFollowStage = "brief";
  state.currentScore = state.baselineScore;
  els.routeScoreValue.textContent = String(state.baselineScore);
  els.routeScoreLabel.textContent = state.data.scoreContext.baselineLabel;
  els.routeScoreDelta.hidden = true;
  els.visionConfidence.textContent = "standby";
  els.visionConfidence.className = "confidence-chip is-quiet";
  renderVisionSkeleton();
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

function applyCuoptResult(result) {
  if (state.cuoptResolved) return;         // idempotent commit
  state.cuoptResolved = true;

  const ui = result.status === "fallback"
    ? mockToUiValues(state.data)
    : cuoptEnvelopeToUiValues(result.envelope, state.data);

  // Metric bars: animate baseline → ui.metricRows
  animateMetricBars(state.data.metrics.baseline, ui.metricRows);

  // Capacity chart
  renderCapacityChart(ui.capacityRows, ui.status, ui.explanation);

  // Map state + supporting routes (reveal-supports delayed so the active
  // route's CSS transition lands first)
  setMapStatus("solved");
  applyMapRoute("reveal-active");
  applyMapRoute("fade-baseline");
  setTimeout(() => applyMapRoute("reveal-supports"), 200);

  // Score
  const penalty = CUOPT_SCORE_PENALTY[result.status] ?? CUOPT_SCORE_PENALTY.fallback;
  const targetScore = state.optimizedScore - penalty;
  animateScore(state.currentScore, Math.max(state.currentScore, targetScore), 1400);

  // Stage and copy
  setStageSubstate("cuopt", "done");
  els.metricsEyebrow.textContent = "Optimized";

  if (result.status === "fallback") {
    showToast("warn", `cuOpt returned no usable data (${result.reason}) — showing reference plan.`);
    addConsoleEntry("cuopt", `cuOpt fallback (${result.reason}). Reference plan shown.`);
  } else if (result.status === "infeasible") {
    showToast("warn", "cuOpt returned a best-effort infeasible solution.");
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "infeasible"}`);
  } else {
    addConsoleEntry("cuopt", `cuOpt: ${result.envelope.explanation || "solved"}`);
  }
}

function handleAssistantText({ stage, text }) {
  if (!text) return;

  // Route by intent, NOT by keyword. The previous logic used `stage` (inferred
  // from text content via STAGE_HINTS in the normalizers), which meant a final
  // synthesis paragraph mentioning "Nemotron Omni" got tagged vision and leaked
  // into the Vision section. We now decide based on where the run actually is:
  //
  //   - Vision section is OWNED by the vision tool's stdout (extractVisionSummary
  //     in handleToolCompleted). Free-form assistant text never writes to it.
  //   - Plan section captures anything the agent emits once aiq.py has been
  //     invoked — that's the synthesis phase.
  //   - Anything earlier is pre-tool narration → console only.
  const aiqStarted =
    state.stageState.aiq === "calling" ||
    state.stageState.aiq === "streaming" ||
    state.stageState.aiq === "done";

  if (aiqStarted) {
    if (state.stageState.aiq !== "done") setStageSubstate("aiq", "streaming");
    state.planTextAccumulator = appendText(state.planTextAccumulator, text);
    state.planSections = parsePlanSections(state.planTextAccumulator);
    renderPlanLive();
    renderPlanTabs();
    addConsoleEntry("aiq", truncate(text, 240));
    return;
  }
  addConsoleEntry("general", truncate(text, 400));
}

function handleToolInvoked({ id, name, input, stage }) {
  if (stage === "cuopt") {
    if (!state.cuoptResolved) {
      setStageSubstate("cuopt", "calling");
      applyMapRoute("shimmer");
      setMapStatus("solving");
      renderMetricsSkeleton();
      renderCapacitySkeleton();
    }
  } else if (stage === "vision") {
    setStageSubstate("vision", "calling");
    els.visionConfidence.textContent = "analyzing";
    els.visionConfidence.className = "confidence-chip is-analyzing";
    if (els.visionImageWrap) els.visionImageWrap.classList.add("is-analyzing");
  } else if (stage === "aiq") {
    setStageSubstate("aiq", "calling");
    els.researchDepth.textContent = "researching";
    els.researchDepth.className = "confidence-chip is-analyzing";
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
    // Guard: if vision is still pending a backgrounded result when the agent
    // moves on to AIQ, finalize vision so the UI doesn't hang in "analyzing".
    // We accept whatever vision content we managed to capture (possibly none).
    if (state.visionBackgroundBashId) {
      addConsoleEntry("vision", "Vision background still pending when AIQ started — finalizing.");
      finalizeVisionDone();
      state.visionBackgroundBashId = null;
    }
  }
  // Stage is authoritative for chip selection. Fall back to matchSkill only
  // for "general" (stage hint missed) so non-skill tools — Read/Glob/etc —
  // never light up a chip just because their input mentions one of the
  // skill names listed in the system prime.
  const skillId = skillIdForStage(stage) || (stage === "general" || !stage ? matchSkill(name, input) : null);
  if (skillId) markSkillCalled(skillId);
  renderToolEntry({ id, name, stage, input, status: "running", skillId });
}

function handleToolCompleted({ id, name, stage, stdout, stderr, isError, durationMs }) {
  updateToolEntry({ id, status: isError ? "error" : "done", stdout, stderr, durationMs });
  let skillId = null;
  if (id) {
    const li = els.console.querySelector(`.tool-entry[data-tool-id="${cssEscape(id)}"]`);
    if (li && li.dataset.skillId) skillId = li.dataset.skillId;
  }
  // No stdout fallback — the system prime mentions all three skill
  // executables by name, so any incidental Bash that prints a slice of the
  // prime or an ls of skills/ would otherwise flip an unrelated chip to
  // "ready". Stage is the only fallback we trust.
  if (!skillId) skillId = skillIdForStage(stage);
  if (skillId) markSkillCompleted(skillId);

  if (isError) {
    addConsoleEntry(stage || "general", `Tool ${name || ""} failed · expand entry for stderr.`);
  }

  if (stage === "cuopt") {
    if (state.cuoptResolved) {
      addConsoleEntry("cuopt", "cuopt completed again — ignoring duplicate.");
      return;
    }
    const cleaned = (stdout || "").trim();
    const bgMatch = cleaned.match(/Command running in background with ID:\s*([\w-]+)/i);
    if (bgMatch && !isError) {
      state.cuoptBackgroundBashId = bgMatch[1];
      setStageSubstate("cuopt", "streaming");
      addConsoleEntry("cuopt", `cuopt backgrounded by harness (bash id ${bgMatch[1].slice(0,8)}). Waiting for output…`);
      return;
    }
    const result = parseCuoptToolOutput(stdout, isError);
// Don't commit cuoptResolved on parse_failed — a false-positive sta
        //   +ge match                                                                
     // (e.g. reading a skill file whose path contains "max-supply/run.py
          // +") should                                                               
         // not block the real cuopt result from being processed.            
    if (result.status === "fallback" && result.reason === "parse_failed") {
	    addConsoleEntry("cuopt", "cuopt stage tool returned unparseable output — waiting for real result.");
	    return;                                                           
    }
	  applyCuoptResult(result);
    return;
  }

  // Layer 3: cuopt sat in the background; look for its real output in any
  // subsequent tool result. Mirrors the vision background-capture pattern.
  if (state.cuoptBackgroundBashId && !isError && stage !== "cuopt" &&
      !state.cuoptResolved && looksLikeCuoptResult(stdout)) {
    const result = parseCuoptToolOutput(stdout, false);
    applyCuoptResult(result);
    state.cuoptBackgroundBashId = null;
    addConsoleEntry("cuopt", "Captured backgrounded cuopt output.");
  }

  // Layer 4: stage inference missed the cuopt command (e.g. the STAGE_HINTS
  // didn't match the exact command string). Scan every tool result for the
  // cuopt.result envelope shape as a final safety net.
  if (!state.cuoptResolved && !isError && stage !== "cuopt" &&
      looksLikeCuoptResult(stdout)) {
    const result = parseCuoptToolOutput(stdout, false);
    if (result.status !== "fallback") {
      applyCuoptResult(result);
      addConsoleEntry("cuopt", "Captured cuopt result (stage-hint miss).");
    }
  }

  if (stage === "vision") {
    const cleaned = (stdout || "").trim();
    // Background path is only meaningful when the tool actually ran — exit
    // 2/3/5 won't carry a "Command running in background" preamble.
    const bgMatch = !isError ? cleaned.match(/Command running in background with ID:\s*([\w-]+)/i) : null;
    if (bgMatch) {
      state.visionBackgroundBashId = bgMatch[1];
      setStageSubstate("vision", "streaming");
      addConsoleEntry("vision", `Vision call backgrounded by harness (bash id ${bgMatch[1].slice(0, 8)}). Waiting for real output…`);
    } else {
      // Render whatever we have. extractVisionSummary handles both structured
      // (**Observations** / ## Insights) and unstructured prose (it falls
      // back to a sentence-boundary clip near 900 chars). The full-analysis
      // <details> below the summary always shows raw stdout, so even when
      // the extractor returns a generic clip the audience can dig in.
      //
      // The looksLikeVisionResult heuristic is intentionally NOT a gate
      // here — it was rejecting valid Nemotron output that didn't happen to
      // use `**Section**` / `## Section` headers (e.g. numbered lists), which
      // left the skeleton shimmering forever.
      if (cleaned) {
        const summary = extractVisionSummary(cleaned);
        state.visionTextAccumulator = summary;
        state.visionFullText = cleaned;
        updateVisionCopy(summary);
      }

      // Failed/truncated/done decision is orthogonal to whether we rendered.
      // Truncation can be inferred from a non-zero exit OR from stderr
      // markers vision_analyze.py prints when the model didn't reach `stop`.
      const stderrText = stderr || "";
      const truncated = isError
        || /finish_reason\s*=?\s*length|response was truncated|no final answer was returned/i.test(stderrText);

      if (!cleaned) {
        finalizeVisionFailed(stderrText);
      } else if (truncated) {
        finalizeVisionTruncated();
      } else {
        finalizeVisionDone();
      }
    }
  }

  // Layer 3: a vision call is sitting in the background. Watch every later tool
  // result — regardless of inferred stage — for the structured Nemotron section
  // markers. The agent could surface the real output via BashOutput(bash_id),
  // Read(<.output file>), or `cat <.output file>`; we don't care which path,
  // only that the stdout looks like a Nemotron readout.
  if (state.visionBackgroundBashId && !isError && stage !== "vision" && looksLikeVisionResult(stdout)) {
    const summary = extractVisionSummary(stdout);
    if (summary) {
      state.visionTextAccumulator = summary;
      state.visionFullText = (stdout || "").trim();
      updateVisionCopy(summary);
      finalizeVisionDone();
      state.visionBackgroundBashId = null;
      addConsoleEntry("vision", "Captured backgrounded Vision Insights output.");
    }
  }

  if (stage === "aiq") {
    parseAiqToolOutput(stdout || "", name, isError);
  }
}

// Shared vision-done UI commit, used by both the synchronous and the
// recovered-from-background paths.
function finalizeVisionDone() {
  els.visionConfidence.textContent = "high confidence";
  els.visionConfidence.className = "confidence-chip";
  if (els.visionImageWrap) els.visionImageWrap.classList.remove("is-analyzing");
  setStageSubstate("vision", "done");
  const newScore = Math.min(state.optimizedScore - 8, state.baselineScore + 35);
  if (newScore > state.currentScore) animateScore(state.currentScore, newScore, 1200);
}

// Partial output: model hit the token budget. We rendered whatever stdout
// carried, but the audience should know the analysis was cut short — show a
// warn chip + toast and still advance so downstream stages aren't blocked.
function finalizeVisionTruncated() {
  els.visionConfidence.textContent = "partial · truncated";
  els.visionConfidence.className = "confidence-chip is-warn";
  if (els.visionImageWrap) els.visionImageWrap.classList.remove("is-analyzing");
  setStageSubstate("vision", "done");
  addConsoleEntry("vision", "Vision Insights hit the token budget — partial output shown.");
  showToast("warn", "Vision Insights truncated — model hit the token budget. Partial output shown; raise --reasoning-budget or --max-tokens for a full analysis.", 8000);
  const newScore = Math.min(state.optimizedScore - 8, state.baselineScore + 35);
  if (newScore > state.currentScore) animateScore(state.currentScore, newScore, 1200);
}

// Hard failure: no usable Nemotron readout. Mark the stage failed so the rail
// shows the failure indicator instead of an indefinite spinner.
function finalizeVisionFailed(stderrText) {
  els.visionConfidence.textContent = "analysis failed";
  els.visionConfidence.className = "confidence-chip is-failed";
  if (els.visionImageWrap) els.visionImageWrap.classList.remove("is-analyzing");
  if (els.visionCopy) {
    els.visionCopy.innerHTML = `
      <div class="vision-failed-note">
        <strong>Vision Insights unavailable.</strong>
        The Nemotron Omni call did not return a usable analysis. Check the run trace for the script's stderr.
      </div>
    `;
  }
  if (els.visionFullRow) {
    els.visionFullRow.innerHTML = "";
    els.visionFullRow.hidden = true;
  }
  setStageSubstate("vision", "failed");
  const tail = (stderrText || "").trim().split("\n").slice(-1)[0] || "";
  addConsoleEntry("vision", `Vision Insights failed${tail ? " — " + truncate(tail, 200) : ""}`);
  showToast("error", "Vision Insights failed — see run trace for details.", 8000);
}

// Heuristic: does this stdout look like a real Nemotron readout? We require
// at least one of the structured section markers the vision-insights chart
// preset asks Nemotron to emit (skills/vision-insights/scripts/vision_analyze.py).
function looksLikeVisionResult(text) {
  if (!text || text.length < 80) return false;
  return /(?:^|\n)\s*(?:\*\*|#{1,3}\s+)(?:observations?|insights?|key\s+insights?|actionable\s+recommendations?|summary|conclusion)\b/i.test(text);
}

function parseAiqToolOutput(stdout, _name, isError) {
  // The canonical happy path now is `aiq.py research "<query>" shallow_researcher`,
  // which prints a single `json.dumps(report, indent=2)` blob on success and a
  // single status-dict blob on failure (with non-zero exit). We try a clean
  // JSON.parse first and fall back to the legacy regex probes if that fails
  // — that fallback keeps us resilient if the agent ignores the prompt and
  // calls `aiq.py chat` (which emits an OpenAI-shape envelope or a
  // `deep_research_running` sentinel).
  const trimmed = (stdout || "").trim();
  if (!trimmed) {
    if (isError) {
      showToast("error", "AIQ research failed with no output. Check the run trace for stderr.");
      addConsoleEntry("aiq", "AIQ research returned no stdout.");
    }
    return;
  }

  // ---- Path 1: structured JSON (research command, primary path) ----
  // aiq.py prints a WARNING about AIQ_INSECURE + status-update lines to stderr,
  // and the harness's Bash tool typically merges stderr into the stdout buffer
  // we receive. So the JSON envelope often comes AFTER non-JSON preamble. Try
  // parsing the whole thing first (clean case), then fall back to slicing from
  // the first `{`.
  let obj = null;
  try { obj = JSON.parse(trimmed); } catch (_) { /* fall through */ }
  if (!obj) {
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace > 0) {
      try { obj = JSON.parse(trimmed.slice(firstBrace)); } catch (_) { /* still no JSON */ }
    }
  }
  if (obj && typeof obj === "object") {
    const status = (obj.status || obj.job_status?.status || "").toString().toLowerCase();

    // Failure / timeout (research exited 1 with the last polled status dict).
    if (["failed", "failure", "cancelled", "timeout"].includes(status)) {
      const reason = obj.error || obj.message || obj.detail || obj.reason || status;
      showToast("error", `AIQ research did not complete: ${reason}`);
      addConsoleEntry("aiq", `AIQ research ended in state "${status}" · expand entry for full output.`);
      return;
    }

    // Defensive: agent ignored the prompt and used `chat`, which auto-routed to deep.
    if (status === "deep_research_running" && obj.job_id) {
      state.aiqJobId = obj.job_id;
      if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
      appendResearchFeed("Deep research job started · " + state.aiqJobId.slice(0, 8), true);
      setSourceCounter(15);
      showToast("error", "AIQ Research returned an unexpected routing response. Check the run trace for details.");
      return;
    }

    // Success: extract report text from the report JSON. Schema isn't fixed,
    // so probe common locations.
    const content = findReportContent(obj);
    if (content && content.length > 80) {
      state.planReportRaw = content;             // keep the original aiq.py report verbatim
      state.planTextAccumulator = content;
      state.planSections = parsePlanSections(content);
      renderPlanLive();
      renderPlanTabs();
      setSourceCounter(100);
      const newScore = Math.min(state.optimizedScore, state.currentScore + 12);
      if (newScore > state.currentScore) animateScore(state.currentScore, newScore, 1100);
      return;
    }

    // Parsed JSON but no recognised content field — dump the JSON in so the
    // agent's downstream synthesis can still append its `## Strategy/...` block,
    // which parsePlanSections will then route to the correct tabs.
    const dumped = JSON.stringify(obj, null, 2);
    state.planTextAccumulator = dumped;
    state.planSections = parsePlanSections(dumped);
    renderPlanLive();
    renderPlanTabs();
    if (isError) {
      showToast("error", "AIQ research returned a non-zero exit with unrecognised payload. See run trace.");
    }
    return;
  }

  // ---- Path 2: non-JSON stdout (legacy `chat` shape or partial output) ----

  const drMatch = trimmed.match(/"status"\s*:\s*"deep_research_running"[^}]*?"job_id"\s*:\s*"([^"]+)"/);
  if (drMatch) {
    state.aiqJobId = drMatch[1];
    if (!document.querySelector(".plan-researching")) renderPlanResearching(0);
    appendResearchFeed("Deep research job started · " + state.aiqJobId.slice(0, 8), true);
    setSourceCounter(15);
    showToast("error", "AIQ Research returned an unexpected routing response. Check the run trace for details.");
    return;
  }

  const contentMatch = trimmed.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (contentMatch) {
    const decoded = jsonStringDecode(contentMatch[1]);
    if (decoded.length > 80) {
      state.planReportRaw = decoded;
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

  if (trimmed.includes("need_browser_login")) {
    showToast("error", "AIQ auth required — run `python3 skills/aiq-research/scripts/aiq.py login` on the host.");
    addConsoleEntry("aiq", "AIQ auth needed: agent reported need_browser_login.");
    return;
  }

  // Last resort: nothing matched.
  if (isError) {
    showToast("error", "AIQ research failed. Check the run trace for details.");
    addConsoleEntry("aiq", "AIQ research returned non-zero exit · expand entry for output.");
  }
}

// Probe a parsed AIQ report JSON for the section of text we care about. The
// report schema isn't fixed (it depends on the AIQ backend's renderer), so we
// check the obvious top-level fields, the OpenAI chat-completions envelope,
// and recurse into common nesting containers. Returns the first string
// longer than 80 chars, or null.
function findReportContent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const directKeys = ["content", "result", "report", "final_answer", "answer", "text", "message", "output"];
  for (const k of directKeys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 80) return v;
  }
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    if (c.message && typeof c.message.content === "string" && c.message.content.length > 80) return c.message.content;
    if (typeof c.text === "string" && c.text.length > 80) return c.text;
  }
  const nestedKeys = ["result", "data", "report", "response", "payload", "body", "job_state", "artifact"];
  for (const k of nestedKeys) {
    if (obj[k] && typeof obj[k] === "object") {
      const inner = findReportContent(obj[k]);
      if (inner) return inner;
    }
  }
  return null;
}

function extractVisionSummary(text) {
  if (!text) return "";

  // The vision chart preset (skills/vision-insights/scripts/vision_analyze.py)
  // tells Nemotron Omni to end with `**Observations**`, `**Insights**`,
  // `**Actionable Recommendations**` — BOLD section labels, not `##` headers.
  // The old regex only matched `##`-prefixed headings, so the structured path
  // never triggered and we fell into a hard 500-char slice that cut mid-word.
  //
  // Line-based parser that recognises both `## Heading` and `**Bold**` section
  // markers (and inline content after `:`), then picks the most useful section.
  const SECTION_NAMES = /^(observations?|insights?|key\s+insights?|summary|tl;?\s*dr|conclusion|actionable\s+recommendations?|recommendations?)\b/i;

  const lines = text.split("\n");
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].trim();
    if (!s) continue;
    // Strip leading decorations: list bullets (with required space so a `**`
    // bold opener isn't eaten), markdown header `#`s, bold openers, numbered
    // prefixes. Loop because decorations can stack: `- **Insights**`.
    let prev;
    do {
      prev = s;
      s = s.replace(/^[>*\-]\s+/, "");
      s = s.replace(/^#{1,6}\s*/, "");
      s = s.replace(/^\*\*\s*/, "");
      s = s.replace(/^\d+[.):]\s*/, "");
    } while (s !== prev);

    const m = s.match(SECTION_NAMES);
    if (!m) continue;
    // The keyword must be followed by either end-of-line or a separator
    // (`:`, `*`, `-`, `–`, `—`). Anything else means it's prose, not a header
    // (e.g. "Insights suggest the operator should…").
    const after = s.slice(m[0].length);
    if (after.trim() && !/^[\s:\-–—*]/.test(after)) continue;

    // Capture inline content after a clear separator (`:` or `**`).
    let inline = "";
    if (/[:*]/.test(after)) {
      inline = after
        .replace(/^\s*\*+\s*/, "")   // bold close before colon
        .replace(/^\s*:\s*/, "")     // colon separator
        .replace(/^\s*\*+\s*/, "")   // bold close after colon
        .replace(/\s*\*+\s*$/, "")   // trailing bold close
        .trim();
    }

    headers.push({
      name: normalizeVisionSection(m[1]),
      lineIndex: i,
      inline
    });
  }

  if (headers.length > 0) {
    const sections = {};
    for (let i = 0; i < headers.length; i++) {
      const cur = headers[i];
      const next = headers[i + 1];
      const startLine = cur.lineIndex + 1;
      const endLine = next ? next.lineIndex : lines.length;
      const trailing = lines.slice(startLine, endLine).join("\n").trim();
      const body = collapseMarkdown([cur.inline, trailing].filter(Boolean).join("\n")).trim();
      if (body.length > 20 && !sections[cur.name]) {
        sections[cur.name] = body;
      }
    }
    // Prefer Insights (the highest-value content) → Summary → Observations →
    // Recommendations. The chart preset emits all four; we surface the best one.
    for (const k of ["insights", "summary", "observations", "recommendations"]) {
      if (sections[k]) return sections[k].slice(0, 1500);
    }
  }

  // Fallback: full prose, clipped at a sentence boundary near 900 chars so we
  // never dangle mid-word (the original bug shipped a hard 500-char .slice).
  const proseLines = text.split(/\n+/).filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith("|")) return false;     // markdown table row
    if (t.startsWith("#")) return false;     // markdown heading
    if (t.startsWith("**") && t.endsWith("**")) return false;  // bold heading on its own line
    return true;
  });
  return clipToSentence(collapseMarkdown(proseLines.join(" ")), 900);
}

function normalizeVisionSection(raw) {
  const lower = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (lower.includes("insight")) return "insights";          // "insight(s)", "key insight(s)"
  if (lower.startsWith("observation")) return "observations";
  if (lower === "summary" || lower.startsWith("tl") || lower === "conclusion") return "summary";
  if (lower.includes("recommend") || lower.includes("actionable")) return "recommendations";
  return lower;
}

function clipToSentence(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  const slice = text.slice(0, maxLen);
  // Find the latest sentence terminator in the back half of the slice so we
  // don't truncate to a near-empty result on short text.
  let lastEnd = -1;
  for (const sep of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
    const idx = slice.lastIndexOf(sep);
    if (idx > lastEnd) lastEnd = idx;
  }
  if (lastEnd > maxLen * 0.5) return slice.slice(0, lastEnd + 1).trim();
  return slice.trim() + "…";
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

  // The summary lives inside #vision-copy (the right column of .vision-body's
  // image|text grid). The full-analysis <details> lives in #vision-full-row,
  // a separate full-width row BELOW .vision-body — otherwise expanding it
  // stretches the right column, which (with align-items: stretch) forces the
  // image column tall and the image goes out of aspect ratio.
  // extractVisionSummary returns one section (usually Insights ~800 chars),
  // but vision_analyze.py emits much more (numbered chart-reading sections,
  // observations, recommendations). Surface the full text so the audience can dig in.
  const fullText = state.visionFullText && state.visionFullText !== trimmed
    ? state.visionFullText
    : null;

  els.visionCopy.innerHTML = `<div class="vision-summary"></div>`;
  const summaryEl = els.visionCopy.querySelector(".vision-summary");

  if (els.visionFullRow) {
    if (fullText) {
      els.visionFullRow.innerHTML = `
        <details class="vision-full-details" open>
          <summary>
            <span class="full-summary-label">Full analysis (${fullText.length.toLocaleString()} chars)</span>
            <button class="print-pdf-button" type="button" data-print-pdf="vision" aria-label="Print vision analysis as PDF">
              <svg class="print-pdf-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3h10v5H7zM5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2zm2 10h10v3H7zm12-6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"></path>
              </svg>
              <span>Print as PDF</span>
            </button>
          </summary>
          <pre class="vision-full-body"></pre>
        </details>
      `;
      const fullBodyEl = els.visionFullRow.querySelector(".vision-full-body");
      if (fullBodyEl) fullBodyEl.textContent = fullText;   // <pre>+textContent preserves tables/markdown
      const printBtn = els.visionFullRow.querySelector('[data-print-pdf="vision"]');
      if (printBtn) {
        printBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          printAsPdf("Vision Insights — Full Analysis", state.visionFullText || "");
        });
      }
      els.visionFullRow.hidden = false;
    } else {
      els.visionFullRow.innerHTML = "";
      els.visionFullRow.hidden = true;
    }
  }

  if (REDUCED_MOTION || state.hasInitializedVisionTypewriter) {
    summaryEl.textContent = trimmed;
  } else {
    state.hasInitializedVisionTypewriter = true;
    // Scale speed with length so a longer Insights extraction doesn't take 30s.
    // 40 cps was fine for the old 500-char hard slice; bump for longer text.
    const cps = trimmed.length > 600 ? 120 : 60;
    typewrite(summaryEl, trimmed, cps);
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
  // We render the full input into the preview so the user can read it via the
  // expand toggle even while the tool is still running. The CSS clamps the
  // collapsed view to ~2 lines; the toggle reveals the rest. Cap at 4000 chars
  // so a pathological 1 MB heredoc doesn't bloat the DOM.
  if (!input) return "";
  if (typeof input === "string") return truncate(input, 4000);
  const n = (name || "").toLowerCase();
  if (n === "bash") return truncate(input.command || "", 4000);
  if (n === "read" || n === "read_file") return truncate(input.file_path || input.path || "", 4000);
  if (n === "write" || n === "write_file") return truncate((input.file_path || input.path || "") + " (write)", 4000);
  if (n === "edit" || n === "edit_file") return truncate((input.file_path || input.path || "") + " (edit)", 4000);
  const json = (() => { try { return JSON.stringify(input, null, 2); } catch (_) { return "(unstringifiable)"; } })();
  return truncate(json, 4000);
}

// Decide whether a tool-preview block needs an expand toggle. The CSS clamps
// the collapsed view to max-height: 4em, which fits ~2 lines at the trace
// font-size. Anything longer than that — by char count or by line count —
// gets the toggle so the user can see the full content.
function shouldShowToolToggle(text) {
  if (!text) return false;
  if (text.length > 120) return true;
  if (text.split("\n").length > 2) return true;
  return false;
}

// Idempotent: creates the toggle if missing, removes it if no longer needed,
// and reflects the current expanded state. `label` is the "show more" wording
// (we swap to "Collapse" when expanded). Used by both renderToolEntry (input
// preview) and updateToolEntry (stdout preview), so a user who expanded a
// running tool keeps their expanded view after it completes.
function ensureToolToggle(li, text, label) {
  if (!li) return;
  if (!shouldShowToolToggle(text)) {
    const existing = li.querySelector(".tool-toggle");
    if (existing) existing.remove();
    li.classList.remove("is-expanded");
    return;
  }
  let toggle = li.querySelector(".tool-toggle");
  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tool-toggle";
    toggle.addEventListener("click", () => {
      const expanded = li.classList.toggle("is-expanded");
      toggle.textContent = expanded ? "Collapse" : (li.dataset.expandLabel || "Show more");
    });
    const innerWrap = li.querySelector(".tool-meta").parentNode;
    innerWrap.appendChild(toggle);
  }
  li.dataset.expandLabel = label;
  toggle.textContent = li.classList.contains("is-expanded") ? "Collapse" : label;
}

function renderToolEntry({ id, name, stage, input, status, skillId }) {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const li = document.createElement("li");
  li.className = "tool-entry";
  li.dataset.toolId = id || ("tu_" + Math.random().toString(36).slice(2, 8));
  li.dataset.status = status;
  if (skillId) li.dataset.skillId = skillId;
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
  ensureToolToggle(li, inputPreview, "Show full command");
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
    ensureToolToggle(li, text, "Show full output");
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
  // If vision or AIQ starts before cuopt was ever invoked, treat that as
  // an implicit "cuopt was skipped" signal and fire the fallback path so
  // the audience still sees baseline → optimized for Stage 2.
  if ((stage === "vision" || stage === "aiq") &&
      (substate === "calling" || substate === "streaming") &&
      state.stageState.cuopt === "idle" &&
      !state.cuoptResolved) {
    applyCuoptResult({ status: "fallback", reason: "not_invoked" });
    // applyCuoptResult sets state.cuoptResolved itself.
  }

  state.stageState[stage] = substate;
  if (substate === "calling" || substate === "streaming") {
    autoAdvance(stage);
  }
  if (substate === "done") {
    state.completedStages.add(stage);
  }
  if (substate === "failed") {
    // stays where it is; canvas doesn't auto-advance past a failure
  }
  renderStages();
  renderSkillStack();
  renderPlanTabs();
  updateRunSubstatus();
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
  if (stage === "brief") panel = document.querySelector(".prompt-panel");
  else if (stage === "cuopt") panel = document.querySelector(".metric-panel");
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
    case "shimmer": els.baselineRoute?.classList.add("is-solving"); break;
    case "reveal-active":
      els.activeRoute?.classList.add("is-solved");
      els.baselineRoute?.classList.remove("is-solving");
      break;
    case "fade-baseline": els.baselineRoute?.classList.add("is-faded"); break;
    case "reveal-supports":
      els.feederRoute?.classList.add("is-revealed");
      els.portRoute?.classList.add("is-revealed");
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
 * Closing / failure / cancellation
 * ============================================================ */

function finishRun(data) {
  if (!state.running && state.completed) return;
  state.running = false;
  state.completed = true;

  // Safety-net: if the run completed while cuopt was still streaming (e.g. the
  // harness backgrounded the call and never surfaced the real output), or if
  // the agent never called cuopt at all, fire the fallback now so the UI
  // doesn't end on a skeleton or a "skipped" rail pip.
  if (!state.cuoptResolved) {
    applyCuoptResult({
      status: "fallback",
      reason: state.cuoptBackgroundBashId ? "background_timeout" : "not_invoked"
    });
  }

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

  if (state.currentScore > state.baselineScore) {
    els.routeScoreDelta.hidden = false;
    els.routeScoreDelta.textContent = "+" + (state.currentScore - state.baselineScore);
  }

  // Land canvas on Stage 4 (AIQ Research) — even if the user was peeking elsewhere,
  // the run-completion event reorients them to the synthesized output.
  state.autoFollowStage = "aiq";
  state.peekMode = false;
  hideResumePill();
  setActiveCanvas("aiq");

  // Re-render the plan body in case typewriter was mid-stream
  if (state.planTextAccumulator) renderPlanLive();
  renderPlanTabs();

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
  els.runLabel.textContent = "Retry";
  els.runStatus.textContent = "Failed";
  els.consoleDot.classList.remove("is-running");
  els.harnessToggle.removeAttribute("aria-disabled");
  // Mark the currently-active agent stage as failed so the rail shows the "!" indicator.
  const stage = state.autoFollowStage;
  if (stage && stage !== "brief" && state.stageState[stage] !== "done") {
    state.stageState[stage] = "failed";
    renderStages();
    renderSkillStack();
  }
  hideResumePill();
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
  hideResumePill();
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
  updateVisionImage();
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
    updateVisionImage();
  } catch (err) {
    setPromptError("upload error: " + (err && err.message));
  }
}

function resetSampleImage() {
  state.attachedImagePath = (state.data.sample && state.data.sample.imagePath) || SAMPLE_IMAGE_PATH;
  state.attachedImageLabel = (state.data.sample && state.data.sample.imageLabel) || "sample-capacity.png";
  state.attachedImageState = "sample";
  renderAttachedChip();
  updateVisionImage();
}

async function resetToSample() {
  // Reset the attached image to the bundled sample (existing behavior).
  resetSampleImage();
  // Clear the textarea + the sessionStorage draft + re-fetch the default prompt.
  els.promptInput.value = "";
  try { sessionStorage.removeItem(PROMPT_STORAGE_KEY); } catch (_) {}
  await loadDefaultPrompt();
  // Refresh the data-has-input attribute that drives the blinking caret (Task 6).
  if (els.promptZone) {
    els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
  }
  clearPromptError();
}

function detachImage() {
  state.attachedImagePath = null;
  state.attachedImageLabel = null;
  state.attachedImageState = "none";
  renderAttachedChip();
  updateVisionImage();
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
 * Toast + prompt error
 * ============================================================ */

function showToast(level, text, timeoutMs = 6000) {
  const stack = els.toastStack;
  if (!stack) return;
  const toast = document.createElement("div");
  const cls = level === "error" ? "is-error"
            : level === "warn"  ? "is-warn"
            : "is-info";
  toast.className = "toast " + cls;
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
 * Print-as-PDF
 * ============================================================ */

// Minimal markdown → HTML. Covers the subset that aiq.py and vision_analyze.py
// actually emit: ATX headings, *italic*/**bold**, `code`, bullet & numeric
// lists, links, horizontal rules, GFM pipe tables, blank-line paragraphs.
// Fenced code blocks pass through as plain prose — agent output rarely uses
// them for substantive content.
function renderMarkdownForPrint(text) {
  if (!text) return "";
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // A line that *could* be a table row: has at least one pipe character with
  // content on both sides (so a stray `|` in prose won't trigger us). Leading
  // and trailing pipes are both optional in GFM, hence the lenient anchor.
  const isTableRow = (s) => /\|/.test(s) && /\S/.test(s.replace(/\|/g, ""));
  // The separator row under the header — pipes, dashes, optional alignment
  // colons, whitespace only. Must contain at least one dash.
  const isTableSeparator = (s) => /-/.test(s) && /^[\s|:\-]+$/.test(s);

  const splitRow = (s) => {
    // Strip optional outer pipes, split on `|` not preceded by `\`.
    let trimmed = s.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    // Split on un-escaped pipes; unescape `\|` back to literal `|` afterwards.
    return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  };

  const parseAlignments = (sepRow) => splitRow(sepRow).map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const renderTable = (headerRow, sepRow, bodyRows) => {
    const headers = splitRow(headerRow);
    const aligns = parseAlignments(sepRow);
    const styleFor = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : "");
    const headHtml =
      "<thead><tr>" +
      headers.map((h, i) => `<th${styleFor(i)}>${inline(h)}</th>`).join("") +
      "</tr></thead>";
    const bodyHtml =
      "<tbody>" +
      bodyRows.map((row) => {
        const cells = splitRow(row);
        // Pad short rows so columns line up; trim overlong rows.
        while (cells.length < headers.length) cells.push("");
        cells.length = headers.length;
        return "<tr>" + cells.map((c, i) => `<td${styleFor(i)}>${inline(c)}</td>`).join("") + "</tr>";
      }).join("") +
      "</tbody>";
    return `<table>${headHtml}${bodyHtml}</table>`;
  };

  const lines = text.split("\n");
  const out = [];
  let listKind = null;       // "ul" | "ol" | null
  let paraBuf = [];

  const flushPara = () => {
    if (!paraBuf.length) return;
    out.push("<p>" + paraBuf.map(inline).join("<br>") + "</p>");
    paraBuf = [];
  };
  const closeList = () => {
    if (listKind) { out.push(`</${listKind}>`); listKind = null; }
  };
  const openList = (kind) => {
    if (listKind === kind) return;
    closeList();
    out.push(`<${kind}>`);
    listKind = kind;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); closeList(); continue; }

    // Tables — peek ahead one line for the separator row. Has to come before
    // the list/heading checks because a separator like `|---|---|` would
    // otherwise look like a list to nothing.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara(); closeList();
      const headerRow = line;
      const sepRow = lines[i + 1];
      const body = [];
      let j = i + 2;
      while (j < lines.length) {
        const r = lines[j].replace(/\s+$/, "");
        if (!r.trim() || !isTableRow(r)) break;
        body.push(r);
        j++;
      }
      out.push(renderTable(headerRow, sepRow, body));
      i = j - 1;       // for-loop will i++ to land on first non-table line
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara(); closeList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    if (/^---+$|^\*\*\*+$/.test(line.trim())) {
      flushPara(); closeList();
      out.push("<hr>");
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara(); openList("ul");
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      flushPara(); openList("ol");
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    paraBuf.push(line);
  }
  flushPara(); closeList();
  return out.join("\n");
}

// Render the markdown into a hidden <div class="print-target"> inside the
// main document and fire window.print(). @media print rules in styles.css
// hide the running app and reveal the print target only at print time. The
// onafterprint hook tears the container down once the dialog dismisses, so
// the screen state is untouched.
//
// Why this and not a popup: popups force the user to context-switch to a
// second window, and calling popup.print() from the parent blocks the
// parent's main thread (a freeze the user observed and asked us to remove).
// Printing the main window keeps the dialog modal-over-the-app, which is
// the standard browser behavior most users expect.
function printAsPdf(title, text) {
  if (!text || !text.trim()) {
    showToast("warn", "Nothing to print yet — wait for the analysis to finish.");
    return;
  }

  // Drop any stale print container from a previous click that didn't clean
  // up (some browsers can be flaky about firing afterprint on cancel).
  document.querySelectorAll(".print-target").forEach((n) => n.remove());

  const body = renderMarkdownForPrint(text);
  const stamp = new Date().toLocaleString();
  const container = document.createElement("div");
  container.className = "print-target";
  container.setAttribute("role", "document");
  container.innerHTML = `
    <header class="print-head">
      <span class="print-eyebrow">NVIDIA CUDA-X · GTC Taipei supply-chain demo</span>
      <h1>${escapeHtml(title)}</h1>
      <div class="print-meta">Generated ${escapeHtml(stamp)}</div>
    </header>
    <main class="print-body">${body}</main>
    <footer class="print-foot">Printed from the GTC Taipei supply-chain demo — agent-generated content. Verify before distributing.</footer>
  `;
  document.body.appendChild(container);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    window.removeEventListener("afterprint", cleanup);
    container.remove();
  };
  window.addEventListener("afterprint", cleanup);

  // requestAnimationFrame lets the browser commit the DOM insertion before
  // window.print() is invoked, so the print preview captures the target
  // element. window.print() is synchronous: it blocks the main thread until
  // the dialog dismisses (which is the standard, expected behavior). When
  // it returns, afterprint has already fired and cleanup has run.
  requestAnimationFrame(() => {
    try { window.print(); }
    catch (_) {
      showToast("error", "Print failed — your browser refused window.print(). Try Cmd/Ctrl+P.");
      cleanup();
      return;
    }
    // Belt-and-suspenders for browsers (older Safari, in-app webviews) that
    // don't reliably fire afterprint. Schedule a fallback teardown so a
    // stale .print-target can't linger past the dialog dismissal.
    setTimeout(cleanup, 60000);
  });
}

/* ============================================================
 * Boot
 * ============================================================ */

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="app-shell"><section class="panel"><div class="panel-heading"><h1>Demo failed to load</h1></div><p class="insight-copy">${escapeHtml(error && error.message)}</p></section></main>`;
});
