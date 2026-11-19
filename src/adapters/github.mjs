import { Octokit } from "@octokit/rest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../workspace.mjs";

/**
 * GitHub: shallow-clone a repo, then push a branch and open a pull request.
 * The agent never merges; a person reviews every change.
 */
export function github({ token }) {
  const octokit = new Octokit({ auth: token });
  return {
    async checkout(repo, branch) {
      const dir = await fs.mkdtemp(join(tmpdir(), "slackline-"));
      const url = `https://x-access-token:${token}@github.com/${repo}.git`;
      await git(dir, "clone", "--depth", "1", url, ".");
      await git(dir, "checkout", "-b", branch);
      return dir;
    },
    async openPullRequest({ repo, dir, branch, title, body }) {
      await git(dir, "push", "origin", branch);
      const [owner, name] = repo.split("/");
      const { data: info } = await octokit.repos.get({ owner, repo: name });
      const { data: pr } = await octokit.pulls.create({ owner, repo: name, head: branch, base: info.default_branch, title, body });
      return pr.html_url;
    },
    async cleanup(dir) {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Local stand-in: copies a folder into a temp git repo and "opens" a PR by recording it. */
export function localGithub(sources) {
  const prs = [];
  return {
    prs,
    async checkout(repo, branch) {
      const dir = await fs.mkdtemp(join(tmpdir(), "slackline-"));
      await fs.cp(sources[repo], dir, { recursive: true });
      await git(dir, "init", "-q", "-b", "main");
      await git(dir, "-c", "user.email=demo@slackline.dev", "-c", "user.name=demo", "add", "-A");
      await git(dir, "-c", "user.email=demo@slackline.dev", "-c", "user.name=demo", "commit", "-qm", "initial");
      await git(dir, "checkout", "-qb", branch);
      return dir;
    },
    async openPullRequest({ repo, dir, branch, title, body }) {
      const diff = await git(dir, "diff", "main", "--", ".");
      prs.push({ repo, branch, title, body, diff });
      return `https://github.com/${repo}/pull/${prs.length}`;
    },
    async cleanup() {},
  };
}
