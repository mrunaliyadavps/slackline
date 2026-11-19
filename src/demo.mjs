import { fileURLToPath } from "node:url";
import { handle } from "./agent.mjs";
import { scripted, say, use } from "./llm.mjs";
import { memoryLinear } from "./adapters/linear.mjs";
import { localGithub } from "./adapters/github.mjs";

const repo = fileURLToPath(new URL("../examples/demo-repo", import.meta.url));

/**
 * The offline demo: real agent code, real file edits and a real git commit,
 * with Claude, Slack, Linear and GitHub replaced by local stand-ins. Nothing
 * leaves your machine and no keys are needed.
 */
export const requests = [
  {
    text: "the signup button on the pricing page says Sumbit, can you fix it?",
    script: [
      use("file_ticket", {
        question: "",
        title: "Fix typo on pricing page signup button",
        description: "The signup button on the pricing page reads “Sumbit”.\n\n**Done when**\n- [ ] The button reads “Submit”\n- [ ] Nothing else on the page changes",
        kind: "code",
        repo: "acme/web",
      }),
      use("search", { text: "Sumbit" }, "Let me find the button."),
      use("edit_file", { path: "src/pricing.html", old_text: ">Sumbit<", new_text: ">Submit<" }),
      say("Fixed the button label in src/pricing.html (“Sumbit” → “Submit”). No other copy on the page had the typo."),
    ],
  },
  {
    text: "write two lines of release notes for the pricing page fix",
    script: [
      use("file_ticket", {
        question: "",
        title: "Release notes for pricing page fix",
        description: "Two lines of release notes covering the signup button fix.\n\n**Done when**\n- [ ] Two lines, plain language",
        kind: "write",
        repo: "",
      }),
      say("**Fixed:** The signup button on the pricing page now says “Submit”.\nThanks to everyone who flagged it."),
    ],
  },
  {
    text: "make the onboarding better",
    script: [
      use("file_ticket", { question: "Which part of onboarding, and what's going wrong there? A screen or a step people drop off at is enough.", title: "", description: "", kind: "write", repo: "" }),
    ],
  },
];

export async function demo({ print = console.log, color = true } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const linear = memoryLinear("ENG");
  const github = localGithub({ "acme/web": repo });
  const cfg = { repos: ["acme/web"], maxTurns: 10, repoBranchPrefix: "slackline/" };
  for (const r of requests) {
    print("");
    print(`${c("1", "Maya")}  ${c("2", "#product")}`);
    print(`  @slackline ${r.text}`);
    const reply = async (text) => print(`  ${c("1;34", "slackline")}  ${text.replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/\n/g, "\n             ")}`);
    const log = (m) => print(c("2", `             · ${m}`));
    await handle({ text: r.text, user: "U_MAYA", channel: "C_PRODUCT" }, { llm: scripted(r.script), linear, github, reply, cfg, log });
  }
  print("");
  print(c("1", "Linear"));
  for (const i of linear.issues) print(`  ${i.key}  ${i.state.padEnd(12)} ${i.title}`);
  for (const pr of github.prs) {
    print("");
    print(c("1", `Pull request on ${pr.repo}`) + `  ${pr.branch}`);
    print("  " + pr.diff.replace(/\n/g, "\n  "));
  }
  return { linear, github };
}
