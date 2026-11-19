#!/usr/bin/env node
import { readEnv, missing, loadUserConfig, DEFAULTS } from "../src/config.mjs";
import { handle, queue } from "../src/agent.mjs";
import { claude } from "../src/llm.mjs";
import { linear } from "../src/adapters/linear.mjs";
import { github } from "../src/adapters/github.mjs";
import { demo } from "../src/demo.mjs";

const [cmd = "help", ...rest] = process.argv.slice(2);
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

const HELP = `slackline: a Slack agent that files Linear tickets and does the work.

  slackline demo            See it work offline. No keys needed.
  slackline doctor          Check your keys and connections.
  slackline run "request"   Handle one request from the terminal (real Claude, Linear, GitHub).
  slackline start           Connect to Slack and take requests.

Setup: https://github.com/mrunaliyadavps/slackline#set-it-up`;

async function deps(cfgEnv) {
  const user = await loadUserConfig();
  return {
    cfg: { ...DEFAULTS, ...cfgEnv },
    llm: claude({ apiKey: cfgEnv.anthropicApiKey, model: cfgEnv.model }),
    linear: linear({ apiKey: cfgEnv.linearApiKey, teamId: cfgEnv.linearTeamId }),
    github: github({ token: cfgEnv.githubToken }),
    actions: user.actions,
    instructions: user.instructions,
    log,
  };
}

function need(cfg, command) {
  const gaps = missing(cfg, command);
  if (gaps.length) {
    console.error(`Missing: ${gaps.join(", ")}. Copy .env.example to .env and fill it in, then run with: node --env-file=.env …`);
    process.exit(2);
  }
  if (cfg.repos.length && !cfg.githubToken) {
    console.error("SLACKLINE_REPOS is set but GITHUB_TOKEN is not, so code work can't open pull requests.");
    process.exit(2);
  }
}

async function doctor(cfg) {
  const check = async (name, ok, fn) => {
    if (!ok) return console.log(`  –  ${name}: not configured`);
    try { console.log(`  ✓  ${name}: ${await fn()}`); } catch (e) { console.log(`  ✗  ${name}: ${e.message}`); process.exitCode = 1; }
  };
  console.log("slackline doctor");
  await check("Claude", cfg.anthropicApiKey, async () => {
    const r = await claude({ apiKey: cfg.anthropicApiKey, model: cfg.model }).call({ max_tokens: 5, messages: [{ role: "user", content: "Say ok" }] });
    return `${cfg.model} answered (${r.usage?.output_tokens ?? "?"} tokens)`;
  });
  if (cfg.linearApiKey && !cfg.linearTeamId) {
    await check("Linear teams", true, async () => {
      const { LinearClient } = await import("@linear/sdk");
      const teams = (await new LinearClient({ apiKey: cfg.linearApiKey }).teams()).nodes;
      return "set LINEAR_TEAM_ID to one of these:\n" + teams.map((t) => `       ${t.id}  ${t.key}  ${t.name}`).join("\n");
    });
  }
  await check("Linear", cfg.linearApiKey && cfg.linearTeamId, async () => {
    const { LinearClient } = await import("@linear/sdk");
    const team = await new LinearClient({ apiKey: cfg.linearApiKey }).team(cfg.linearTeamId);
    return `team ${team.key} (${team.name})`;
  });
  await check("Slack", cfg.slackBotToken, async () => {
    const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${cfg.slackBotToken}` } }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error);
    return `bot ${r.user} in ${r.team}`;
  });
  await check("Slack Socket Mode", cfg.slackAppToken, async () => (cfg.slackAppToken.startsWith("xapp-") ? "app-level token present" : Promise.reject(new Error("should start with xapp-"))));
  for (const repo of cfg.repos) {
    await check(`GitHub ${repo}`, cfg.githubToken, async () => {
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { authorization: `Bearer ${cfg.githubToken}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.permissions?.push) throw new Error("token can read but not push");
      return "can push";
    });
  }
  const user = await loadUserConfig();
  console.log(`  ·  actions from slackline.config.mjs: ${user.actions.map((a) => a.name).join(", ") || "none"}`);
  console.log(`  ·  dry run: ${cfg.dryRun ? "on" : "off"}`);
}

const cfg = readEnv();
if (cmd === "demo") {
  await demo();
} else if (cmd === "doctor") {
  await doctor(cfg);
} else if (cmd === "run") {
  need(cfg, "run");
  const text = rest.join(" ");
  if (!text) { console.error('Usage: slackline run "what you want done"'); process.exit(2); }
  const d = await deps(cfg);
  const out = await handle({ text, user: "terminal", channel: "terminal" }, { ...d, reply: async (t) => console.log(`\n${t}\n`) });
  process.exitCode = out.status === "done" || out.status === "asked" ? 0 : 1;
} else if (cmd === "start") {
  need(cfg, "start");
  const { startSlack } = await import("../src/adapters/slack.mjs");
  const d = await deps(cfg);
  const enqueue = queue();
  await startSlack({
    botToken: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    log,
    onRequest: (req, reply) => enqueue(() => handle(req, { ...d, reply })),
  });
  log(`slackline is listening${cfg.dryRun ? " (dry run)" : ""}. Mention it in Slack or send it a DM.`);
} else {
  console.log(HELP);
}
