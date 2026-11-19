import { loop } from "./llm.mjs";
import { fileTools, git } from "./workspace.mjs";

const brief = (ticket) => `Ticket ${ticket.key}: ${ticket.title}\n\n${ticket.description}`;

/**
 * code: clone the repo, let the model edit files with sandboxed tools,
 * commit, and open a pull request. Returns { ok, summary, link }.
 */
export async function codeWorker({ llm, github, ticket, plan, cfg, onStep }) {
  const branch = `${cfg.repoBranchPrefix || "slackline/"}${ticket.key.toLowerCase()}`;
  const dir = await github.checkout(plan.repo, branch);
  try {
    const result = await loop(llm, {
      system:
        "You are a careful engineer working in a fresh clone of the repository. " +
        "Explore before editing, make the smallest change that completes the ticket, follow the existing style, " +
        (cfg.testCommand ? "and run the tests before you finish. " : "") +
        "Do not touch files the ticket does not need. When you are done, reply with a two or three line summary of what changed and anything a reviewer should check.",
      prompt: brief(ticket),
      tools: fileTools(dir, { testCommand: cfg.testCommand }),
      maxTurns: cfg.maxTurns,
      onStep,
    });
    const changed = await git(dir, "status", "--porcelain");
    if (!changed) return { ok: false, summary: result.text || "I looked but didn't find anything to change." };
    if (!result.finished) return { ok: false, summary: `I ran out of steps (${cfg.maxTurns}) before finishing, so I didn't open a pull request.` };
    const id = ["-c", "user.name=slackline", "-c", "user.email=slackline@users.noreply.github.com"];
    await git(dir, "add", "-A");
    await git(dir, ...id, "commit", "-qm", `${ticket.title}\n\n${ticket.key}`);
    if (cfg.dryRun) return { ok: true, summary: result.text, link: null, note: "dry run: committed locally, not pushed" };
    const link = await github.openPullRequest({
      repo: plan.repo, dir, branch,
      title: `${ticket.title} (${ticket.key})`,
      body: `${result.text}\n\nLinear: ${ticket.url}\n\nOpened by slackline. Please review before merging.`,
    });
    return { ok: true, summary: result.text, link };
  } finally {
    await github.cleanup(dir);
  }
}

/** write: produce the text the ticket asks for and hand it back. */
export async function writeWorker({ llm, ticket, onStep }) {
  const result = await loop(llm, {
    system:
      "You write the text a ticket asks for: copy, documentation, a spec, a reply. " +
      "Return only the finished text, ready to paste, in Markdown. If something is unknowable, leave a clear [placeholder] rather than inventing facts.",
    prompt: brief(ticket),
    tools: [],
    maxTurns: 1,
    onStep,
  });
  return { ok: Boolean(result.text), summary: result.text, attach: result.text };
}

/** action: let the model use the tools the team defined in slackline.config.mjs. */
export async function actionWorker({ llm, ticket, actions, cfg, onStep }) {
  const tools = actions.map((a) => ({
    ...a,
    run: cfg.dryRun ? async (input) => `dry run: would call ${a.name} with ${JSON.stringify(input)}` : a.run,
  }));
  const result = await loop(llm, {
    system:
      "Complete the ticket using the tools provided. Use the fewest calls that do the job. " +
      "If the tools can't do it, say so plainly instead of guessing. Finish with a short summary of what you did.",
    prompt: brief(ticket),
    tools,
    maxTurns: cfg.maxTurns,
    onStep,
  });
  return { ok: result.finished, summary: result.text || "I couldn't finish this one." };
}
