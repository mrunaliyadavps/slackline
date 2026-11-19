import { structured } from "./llm.mjs";

export const KINDS = ["code", "write", "action"];

const tool = (repos, actions) => ({
  name: "file_ticket",
  description: "File the Slack request as a Linear ticket, or ask one question if it is too vague to act on.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Only if the request cannot be done without more information: the single question to ask. Otherwise empty.",
      },
      title: { type: "string", description: "Short imperative ticket title, under 70 characters." },
      description: {
        type: "string",
        description: "Markdown. What was asked, why if known, and a short 'Done when' checklist.",
      },
      kind: {
        type: "string",
        enum: KINDS,
        description:
          "code: change files in a repository and open a pull request. " +
          "write: produce text (copy, docs, a spec, a reply). " +
          "action: use one of the configured tools" + (actions.length ? ` (${actions.join(", ")})` : " (none configured)") + ".",
      },
      repo: {
        type: "string",
        description: repos.length ? `For code work, one of: ${repos.join(", ")}.` : "No repositories are configured; leave empty.",
      },
    },
    required: ["question", "title", "description", "kind", "repo"],
  },
});

/**
 * Turns a Slack message into a ticket plan. Pure apart from the model call,
 * and it validates what the model returns instead of trusting it.
 */
export async function triage(llm, { text, user, channel, repos = [], actions = [], instructions = "" }) {
  const system =
    "You turn requests sent to a team's Slack agent into well-formed Linear tickets. " +
    "Keep the requester's intent; do not add scope. Pick the kind of work that actually satisfies the request." +
    (instructions ? `\n\nTeam instructions:\n${instructions}` : "");
  const out = await structured(llm, {
    system,
    prompt: `Request from <@${user}> in <#${channel}>:\n\n${text}`,
    tool: tool(repos, actions),
  });
  if (out.question && out.question.trim()) return { question: out.question.trim() };
  const plan = {
    title: String(out.title || "").trim().slice(0, 120),
    description: String(out.description || "").trim(),
    kind: KINDS.includes(out.kind) ? out.kind : "write",
    repo: String(out.repo || "").trim(),
  };
  if (!plan.title) throw new Error("triage returned no title");
  if (plan.kind === "code" && !repos.includes(plan.repo)) {
    // A code ticket for a repo we are not allowed to touch becomes a question.
    return {
      question: repos.length
        ? `Which repo should I change? I can work in: ${repos.join(", ")}.`
        : "I'm not set up to change code in any repository yet, so I can't do this one.",
    };
  }
  if (plan.kind === "action" && actions.length === 0) plan.kind = "write";
  return plan;
}
