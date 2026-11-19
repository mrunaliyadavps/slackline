import { triage } from "./triage.mjs";
import { codeWorker, writeWorker, actionWorker } from "./workers.mjs";

const SLACK_LIMIT = 2800;
const clip = (s, n = SLACK_LIMIT) => (s.length > n ? s.slice(0, n) + "\n…(full text is on the ticket)" : s);
const link = (url, text) => `<${url}|${text}>`;

/**
 * One request, start to finish:
 * Slack message → triage → Linear ticket → worker → ticket updated → reply in thread.
 * Every dependency is passed in, so the same code runs against real
 * services, the offline demo and the tests.
 */
export async function handle(request, deps) {
  const { llm, linear, github, reply, cfg, actions = [], instructions = "", log = () => {} } = deps;
  const { text, user, channel } = request;

  if (cfg.allowedUsers?.length && !cfg.allowedUsers.includes(user)) {
    await reply("Sorry, I only take requests from people on my allowlist.");
    return { status: "refused" };
  }
  if (cfg.allowedChannels?.length && !cfg.allowedChannels.includes(channel)) {
    await reply("I don't take requests in this channel.");
    return { status: "refused" };
  }
  if (!text.trim()) {
    await reply("What would you like me to do?");
    return { status: "asked" };
  }

  const plan = await triage(llm, {
    text, user, channel,
    repos: cfg.repos || [],
    actions: actions.map((a) => a.name),
    instructions,
  });
  if (plan.question) {
    await reply(plan.question);
    return { status: "asked", question: plan.question };
  }

  const issue = await linear.createIssue({
    title: plan.title,
    description: `${plan.description}\n\n---\nRequested by Slack user ${user} via slackline.`,
  });
  const ticket = { ...issue, title: plan.title, description: plan.description };
  log(`filed ${ticket.key} (${plan.kind})`);
  await reply(`Filed ${link(ticket.url, ticket.key)}: ${plan.title}. Working on it now.`);
  await linear.moveTo(ticket.id, "start");

  const onStep = (s) => log(`${ticket.key} ${s.tool}${s.error ? " ✗" : ""}`);
  let result;
  try {
    if (plan.kind === "code") result = await codeWorker({ llm, github, ticket, plan, cfg, onStep });
    else if (plan.kind === "action") result = await actionWorker({ llm, ticket, actions, cfg, onStep });
    else result = await writeWorker({ llm, ticket, onStep });
  } catch (e) {
    log(`${ticket.key} failed: ${e.message}`);
    await linear.comment(ticket.id, `slackline hit an error and stopped:\n\n\`${e.message}\``);
    await reply(`I couldn't finish ${link(ticket.url, ticket.key)}: ${e.message}. I've left the ticket for a person.`);
    return { status: "failed", ticket, plan, error: e.message };
  }

  if (!result.ok) {
    await linear.comment(ticket.id, `slackline stopped without finishing:\n\n${result.summary}`);
    await reply(`I couldn't finish ${link(ticket.url, ticket.key)}. ${result.summary}`);
    return { status: "unfinished", ticket, plan, result };
  }

  if (plan.kind === "code") {
    const where = result.link ? `Pull request: ${result.link}` : result.note || "";
    await linear.comment(ticket.id, `${result.summary}\n\n${where}`);
    await linear.moveTo(ticket.id, "review");
    await reply(`Done with ${link(ticket.url, ticket.key)}. ${result.link ? `Pull request for review: ${result.link}` : where}\n\n${clip(result.summary, 1200)}`);
  } else {
    await linear.comment(ticket.id, result.attach || result.summary);
    await linear.moveTo(ticket.id, "done");
    await reply(`Done with ${link(ticket.url, ticket.key)}.\n\n${clip(result.attach || result.summary)}`);
  }
  return { status: "done", ticket, plan, result };
}

/** Runs jobs one at a time so two requests never fight over the same repo. */
export function queue() {
  let tail = Promise.resolve();
  return (job) => {
    const next = tail.then(job, job);
    tail = next.catch(() => {});
    return next;
  };
}
