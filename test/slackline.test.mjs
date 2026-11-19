import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handle, queue } from "../src/agent.mjs";
import { triage } from "../src/triage.mjs";
import { loop, scripted, say, use } from "../src/llm.mjs";
import { inside, fileTools } from "../src/workspace.mjs";
import { memoryLinear } from "../src/adapters/linear.mjs";
import { localGithub } from "../src/adapters/github.mjs";
import { stripMention } from "../src/adapters/slack.mjs";
import { readEnv, missing } from "../src/config.mjs";
import { actionWorker } from "../src/workers.mjs";

const demoRepo = fileURLToPath(new URL("../examples/demo-repo", import.meta.url));
const ticket = (o = {}) => use("file_ticket", { question: "", title: "Fix the typo", description: "Fix it", kind: "code", repo: "acme/web", ...o });
const setup = (script, cfg = {}) => {
  const replies = [];
  const linear = memoryLinear();
  const github = localGithub({ "acme/web": demoRepo });
  const deps = { llm: scripted(script), linear, github, reply: async (t) => replies.push(t), cfg: { repos: ["acme/web"], maxTurns: 8, ...cfg } };
  return { deps, replies, linear, github };
};
const req = { text: "fix the typo on pricing", user: "U1", channel: "C1" };

test("code request: ticket, edit, commit, pull request, ticket in review", async () => {
  const { deps, replies, linear, github } = setup([
    ticket(),
    use("edit_file", { path: "src/pricing.html", old_text: ">Sumbit<", new_text: ">Submit<" }),
    say("Fixed the label."),
  ]);
  const out = await handle(req, deps);
  assert.equal(out.status, "done");
  assert.equal(linear.issues[0].state, "In Review");
  assert.match(linear.issues[0].comments[0], /Pull request: https:\/\/github.com\/acme\/web\/pull\/1/);
  assert.equal(github.prs.length, 1);
  assert.match(github.prs[0].diff, /-\s+<button type="submit">Sumbit<\/button>/);
  assert.match(github.prs[0].diff, /\+\s+<button type="submit">Submit<\/button>/);
  assert.match(github.prs[0].title, /\(ENG-101\)/);
  assert.match(replies[0], /^Filed <https:\/\/linear.app\/demo\/issue\/ENG-101\|ENG-101>/);
  assert.match(replies.at(-1), /Pull request for review/);
  // the source fixture itself must never be modified
  assert.match(await fs.readFile(join(demoRepo, "src/pricing.html"), "utf8"), /Sumbit/);
});

test("write request: text goes on the ticket and back to Slack, ticket done", async () => {
  const { deps, replies, linear } = setup([ticket({ kind: "write", repo: "" }), say("Here is the copy.")]);
  const out = await handle(req, deps);
  assert.equal(out.status, "done");
  assert.equal(linear.issues[0].state, "Done");
  assert.deepEqual(linear.issues[0].comments, ["Here is the copy."]);
  assert.match(replies.at(-1), /Here is the copy\./);
});

test("vague request: asks one question and files nothing", async () => {
  const { deps, replies, linear } = setup([ticket({ question: "Which page?" })]);
  const out = await handle(req, deps);
  assert.equal(out.status, "asked");
  assert.deepEqual(replies, ["Which page?"]);
  assert.equal(linear.issues.length, 0);
});

test("allowlists are enforced before the model is called", async () => {
  const { deps, replies } = setup([], { allowedUsers: ["U_OTHER"] });
  assert.equal((await handle(req, deps)).status, "refused");
  assert.equal(deps.llm.calls.length, 0);
  assert.match(replies[0], /allowlist/);
  const b = setup([], { allowedChannels: ["C_OTHER"] });
  assert.equal((await handle(req, b.deps)).status, "refused");
});

test("no changes means no pull request, and the ticket says why", async () => {
  const { deps, linear, github } = setup([ticket(), say("The typo is already fixed.")]);
  const out = await handle(req, deps);
  assert.equal(out.status, "unfinished");
  assert.equal(github.prs.length, 0);
  assert.match(linear.issues[0].comments[0], /already fixed/);
});

test("running out of turns does not open a pull request", async () => {
  const { deps, github } = setup([
    ticket(),
    use("edit_file", { path: "src/pricing.html", old_text: ">Sumbit<", new_text: ">Submit<" }),
    use("read_file", { path: "README.md" }),
  ], { maxTurns: 2 });
  const out = await handle(req, deps);
  assert.equal(out.status, "unfinished");
  assert.match(out.result.summary, /ran out of steps/);
  assert.equal(github.prs.length, 0);
});

test("triage turns code for an unknown repo into a question, and action without tools into write", async () => {
  const q = await triage(scripted([ticket({ repo: "evil/repo" })]), { text: "x", user: "U", channel: "C", repos: ["acme/web"] });
  assert.match(q.question, /acme\/web/);
  const w = await triage(scripted([ticket({ kind: "action", repo: "" })]), { text: "x", user: "U", channel: "C", repos: [], actions: [] });
  assert.equal(w.kind, "write");
  const weird = await triage(scripted([ticket({ kind: "deploy", repo: "" })]), { text: "x", user: "U", channel: "C" });
  assert.equal(weird.kind, "write");
});

test("file tools stay inside the repository", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "sl-"));
  await fs.writeFile(join(root, "a.txt"), "one two one");
  for (const p of ["../x", "/etc/passwd", ".git/config", "a/../../x"]) assert.throws(() => inside(root, p), /outside|off limits/);
  assert.equal(inside(root, "a.txt"), join(root, "a.txt"));
  const tools = Object.fromEntries(fileTools(root).map((t) => [t.name, t]));
  await assert.rejects(tools.edit_file.run({ path: "a.txt", old_text: "one", new_text: "1" }), /2 times/);
  await assert.rejects(tools.edit_file.run({ path: "a.txt", old_text: "", new_text: "1" }), /0 times/);
  await tools.edit_file.run({ path: "a.txt", old_text: "two", new_text: "$& 2" });
  assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "one $& 2 one");
  assert.equal(tools.run_tests, undefined);
  assert.ok(fileTools(root, { testCommand: "true" }).some((t) => t.name === "run_tests"));
});

test("a failing tool is reported to the model, not thrown", async () => {
  const llm = scripted([use("boom", {}), say("recovered")]);
  const steps = [];
  const out = await loop(llm, { prompt: "go", tools: [{ name: "boom", description: "", input_schema: { type: "object" }, run: () => { throw new Error("nope"); } }], onStep: (s) => steps.push(s) });
  assert.equal(out.text, "recovered");
  const result = llm.calls[1].messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /nope/);
  assert.match(steps[0].error, /nope/);
});

test("dry run never calls a real action", async () => {
  let called = false;
  const actions = [{ name: "post_update", description: "", input_schema: { type: "object" }, run: () => { called = true; } }];
  const out = await actionWorker({ llm: scripted([use("post_update", { a: 1 }), say("done")]), ticket: { key: "ENG-1", title: "t", description: "d" }, actions, cfg: { dryRun: true, maxTurns: 4 } });
  assert.equal(called, false);
  assert.ok(out.ok);
});

test("queue runs jobs one at a time, even after a failure", async () => {
  const order = [];
  const q = queue();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.allSettled([
    q(async () => { await wait(20); order.push(1); throw new Error("x"); }),
    q(async () => { order.push(2); }),
  ]);
  assert.deepEqual(order, [1, 2]);
});

test("small helpers", () => {
  assert.equal(stripMention("<@U123ABC>  fix   the typo"), "fix the typo");
  const cfg = readEnv({ SLACKLINE_REPOS: "a/b, c/d", SLACKLINE_DRY_RUN: "1" });
  assert.deepEqual(cfg.repos, ["a/b", "c/d"]);
  assert.equal(cfg.dryRun, true);
  assert.deepEqual(missing(cfg, "run"), ["LINEAR_API_KEY", "LINEAR_TEAM_ID", "ANTHROPIC_API_KEY"]);
});
