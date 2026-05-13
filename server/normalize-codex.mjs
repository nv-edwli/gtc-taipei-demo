const STAGE_HINTS = {
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

function extractToolMeta(item) {
  // Codex item shapes vary: function_call has tool_name/tool_input;
  // command_execution has command + aggregated_output + exit_code.
  if (item.type === "command_execution") {
    const command = item.command || "";
    const input = { command };
    const stage = inferStage(command);
    const stdout = item.aggregated_output || "";
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
    const isError = exitCode != null && exitCode !== 0;
    return { name: "Bash", input, stage, stdout, stderr: "", isError };
  }
  const name = item.tool_name || item.name || "tool";
  const input = item.tool_input || item.arguments || item.input || {};
  const stage = inferStage(JSON.stringify(input) + " " + name);
  const result = item.result;
  let stdout = "", stderr = "", isError = false;
  if (result != null) {
    if (typeof result === "string") {
      stdout = result;
    } else if (typeof result === "object") {
      stdout = result.stdout || result.text || result.output || JSON.stringify(result).slice(0, 1024);
      stderr = result.stderr || "";
      isError = !!(result.error || result.is_error);
    } else {
      stdout = String(result);
    }
  }
  return { name, input, stage, stdout, stderr, isError };
}

export function createCodexNormalizer() {
  const inFlight = new Set(); // ids that emitted tool.invoked via item.started

  return function normalize(evt) {
    if (!evt || typeof evt !== "object") return [];

    if (evt.type === "thread.started") {
      return [{
        kind: "run.started",
        data: {
          sessionId: evt.thread_id || null,
          model: evt.model || null,
          harness: "codex",
          tools: []
        }
      }];
    }

    if (evt.type === "turn.started") return [];

    if (evt.type === "item.started" && evt.item) {
      const item = evt.item;
      const itemType = item.type;
      if (itemType === "tool_use" || itemType === "function_call" || itemType === "command_execution") {
        const { name, input, stage } = extractToolMeta(item);
        const id = item.id || `tu_${Math.random().toString(36).slice(2, 10)}`;
        inFlight.add(id);
        return [{ kind: "tool.invoked", data: { id, name, input, stage } }];
      }
      return [];
    }

    if (evt.type === "item.completed" && evt.item) {
      const item = evt.item;
      const itemType = item.type;

      if (itemType === "agent_message" || itemType === "assistant_message" || itemType === "message") {
        const text = item.text || item.message || "";
        if (!text) return [];
        return [{ kind: "assistant.text", data: { stage: inferStage(text), text } }];
      }

      if (itemType === "tool_use" || itemType === "function_call" || itemType === "command_execution") {
        const { name, input, stage, stdout, stderr, isError } = extractToolMeta(item);
        const id = item.id || `tu_${Math.random().toString(36).slice(2, 10)}`;
        const wasInFlight = inFlight.delete(id);
        const beats = [];
        if (!wasInFlight) {
          // Some Codex builds skip item.started; emit invoked synthetically so the UI
          // can render the tool entry with running → done.
          beats.push({ kind: "tool.invoked", data: { id, name, input, stage } });
        }
        beats.push({ kind: "tool.completed", data: { id, name, stage, stdout, stderr, isError, durationMs: null } });
        return beats;
      }

      if (itemType === "reasoning" || itemType === "thinking") {
        return [{ kind: "log", data: { level: "debug", text: item.text || item.summary || "(reasoning)" } }];
      }

      return [{ kind: "log", data: { level: "info", text: `item: ${itemType}` } }];
    }

    if (evt.type === "turn.completed") {
      return [{ kind: "log", data: { level: "info", text: "turn complete", usage: evt.usage || null } }];
    }

    return [];
  };
}
