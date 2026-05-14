# Terminal-Styled Prompt Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Stage 1 "Task Overview" prompt panel as a stylized Codex / Claude Code terminal pane, swap visuals based on the existing harness toggle, remove the Taiwan map from Stage 1, and widen the "reset to sample" button to also restore the default prompt text.

**Architecture:** Pure visual change. ~200 lines of new CSS using existing `body[data-harness]` theme switching, an HTML restructure inside the existing prompt-panel article (preserving every element ID `app.js` references), one-attribute change to the route-panel's `data-stage-canvas`, two tiny app.js edits (new `resetToSample()` + `data-has-input` toggle). No changes to the orchestrator, normalizers, skill scripts, data, or tests.

**Tech Stack:** Vanilla HTML/CSS/JS (no bundler), CSS custom properties driven by `body[data-harness="codex|claude"]`.

**Spec reference:** `docs/superpowers/specs/2026-05-14-terminal-prompt-design.md`.

---

## File map

| File | Action | Why |
|---|---|---|
| `styles.css` | Modify | Add `:root` terminal theme tokens + `body[data-harness="claude"]` overrides + `.sr-only` utility + ~150 lines of `.terminal-*` rules + `prefers-reduced-motion` clause |
| `index.html` | Modify | Restructure the `<article class="panel prompt-panel">` body to the terminal markup; move `<h2 id="prompt-title">` to a `.sr-only` span; restructure `#prompt-summary` to include `terminal-submitted` styling; flip the route-panel's `data-stage-canvas` from `"brief cuopt"` to `"cuopt"` |
| `app.js` | Modify | Add new `resetToSample()` function; rewire `prompt-reset-sample` button to call it; add `data-has-input` toggle in the existing `prompt-input` input handler and once at boot |

All other files unchanged (server/, skills/, data/, scripts/, docs/).

---

## Task 1: CSS — terminal theme tokens, sr-only utility, chrome + body

**Files:**
- Modify: `styles.css` (add to `:root`, add new `body[data-harness="claude"]` overrides for terminal tokens, append `.sr-only` + `.terminal-panel`/`.terminal-titlebar`/`.terminal-body`/`.terminal-prompt-row`/`.terminal-input` rules at the end)

- [ ] **Step 1: Add terminal theme tokens to `:root`**

In `styles.css`, find the existing `:root` block (around lines 1-24). Add the terminal tokens at the end of `:root`, before the closing `}`:

```css
  --term-bg:       #0c0e0c;
  --term-border:   rgba(255, 255, 255, 0.10);
  --term-chrome:   rgba(255, 255, 255, 0.04);
  --term-ink:      #e8efe1;
  --term-ink-dim:  rgba(232, 239, 225, 0.55);
  --term-glyph:    var(--accent);
  --term-caret:    var(--accent);
  --term-mono:     "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* Codex default (overridden under body[data-harness="claude"]) */
  --term-cmd:    "codex";
  --term-status: "gpt-5.5 xhigh · ready";
```

- [ ] **Step 2: Add Claude-harness overrides**

Find the existing `body[data-harness="claude"] { ... }` block (around line 36). Add inside it (alongside the existing `--accent` etc. lines):

```css
  --term-cmd:    "claude";
  --term-status: "claude-opus-4-7[1m] · ready";
```

- [ ] **Step 3: Append `.sr-only` utility**

At the end of `styles.css`, before the final `@media` block, append:

```css
/* ---------- sr-only utility (for the visually-hidden h2 inside the terminal pane) ---------- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 4: Append terminal pane chrome + body styles**

Continue appending at the end of `styles.css` (after the sr-only block):

```css
/* ---------- Terminal-styled prompt panel (Stage 1) ---------- */

.terminal-panel {
  padding: 0;
  background: var(--term-bg);
  border: 1px solid var(--term-border);
  overflow: hidden;
}

.terminal-titlebar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  background: var(--term-chrome);
  border-bottom: 1px solid var(--term-border);
  font-family: var(--term-mono);
  font-size: 0.78rem;
  color: var(--term-ink-dim);
  user-select: none;
}
.terminal-traffic { display: inline-flex; gap: 6px; }
.terminal-traffic .dot { width: 11px; height: 11px; border-radius: 50%; }
.dot-red    { background: #ff5f56; }
.dot-yellow { background: #ffbd2e; }
.dot-green  { background: #27c93f; }

.terminal-title-text {
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}
.terminal-title-cmd { color: var(--term-ink); font-weight: 600; }
.terminal-title-cmd::before { content: var(--term-cmd); }
.terminal-title-sep { opacity: 0.4; }
.terminal-title-cwd {
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-title-status { margin-left: auto; font-size: 0.72rem; white-space: nowrap; }
.terminal-title-status::before { content: var(--term-status); }
.terminal-title-status::after  { content: "•"; margin-left: 8px; color: #27c93f; }

.terminal-body {
  padding: 16px 18px;
  font-family: var(--term-mono);
}

.terminal-attached {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.82rem;
}
.terminal-attached-glyph { font-weight: 700; }
.terminal-attached-name  { color: var(--term-ink); }
.terminal-attached-clear {
  border: 0;
  background: transparent;
  color: var(--term-ink-dim);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
.terminal-attached-clear:hover { color: var(--term-ink); }

.terminal-prompt-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 8px;
}
.terminal-prompt-glyph {
  font-size: 1.05rem;
  color: var(--term-glyph);
  line-height: 1.4;
  padding-top: 2px;
  position: relative;
}
.terminal-input {
  width: 100%;
  min-height: 4.2em;
  resize: vertical;
  border: 0;
  background: transparent;
  color: var(--term-ink);
  font-family: var(--term-mono);
  font-size: 0.95rem;
  line-height: 1.55;
  outline: 0;
  caret-color: var(--term-caret);
  padding: 0;
}
.terminal-input::placeholder {
  color: var(--term-ink-dim);
  font-style: italic;
}
```

- [ ] **Step 5: Verify CSS still parses + tests still pass**

Run: `npm test`
Expected: PASS (static checks unchanged).

Start the server briefly to confirm the page still parses (existing `prompt-panel` markup isn't styled by these new rules yet — page should look unchanged at this point):

```bash
PID=$(ss -lntp 2>/dev/null | grep ':4173' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then kill $PID; sleep 1; fi
nohup npm start > /tmp/cuopt-server.log 2>&1 &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4173/styles.css
```
Expected: `200`.

- [ ] **Step 6: Commit**

```bash
git add styles.css
git commit -m "feat(ui): add terminal theme tokens + sr-only utility + chrome/body styles"
```

---

## Task 2: CSS — blinking caret, footer, submitted state

**Files:**
- Modify: `styles.css` (append more rules at the end)

- [ ] **Step 1: Append caret + reduced-motion rules**

Continue appending at the end of `styles.css`:

```css
/* Caret only appears in edit state. Scoped to .terminal-body so the
   submitted-state glyph (inside .terminal-submitted) doesn't show a
   stale blinking caret. */
.terminal-body .terminal-prompt-glyph::after {
  content: "▌";
  display: inline-block;
  margin-left: 6px;
  color: var(--term-caret);
  animation: term-blink 1.05s steps(1, end) infinite;
}
.terminal-body:focus-within .terminal-prompt-glyph::after,
.terminal-body[data-has-input="true"] .terminal-prompt-glyph::after {
  display: none;
}
@keyframes term-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .terminal-body .terminal-prompt-glyph::after { animation: none; }
}
```

- [ ] **Step 2: Append footer + action + keyboard-hints styles**

```css
.terminal-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  padding-top: 10px;
  border-top: 1px solid var(--term-border);
  font-size: 0.78rem;
  color: var(--term-ink-dim);
}
.terminal-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--term-border);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--term-ink);
  font-family: var(--term-mono);
  font-size: 0.78rem;
  cursor: pointer;
}
.terminal-action:hover { border-color: var(--accent); color: var(--accent); }
.terminal-keys { margin-left: auto; }
.terminal-keys kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--term-border);
  border-radius: 3px;
  font-family: var(--term-mono);
  font-size: 0.72rem;
  color: var(--term-ink);
  background: var(--term-chrome);
}
.terminal-error {
  flex-basis: 100%;
  margin: 4px 0 0;
  color: #ff8a7a;
  font-size: 0.78rem;
}
```

- [ ] **Step 3: Append submitted-state styles**

```css
.terminal-submitted {
  background: var(--term-bg);
  padding: 14px 18px;
  font-family: var(--term-mono);
  color: var(--term-ink);
}
.terminal-submitted-line {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px;
  align-items: start;
}
.terminal-submitted-line .terminal-prompt-glyph { padding-top: 0; }
.terminal-submitted-line .prompt-summary-text {
  margin: 0;
  color: var(--term-ink);
  font-size: 0.95rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.terminal-submitted-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--term-border);
  font-size: 0.78rem;
  color: var(--term-ink-dim);
}
.terminal-submitted-meta .prompt-summary-attached:not(:empty)::before {
  content: "@";
  margin-right: 4px;
  font-weight: 700;
  color: var(--accent);
}
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4173/styles.css
```
Expected: `200`. (Server is already running from Task 1; if not, restart.)

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "feat(ui): add terminal caret blink, footer actions, submitted-state styles"
```

---

## Task 3: HTML — replace prompt-panel body with terminal markup

**Files:**
- Modify: `index.html` (the `<article class="panel prompt-panel">` block inside `#canvas-brief` and the `#prompt-summary` block at the bottom of the same article)

- [ ] **Step 1: Replace the prompt-panel article**

Find the entire existing `<article class="panel prompt-panel">` element inside `#canvas-brief` (currently lines ~109-146). Replace the WHOLE article with:

```html
<article class="panel terminal-panel" aria-labelledby="prompt-title">
  <h2 id="prompt-title" class="sr-only">Ask the agent</h2>

  <header class="terminal-titlebar">
    <span class="terminal-traffic" aria-hidden="true">
      <i class="dot dot-red"></i><i class="dot dot-yellow"></i><i class="dot dot-green"></i>
    </span>
    <span class="terminal-title-text">
      <span class="terminal-title-cmd"></span>
      <span class="terminal-title-sep">—</span>
      <span class="terminal-title-cwd">~/gtc-taipei-demo</span>
    </span>
    <span class="terminal-title-status"></span>
  </header>

  <div class="terminal-body" id="prompt-zone">
    <div class="terminal-attached" id="prompt-attached" data-state="sample" hidden>
      <span class="terminal-attached-glyph" aria-hidden="true">@</span>
      <span class="terminal-attached-name" id="prompt-attached-name">sample-capacity.png</span>
      <button class="terminal-attached-clear" type="button" id="prompt-attached-clear" aria-label="Detach image">×</button>
    </div>

    <div class="terminal-prompt-row">
      <span class="terminal-prompt-glyph" aria-hidden="true">❯</span>
      <textarea id="prompt-input" class="terminal-input" rows="3" spellcheck="false"
        placeholder="Describe the research brief — the agent will decide which skills to call."></textarea>
    </div>

    <footer class="terminal-footer">
      <label class="terminal-action" for="prompt-attach-input">
        <span class="terminal-action-glyph" aria-hidden="true">↳</span> attach image
      </label>
      <input type="file" id="prompt-attach-input" accept="image/png,image/jpeg,image/webp" hidden>
      <button class="terminal-action" type="button" id="prompt-reset-sample">↺ reset to sample</button>
      <span class="terminal-keys"><kbd>shift</kbd>+<kbd>↵</kbd> newline · <kbd>↵</kbd> send</span>
      <p class="prompt-error terminal-error" id="prompt-error" role="alert" hidden></p>
    </footer>
  </div>

  <div class="prompt-summary terminal-submitted" id="prompt-summary" hidden>
    <div class="terminal-submitted-line">
      <span class="terminal-prompt-glyph" aria-hidden="true">❯</span>
      <p class="prompt-summary-text" id="prompt-summary-text"></p>
    </div>
    <div class="terminal-submitted-meta">
      <span class="prompt-summary-attached" id="prompt-summary-attached"></span>
      <button class="ghost-action prompt-edit-button" type="button" id="prompt-edit-button">↺ edit</button>
    </div>
  </div>
</article>
```

Important — these IDs MUST be preserved (they are referenced by `app.js`'s `collectEls()` and event wiring): `prompt-title`, `prompt-zone`, `prompt-attached`, `prompt-attached-name`, `prompt-attached-clear`, `prompt-input`, `prompt-attach-input`, `prompt-reset-sample`, `prompt-error`, `prompt-summary`, `prompt-summary-text`, `prompt-summary-attached`, `prompt-edit-button`.

- [ ] **Step 2: Verify HTML parses + page loads**

```bash
npm test 2>&1 | tail -3
```
Expected: PASS.

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download} bytes\n" http://localhost:4173/
```
Expected: `200 <size> bytes`.

- [ ] **Step 3: Confirm IDs survived the rewrite**

```bash
for id in prompt-title prompt-zone prompt-attached prompt-attached-name prompt-attached-clear prompt-input prompt-attach-input prompt-reset-sample prompt-error prompt-summary prompt-summary-text prompt-summary-attached prompt-edit-button; do
  if grep -q "id=\"$id\"" /home/nvidia/gtc-taipei-demo/index.html; then echo "  $id ✓"; else echo "  $id ✗ MISSING"; fi
done
```
Expected: every ID prints `✓`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): replace prompt-panel with terminal-styled markup; move h2 to sr-only"
```

---

## Task 4: HTML — remove map from Stage 1 (one-attribute change)

**Files:**
- Modify: `index.html` (the `<article class="panel route-panel">` element's `data-stage-canvas` attribute, currently around line ~149)

- [ ] **Step 1: Find and edit the route-panel article**

Search for `data-stage-canvas="brief cuopt"`. Change it to `data-stage-canvas="cuopt"`.

The line currently reads (formatting may differ slightly):

```html
<article class="panel route-panel" data-stage-canvas="brief cuopt" aria-labelledby="route-title">
```

Change to:

```html
<article class="panel route-panel" data-stage-canvas="cuopt" aria-labelledby="route-title">
```

- [ ] **Step 2: Verify**

```bash
grep -c 'data-stage-canvas="brief cuopt"' /home/nvidia/gtc-taipei-demo/index.html
```
Expected: `0`.

```bash
grep -c 'data-stage-canvas="cuopt"' /home/nvidia/gtc-taipei-demo/index.html
```
Expected: at least `1`.

```bash
npm test 2>&1 | tail -3
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(ui): remove Taiwan map from Task Overview (stays on cuopt Solve)"
```

---

## Task 5: JS — `resetToSample()` (widen reset-button behavior)

**Files:**
- Modify: `app.js` (add new function near the existing `resetSampleImage` definition; change one wireEvents handler)

- [ ] **Step 1: Find `resetSampleImage` and add `resetToSample` next to it**

Search `app.js` for `function resetSampleImage`. Immediately AFTER its closing brace, insert this new function:

```js
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
```

- [ ] **Step 2: Rewire the reset button**

Find `wireEvents` in `app.js`. The current line wiring the reset button:

```js
els.promptResetSample.addEventListener("click", () => resetSampleImage());
```

Replace with:

```js
els.promptResetSample.addEventListener("click", () => resetToSample());
```

- [ ] **Step 3: Verify**

```bash
npm test 2>&1 | tail -3
```
Expected: PASS.

Hard-reload `http://localhost:4173`. Click `↺ reset to sample` in the terminal footer. Expected behavior:

- The textarea returns to the default prompt text from `data/default-prompt.txt`.
- The attached image returns to `sample-capacity.png`.
- The `@sample-capacity.png` line shows above the prompt.

(Note: this manual check is non-blocking for the commit; if the terminal rendering doesn't look right yet, it's because Task 6 hasn't landed. The function-level behavior is what matters here.)

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(ui): reset-to-sample now restores both prompt text and sample image"
```

---

## Task 6: JS — `data-has-input` toggle (blinking-caret driver)

**Files:**
- Modify: `app.js` (the existing `prompt-input` input event handler in `wireEvents`, plus one line in `boot()` after `loadDefaultPrompt`)

- [ ] **Step 1: Add the toggle in the input handler**

Find this block in `wireEvents` (currently around line ~280):

```js
els.promptInput.addEventListener("input", () => {
  try { sessionStorage.setItem(PROMPT_STORAGE_KEY, els.promptInput.value); } catch (_) {}
  clearPromptError();
});
```

Replace with:

```js
els.promptInput.addEventListener("input", () => {
  try { sessionStorage.setItem(PROMPT_STORAGE_KEY, els.promptInput.value); } catch (_) {}
  clearPromptError();
  if (els.promptZone) {
    els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
  }
});
```

- [ ] **Step 2: Set the attribute once at boot**

Find the `boot()` function in `app.js`. After the two lines that load the default prompt + restore the sessionStorage draft:

```js
await loadDefaultPrompt();
const stored = (typeof sessionStorage !== "undefined") && sessionStorage.getItem(PROMPT_STORAGE_KEY);
if (stored) els.promptInput.value = stored;
```

Add one more line immediately after them:

```js
if (els.promptZone) {
  els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
}
```

- [ ] **Step 3: Verify**

```bash
npm test 2>&1 | tail -3
```
Expected: PASS.

Hard-reload `http://localhost:4173`. Expected behavior:

- Page loads with the default prompt visible. The blinking caret block (`▌`) does NOT appear (textarea has content; `data-has-input="true"`).
- Empty the textarea. The blinking caret block APPEARS next to `❯`.
- Click into the textarea (focus it). Caret block disappears (focus-within rule).
- Click outside without typing. Caret block reappears.
- Type one character. Caret block disappears (`data-has-input="true"`).

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(ui): drive blinking caret via data-has-input attribute"
```

---

## Task 7: Final verification — npm test + manual smoke

**No files modified.** Verification only.

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/nvidia/gtc-taipei-demo
npm test
```
Expected: all static checks pass + all 26 unit tests pass + 0 failures.

- [ ] **Step 2: Restart server cleanly and hard-reload the page**

```bash
PID=$(ss -lntp 2>/dev/null | grep ':4173' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then kill $PID; sleep 1; fi
nohup npm start > /tmp/cuopt-server.log 2>&1 &
sleep 3
```

Then open `http://localhost:4173` in a browser (or hard-reload if already open). Walk through the smoke checklist:

- [ ] **Step 3: Smoke checklist**

| # | Action | Expected |
|---|---|---|
| 1 | Cold page load on Stage 1 | Terminal pane visible (no Taiwan map). Title bar reads `codex — ~/gtc-taipei-demo` with `gpt-5.5 xhigh · ready • ` on the right (green dot). Default prompt populated. `@sample-capacity.png` line visible above prompt. Blinking caret NOT visible (input has content). |
| 2 | Click harness toggle → Claude | Title flips to `claude`, status to `claude-opus-4-7[1m] · ready`, accent color flips orange (visible on the `❯` glyph and the `@` glyph). Prompt text unchanged. |
| 3 | Click harness toggle → Codex | Reverts to Codex theme. |
| 4 | Click into textarea, clear it | Caret block (`▌`) appears next to `❯`, blinking. |
| 5 | Focus textarea (click in it) | Caret block hides (focus-within rule). |
| 6 | Type any character | Caret block stays hidden (`data-has-input="true"`). |
| 7 | Empty textarea, unfocus | Caret block reappears, blinking. |
| 8 | Click `× ` next to `@sample-capacity.png` | Attached line disappears. |
| 9 | Click `↳ attach image`, pick a PNG | New `@<filename>` line appears with the uploaded name. |
| 10 | Click `↺ reset to sample` | Prompt returns to default text. `@sample-capacity.png` reappears with sample-state styling. |
| 11 | Click Run with the default prompt | Stage 1 collapses: edit view hidden, summary view shown with `❯ <truncated prompt>` styled to match the terminal. Auto-advances to Stage 2 (cuOpt Solve) — the Taiwan map now appears here. |
| 12 | Click "Re-run demo" after completion | Stage 1 returns. Terminal re-renders with the last-used prompt + attached image. |
| 13 | Test `prefers-reduced-motion` (DevTools → Rendering → Emulate CSS media → reduce) | Caret block stops blinking (still visible when applicable, just no animation). |

- [ ] **Step 4: If any smoke check fails, do not commit anything — diagnose and fix.**

If all pass, no further commits needed. The work is complete on the branch.

- [ ] **Step 5: Push the branch**

```bash
git push
```

---

## Self-review

(Author's pass — fix anything spotted inline.)

**Spec coverage check:**

- DOM structure (edit state, summary state) → Tasks 3 ✓
- Map removal from Stage 1 → Task 4 ✓
- Theme variables (`--term-cmd`, `--term-status`, `--term-bg`, etc.) → Task 1 Steps 1-2 ✓
- Codex vs Claude title-bar text differentiation → Task 1 Step 2 + Task 3 (CSS content + DOM hook) ✓
- Codex vs Claude model-status sub-line → Task 1 Step 2 ✓
- Terminal chrome (window dots, titlebar) → Task 1 Step 4 ✓
- Terminal body (prompt-row, textarea) → Task 1 Step 4 ✓
- Blinking caret + reduced-motion respect → Task 2 Step 1 ✓
- Terminal footer + actions + keyboard hints → Task 2 Step 2 ✓
- Submitted-state styling → Task 2 Step 3 ✓
- `@filename` line for attached image → Task 3 (markup) + Task 1 (styling) ✓
- One-button reset (prompt + image) → Task 5 ✓
- `data-has-input` toggle for blinking caret → Task 6 ✓
- sr-only h2 for accessibility → Task 1 Step 3 + Task 3 markup ✓

No spec requirement without a task.

**Placeholder scan:** no TBD/TODO/fill-in placeholders. All code blocks contain literal content.

**Type / signature consistency:**

- `resetToSample()` defined in Task 5 Step 1, referenced in Task 5 Step 2's wireEvents change. Consistent.
- `els.promptZone.dataset.hasInput` written in three places (Task 5 Step 1, Task 6 Step 1, Task 6 Step 2) — same attribute, same string values (`"true"` / `"false"`). Consistent with CSS selector in Task 2 Step 1 (`.terminal-body[data-has-input="true"]`).
- CSS class names used in Task 3 HTML (`terminal-panel`, `terminal-titlebar`, `terminal-traffic`, `dot-red/yellow/green`, `terminal-title-text/cmd/sep/cwd/status`, `terminal-body`, `terminal-attached/glyph/name/clear`, `terminal-prompt-row/glyph`, `terminal-input`, `terminal-footer`, `terminal-action`, `terminal-keys`, `terminal-error`, `terminal-submitted/-line/-meta`) all match the selectors defined in Tasks 1 + 2. Consistent.
- IDs preserved across the HTML rewrite — explicitly listed in Task 3 Step 1 and verified in Task 3 Step 3.

---

## Execution notes for the implementer

- Tasks are ordered to keep intermediate states visually-stable. CSS lands first (no visible change because selectors don't match anything yet), HTML lands second (terminal styling activates immediately because CSS is loaded), JS lands third (interactive behaviors complete the pane).
- This is a pure visual change. The smoke checklist in Task 7 is the canonical correctness gate — `npm test` static gates can't catch UI regressions.
- If you find yourself rewriting a hidden id (in HTML) or a function the existing app.js depends on, STOP — that's not in this plan.
