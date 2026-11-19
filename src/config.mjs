import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Settings come from environment variables. Anything that is code (custom
 * action tools, extra rules) comes from an optional slackline.config.mjs.
 */
export const DEFAULTS = {
  model: "claude-sonnet-5-5",
  maxTurns: 25,
  repoBranchPrefix: "slackline/",
  states: { start: "started", review: "started", done: "completed" },
};

const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export function readEnv(env = process.env) {
  return {
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    linearApiKey: env.LINEAR_API_KEY,
    linearTeamId: env.LINEAR_TEAM_ID,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    githubToken: env.GITHUB_TOKEN,
    model: env.SLACKLINE_MODEL || DEFAULTS.model,
    maxTurns: Number(env.SLACKLINE_MAX_TURNS || DEFAULTS.maxTurns),
    // Who may give the agent work. Empty means anyone in the workspace.
    allowedUsers: list(env.SLACKLINE_ALLOWED_USERS),
    allowedChannels: list(env.SLACKLINE_ALLOWED_CHANNELS),
    // Repos the code worker may touch, as owner/name. Empty disables code work.
    repos: list(env.SLACKLINE_REPOS),
    testCommand: env.SLACKLINE_TEST_COMMAND || "",
    dryRun: env.SLACKLINE_DRY_RUN === "1",
  };
}

/** Which settings each command needs. Returns the names that are missing. */
export function missing(cfg, command) {
  const need = {
    start: ["slackBotToken", "slackAppToken", "linearApiKey", "linearTeamId", "anthropicApiKey"],
    run: ["linearApiKey", "linearTeamId", "anthropicApiKey"],
  }[command] || [];
  const envName = {
    slackBotToken: "SLACK_BOT_TOKEN", slackAppToken: "SLACK_APP_TOKEN", linearApiKey: "LINEAR_API_KEY",
    linearTeamId: "LINEAR_TEAM_ID", anthropicApiKey: "ANTHROPIC_API_KEY",
  };
  return need.filter((k) => !cfg[k]).map((k) => envName[k]);
}

/** Loads slackline.config.mjs from the working directory, if there is one. */
export async function loadUserConfig(cwd = process.cwd(), file = "slackline.config.mjs") {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { actions: [] };
  const mod = await import(pathToFileURL(path).href);
  const conf = mod.default || mod;
  return { actions: conf.actions || [], instructions: conf.instructions || "" };
}
