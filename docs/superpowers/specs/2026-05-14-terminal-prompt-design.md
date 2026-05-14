# Terminal-styled prompt panel on Task Overview — design

Status: approved, ready for implementation plan
Date: 2026-05-14
Author: edwli@nvidia.com (via Claude Code brainstorming)

## Goal

Restyle the Stage 1 ("Task Overview") prompt panel so it visually reads as the operator's actual Codex or Claude Code CLI — communicating "this is where you'd start outside the demo UI." The styling flips between Codex and Claude based on the existing harness toggle. The Taiwan map is removed from this stage to make the terminal the centerpiece (the map still appears on Stage 2 — cuOpt Solve).

Pure aesthetic change. No effect on the run-flow, NDJSON event contract, skill scripts, or any state machinery.

## Out of scope

- Pixel-faithful CLI replicas of Codex / Claude Code intro screens. We're going for a stylized terminal pane that's recognizable, not a screenshot.
- Real PTY behavior (cursor movement, command history, ANSI escapes). HTML/CSS only.
- Changes to Stages 2/3/4 — they keep their current panel styling.
- Changes to the run pipeline (orchestrator, normalizers, skill scripts).

## Design decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Faithfulness level | Stylized terminal pane (macOS-style window dots, monospace, prompt char) |
| Map on Task Overview | Remove from Stage 1; still shows on Stage 2 |
| Image attachment representation | `@filename` line above the prompt with `×` to detach |
| Codex/Claude differentiation | Same shell; accent color + title-bar text + model-status sub-line differ |
| Codex model status text | `gpt-5.5 xhigh · ready` |
| Claude model status text | `claude-opus-4-7[1m] · ready` |
| Sample reset behavior | One button (`↺ reset to sample`) restores BOTH prompt text AND sample image |

## DOM structure

### Edit state (before Run)

Replace the existing `<article class="panel prompt-panel">` body with the terminal markup. All existing element IDs that `app.js` references are preserved.

```html
<article class="panel terminal-panel" aria-labelledby="prompt-title">
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
    <!-- @filename reference line; rendered only when an image is attached -->
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
</article>
```

Note: the existing `<h2 id="prompt-title">Ask the agent</h2>` heading is removed from the visible DOM. We replace its `aria-labelledby` target with a visually-hidden but screen-reader-accessible heading inside the terminal pane, OR keep it but visually hide via a `.sr-only` class. The terminal title-bar serves the visual heading role.

### Summary state (after Run is clicked)

Existing `#prompt-summary` element gets the `terminal-submitted` class so it visually matches the terminal aesthetic. All IDs preserved.

```html
<div class="prompt-summary terminal-submitted" id="prompt-summary" hidden>
  <div class="terminal-submitted-line">
    <span class="terminal-prompt-glyph" aria-hidden="true">❯</span>
    <p class="prompt-summary-text" id="prompt-summary-text"></p>
  </div>
  <div class="terminal-submitted-meta">
    <span class="prompt-summary-attached" id="prompt-summary-attached"></span>
    <button class="ghost-action prompt-edit-button" type="button" id="prompt-edit-button">
      ↺ edit
    </button>
  </div>
</div>
```

The existing `setPromptView("editable" | "summary")` function in app.js continues to work — it just shows/hides `#prompt-summary` and `#prompt-zone` as before. The summary's terminal styling is purely CSS-driven via the static `.terminal-submitted` class.

### Map removal

In `index.html`, the route-panel article currently has `data-stage-canvas="brief cuopt"`. Change to `data-stage-canvas="cuopt"`. One-attribute edit. The existing visibility rules in styles.css (`[data-stage-canvas]` selector cascade driven by `main.cockpit[data-active-stage]`) handle the rest. The map article stays in the DOM and continues to render on Stage 2.

## CSS — theme variables

Extend the existing `--accent` swap pattern. Add a small set of terminal-specific tokens to `:root` and `body[data-harness="claude"]`. The `--term-cmd` and `--term-status` tokens use CSS `content` strings, surfaced via `::before` pseudo-elements on the relevant title-bar spans, so the harness toggle's `data-harness` attribute drives everything without JS.

```css
:root {
  --term-bg:       #0c0e0c;
  --term-border:   rgba(255, 255, 255, 0.10);
  --term-chrome:   rgba(255, 255, 255, 0.04);
  --term-ink:      #e8efe1;
  --term-ink-dim:  rgba(232, 239, 225, 0.55);
  --term-glyph:    var(--accent);
  --term-caret:    var(--accent);
  --term-mono:     "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* Codex default */
  --term-cmd:    "codex";
  --term-status: "gpt-5.5 xhigh · ready";
}

body[data-harness="claude"] {
  --term-cmd:    "claude";
  --term-status: "claude-opus-4-7[1m] · ready";
}
```

## CSS — terminal chrome + body

```css
.terminal-panel {
  padding: 0;
  background: var(--term-bg);
  border: 1px solid var(--term-border);
  overflow: hidden;
}

.terminal-titlebar {
  display: flex; align-items: center; gap: 12px;
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

.terminal-title-cmd::before    { content: var(--term-cmd); }
.terminal-title-cmd            { color: var(--term-ink); font-weight: 600; }
.terminal-title-sep            { opacity: 0.4; }
.terminal-title-status         { margin-left: auto; font-size: 0.72rem; }
.terminal-title-status::before { content: var(--term-status); }
.terminal-title-status::after  { content: "•"; margin-left: 8px; color: #27c93f; }

.terminal-body { padding: 16px 18px; font-family: var(--term-mono); }

.terminal-attached {
  display: inline-flex; align-items: center; gap: 6px;
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
  border: 0; background: transparent;
  color: var(--term-ink-dim);
  font-size: 1rem; line-height: 1; cursor: pointer;
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
  width: 100%; min-height: 4.2em;
  resize: vertical;
  border: 0; background: transparent;
  color: var(--term-ink);
  font-family: var(--term-mono);
  font-size: 0.95rem; line-height: 1.55;
  outline: 0;
  caret-color: var(--term-caret);
  padding: 0;
}
.terminal-input::placeholder { color: var(--term-ink-dim); font-style: italic; }

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
.terminal-body[data-has-input="true"] .terminal-prompt-glyph::after { display: none; }
@keyframes term-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .terminal-body .terminal-prompt-glyph::after { animation: none; }
}

.terminal-footer {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 14px;
  margin-top: 18px;
  padding-top: 10px;
  border-top: 1px solid var(--term-border);
  font-size: 0.78rem;
  color: var(--term-ink-dim);
}
.terminal-action {
  display: inline-flex; align-items: center; gap: 5px;
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

.terminal-submitted {
  background: var(--term-bg);
  padding: 14px 18px;
  font-family: var(--term-mono);
  color: var(--term-ink);
}
.terminal-submitted-line {
  display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start;
}
.terminal-submitted-meta {
  display: flex; gap: 12px; align-items: center;
  margin-top: 8px;
  font-size: 0.78rem; color: var(--term-ink-dim);
}
```

## JS — small touches in `app.js`

Three narrow edits — nothing else.

### 1. Reset-to-sample widens to include the prompt

The existing `prompt-reset-sample` button currently calls `resetSampleImage()`. Replace its click handler to call a new `resetToSample()` that resets BOTH:

```js
async function resetToSample() {
  resetSampleImage();   // existing function, unchanged
  els.promptInput.value = "";
  try { sessionStorage.removeItem(PROMPT_STORAGE_KEY); } catch (_) {}
  await loadDefaultPrompt();    // existing function; refills empty textarea from /data/default-prompt.txt
  els.promptZone.dataset.hasInput = "false";
  clearPromptError();
}
```

Wire change in `wireEvents()`:

```js
// before:
els.promptResetSample.addEventListener("click", () => resetSampleImage());
// after:
els.promptResetSample.addEventListener("click", () => resetToSample());
```

### 2. `data-has-input` toggle for the blinking caret

In the existing `prompt-input` input event handler (which already persists to sessionStorage and clears prompt errors), add one line to update the prompt-zone's `data-has-input` attribute:

```js
els.promptInput.addEventListener("input", () => {
  try { sessionStorage.setItem(PROMPT_STORAGE_KEY, els.promptInput.value); } catch (_) {}
  clearPromptError();
  els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
});
```

Also set the attribute once at boot (after `loadDefaultPrompt` populates the textarea):

```js
// in boot() after the existing loadDefaultPrompt + sessionStorage restore
els.promptZone.dataset.hasInput = els.promptInput.value.trim() ? "true" : "false";
```

### 3. Visually-hidden heading for accessibility

Add a `.sr-only` utility class once in styles.css:

```css
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
```

And in the terminal-panel markup, keep an accessible h2 heading:

```html
<article class="panel terminal-panel" aria-labelledby="prompt-title">
  <h2 id="prompt-title" class="sr-only">Ask the agent</h2>
  <header class="terminal-titlebar">...</header>
  ...
</article>
```

The visible terminal title bar shows `codex — ~/gtc-taipei-demo` / `claude — ~/gtc-taipei-demo`; the sr-only h2 is for screen readers and for the `aria-labelledby` reference. The existing `<h2 id="prompt-title">Ask the agent</h2>` is moved (not removed) into this sr-only span.

## What changes / what stays the same

| File | Change |
|---|---|
| `index.html` | Replace `<article class="panel prompt-panel">` body with terminal markup. Add `.sr-only` h2. Update `<div class="prompt-summary">` to include `terminal-submitted` class + restructured children. Change route-panel's `data-stage-canvas` from `"brief cuopt"` to `"cuopt"`. |
| `styles.css` | Add `:root` terminal theme tokens + `body[data-harness="claude"]` overrides. Add ~150 lines of `.terminal-*` rules. Add `.sr-only` utility. Add `prefers-reduced-motion` clause for the caret animation. |
| `app.js` | (1) Replace the `prompt-reset-sample` click handler with `resetToSample()`. (2) Add `data-has-input` toggle in the `prompt-input` input handler and once at boot. No other touchpoints. |
| All other files | Unchanged. Server, orchestrator, normalizers, skills, data, tests, docs. |

## Failure modes / edge cases

| Trigger | Behavior |
|---|---|
| Page load, sessionStorage empty | `loadDefaultPrompt()` populates textarea with sample. `data-has-input="true"`. Caret block hidden. Terminal renders with sample prompt visible. |
| Page load, sessionStorage has saved text | `loadDefaultPrompt` skips (existing guard `!value.trim()`). Restored text appears. `data-has-input="true"`. |
| User clears textarea manually | `data-has-input="false"`. Blinking caret returns next to `❯`. |
| User clicks Reset to sample | `resetToSample()` runs: image → sample, textarea cleared, sessionStorage removed, default prompt re-loaded. `data-has-input="true"` if default prompt non-empty. |
| User clicks Run | Existing flow: `setPromptView("summary")` hides `#prompt-zone`, shows `#prompt-summary` (now with `terminal-submitted` class). |
| User clicks Edit (during summary view) | Existing flow: `setPromptView("editable")` reverses. |
| User toggles harness mid-typing | `body[data-harness]` flips. `--term-cmd`, `--term-status`, `--accent` all swap via CSS. No JS, no content loss. |
| User uploads image | Existing `attachImage()` writes `#prompt-attached` → terminal-attached line shows `@<uploaded-filename>` with accent-coloured styling. |
| User detaches image | `#prompt-attached` set `hidden=true`. The terminal-attached line disappears. Footer still has `↳ attach image` action. |
| `prefers-reduced-motion: reduce` | Blinking caret stops animating; static block. |
| Narrow viewport (<720px) | Terminal footer flex-wraps cleanly. Title bar's cwd path can ellipsis if too long. |

## Testing

Pure visual change. No unit tests warranted. Existing `npm test` (static + data-shape + system-prime gates) continues to apply unchanged.

Manual smoke checklist after implementation:

1. Load `http://localhost:4173` cold. Stage 1 shows the terminal pane only (no map). Title reads `codex — ~/gtc-taipei-demo`, status reads `gpt-5.5 xhigh · ready`. Default prompt populates the textarea. `@sample-capacity.png` line appears above prompt.
2. Flip toggle to Claude. Title flips to `claude`, status flips to `claude-opus-4-7[1m] · ready`, accent color flips orange. Prompt text + image attachment unchanged.
3. Click `↳ attach image`, pick a different PNG. `@<filename>` line updates.
4. Click `↺ reset to sample`. Image returns to `sample-capacity.png`, textarea returns to the default prompt text, sessionStorage cleared.
5. Empty the textarea. Blinking caret block appears next to `❯`.
6. Focus the textarea. Blinking caret hides (focus-within rule).
7. Click Run. Stage 1 collapses to read-only `❯ <brief>` summary line styled to match. Cockpit auto-advances to Stage 2; Stage 2's map appears.
8. After completion, click "Re-run demo". Stage 1 returns. Terminal re-renders with whatever the user last had in the textarea. Click reset-to-sample to restore defaults if needed.
9. Confirm `npm test` still green.

## Implementation sequence (for the writing-plans skill)

1. Add `:root` terminal theme tokens + `body[data-harness="claude"]` overrides + `.sr-only` utility in styles.css.
2. Add the terminal CSS rules (chrome, body, attached, prompt-row, footer, submitted, reduced-motion).
3. Replace the prompt-panel HTML in index.html with the terminal markup; restructure prompt-summary; flip route-panel's `data-stage-canvas`.
4. Move the visible `<h2 id="prompt-title">` into a `.sr-only` span.
5. Add `resetToSample()` in app.js; wire it to `prompt-reset-sample`.
6. Add `data-has-input` toggle in the existing `prompt-input` input handler + once at boot.
7. `npm test` to confirm static gates still pass.
8. Hard-reload `http://localhost:4173` and walk the manual smoke checklist.

## What success looks like

- The Stage 1 panel reads unambiguously as a terminal — window dots, monospace text, prompt glyph, blinking caret, keyboard hint footer.
- Flipping the harness toggle visibly changes "codex"/"claude" in the title bar, the model status sub-line, and the accent color of the prompt glyph + caret + accent strokes.
- The terminal is the only visual element on Stage 1 — the Taiwan map is gone from this page but reappears as soon as the user advances to Stage 2.
- A first-time viewer who has ever used Codex or Claude Code feels recognition: "oh, this is the thing I'd start in my terminal." That's the core message.
- One click of `↺ reset to sample` returns the terminal to a pristine demo state for the next run.
