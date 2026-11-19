import Anthropic from "@anthropic-ai/sdk";

/** Thin wrapper so the rest of the code never touches the SDK directly. */
export function claude({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  return {
    model,
    call: (params) => client.messages.create({ model, max_tokens: 8000, ...params }),
  };
}

const toolSpec = ({ name, description, input_schema }) => ({ name, description, input_schema });
const textOf = (msg) => msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/**
 * Asks the model to fill in exactly one tool's input. Used where we need
 * structured output (triage), not an open-ended loop.
 */
export async function structured(llm, { system, prompt, tool }) {
  const msg = await llm.call({
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [toolSpec(tool)],
    tool_choice: { type: "tool", name: tool.name },
  });
  const use = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!use) throw new Error(`model did not return ${tool.name}`);
  return use.input;
}

/**
 * The agent loop: the model calls tools until it stops asking for them or
 * runs out of turns. Tool errors go back to the model as results so it can
 * recover, instead of crashing the job.
 */
export async function loop(llm, { system, prompt, tools, maxTurns = 25, onStep = () => {} }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const msg = await llm.call({ system, messages, tools: tools.map(toolSpec) });
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || uses.length === 0) {
      return { text: textOf(msg), turns: turn, messages, finished: true };
    }
    const results = [];
    for (const use of uses) {
      const tool = byName.get(use.name);
      let content, is_error = false;
      try {
        if (!tool) throw new Error(`unknown tool ${use.name}`);
        const out = await tool.run(use.input || {});
        content = typeof out === "string" ? out : JSON.stringify(out ?? "ok");
      } catch (e) {
        content = `Error: ${e.message}`;
        is_error = true;
      }
      onStep({ tool: use.name, input: use.input, error: is_error ? content : null });
      results.push({ type: "tool_result", tool_use_id: use.id, content: content.slice(0, 20000), is_error });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "", turns: maxTurns, messages, finished: false };
}

/**
 * A scripted stand-in for Claude, for tests and the offline demo. Each
 * entry is either a message object or a function of the request.
 */
export function scripted(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    model: "scripted",
    calls,
    async call(params) {
      calls.push(params);
      if (!queue.length) throw new Error("scripted model ran out of responses");
      const next = queue.shift();
      return typeof next === "function" ? next(params) : next;
    },
  };
}

/** Helpers for writing scripted responses. */
let n = 0;
export const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
export const use = (name, input, text) => ({
  stop_reason: "tool_use",
  content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `tu_${++n}`, name, input }],
});
