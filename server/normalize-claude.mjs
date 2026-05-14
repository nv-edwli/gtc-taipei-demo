const STAGE_HINTS = {
  cuopt: ["taiwan_supply_chain", "cuopt.result", "/cuopt/request", "/cuopt/solution"],
  vision: ["vision_analyze.py", "Vision Insights", "Nemotron Omni"],
  aiq: ["aiq.py", "AIQ Research", "deep_research_running", "research_poll"]
};

function inferStage(text) {
  if (!text) return "general";
  const lower = String(text).toLowerCase();
  for (const [stage, hints] of Object.entries(STAGE_HINTS)) {
    for (const hint of hints) {
      if (lower.includes(hint.toLowerCase())) return stage;
    }
  }
  return "general";
}

function inferStageFromToolInput(name, input) {
  if (!input) return "general";
  const probe = JSON.stringify(input);
  return inferStage(probe + " " + (name || ""));
}

function extractToolResultContent(block) {
  if (!block) return { stdout: "", stderr: "", isError: false };
  if (typeof block.content === "string") {
    return { stdout: block.content, stderr: "", isError: !!block.is_error };
  }
  if (Array.isArray(block.content)) {
    const stdout = block.content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { stdout, stderr: "", isError: !!block.is_error };
  }
  return { stdout: "", stderr: "", isError: !!block.is_error };
}

export function createClaudeNormalizer() {
  const toolMeta = new Map(); // tool_use id → { name, stage, invokedAt }

  return function normalize(evt) {
    if (!evt || typeof evt !== "object") return [];

    if (evt.type === "system" && evt.subtype === "init") {
      return [{
        kind: "run.started",
        data: {
          sessionId: evt.session_id || null,
          model: evt.model || null,
          harness: "claude",
          tools: Array.isArray(evt.tools) ? evt.tools : []
        }
      }];
    }

    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      const beats = [];
      for (const block of evt.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) {
          beats.push({
            kind: "assistant.text",
            data: { stage: inferStage(block.text), text: block.text }
          });
        } else if (block.type === "tool_use") {
          const stage = inferStageFromToolInput(block.name, block.input);
          const id = block.id || `tu_${Math.random().toString(36).slice(2, 10)}`;
          toolMeta.set(id, { name: block.name, stage, invokedAt: Date.now() });
          beats.push({
            kind: "tool.invoked",
            data: {
              id,
              name: block.name || "tool",
              input: block.input || {},
              stage
            }
          });
        }
      }
      return beats;
    }

    if (evt.type === "user" && evt.message && Array.isArray(evt.message.content)) {
      const beats = [];
      for (const block of evt.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type !== "tool_result") continue;
        const id = block.tool_use_id || null;
        const meta = id ? toolMeta.get(id) : null;
        const { stdout, stderr, isError } = extractToolResultContent(block);
        const durationMs = meta ? Date.now() - meta.invokedAt : null;
        beats.push({
          kind: "tool.completed",
          data: {
            id,
            name: meta ? meta.name : "tool",
            stage: meta ? meta.stage : "general",
            stdout,
            stderr,
            isError,
            durationMs
          }
        });
        if (id) toolMeta.delete(id);
      }
      return beats;
    }

    if (evt.type === "result") {
      return [{
        kind: "run.completed",
        data: {
          subtype: evt.subtype || "success",
          result: evt.result || "",
          durationMs: evt.duration_ms || null,
          costUsd: evt.total_cost_usd || null,
          numTurns: evt.num_turns || null,
          stopReason: evt.stop_reason || null
        }
      }];
    }

    return [];
  };
}
