import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

/** Resolves a path the model gave us, refusing anything outside the repo or inside .git. */
export function inside(root, p = ".") {
  const full = resolve(root, p);
  const rel = relative(root, full);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error(`path outside the repository: ${p}`);
  if (rel.split(sep)[0] === ".git") throw new Error("the .git folder is off limits");
  return full;
}

async function walk(root, dir, out, limit) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out, limit);
    else out.push(relative(root, full));
  }
}

/**
 * The file tools the code worker hands to the model. Every path goes
 * through inside(), and edits must match exactly once so the model can't
 * silently change the wrong spot.
 */
export function fileTools(root, { testCommand = "" } = {}) {
  const tools = [
    {
      name: "list_files",
      description: "List files under a folder of the repository (recursive, up to 400).",
      input_schema: { type: "object", properties: { path: { type: "string", description: "Folder, default the repo root." } } },
      async run({ path = "." }) {
        const out = [];
        await walk(root, inside(root, path), out, 400);
        return out.sort().join("\n") || "(empty)";
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the repository.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async run({ path }) {
        const text = await fs.readFile(inside(root, path), "utf8");
        return text.length > 60000 ? text.slice(0, 60000) + "\n…(truncated)" : text;
      },
    },
    {
      name: "search",
      description: "Find lines containing a piece of text (case-sensitive). Returns path:line: text.",
      input_schema: { type: "object", properties: { text: { type: "string" }, path: { type: "string" } }, required: ["text"] },
      async run({ text, path = "." }) {
        const files = [];
        await walk(root, inside(root, path), files, 4000);
        const hits = [];
        for (const f of files) {
          let body;
          try { body = await fs.readFile(join(root, f), "utf8"); } catch { continue; }
          if (body.includes("\u0000")) continue;
          body.split("\n").forEach((line, i) => { if (line.includes(text) && hits.length < 200) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`); });
        }
        return hits.join("\n") || "no matches";
      },
    },
    {
      name: "edit_file",
      description: "Replace one exact piece of text in a file. old_text must appear exactly once.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
      async run({ path, old_text, new_text }) {
        const full = inside(root, path);
        const body = await fs.readFile(full, "utf8");
        const count = old_text ? body.split(old_text).length - 1 : 0;
        if (count !== 1) throw new Error(`old_text appears ${count} times in ${path}; it must appear exactly once`);
        await fs.writeFile(full, body.replace(old_text, () => new_text));
        return `edited ${path}`;
      },
    },
    {
      name: "write_file",
      description: "Create a new file, or overwrite a small one entirely.",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      async run({ path, content }) {
        const full = inside(root, path);
        await fs.mkdir(resolve(full, ".."), { recursive: true });
        await fs.writeFile(full, content);
        return `wrote ${path}`;
      },
    },
  ];
  if (testCommand) {
    tools.push({
      name: "run_tests",
      description: `Run the project's checks (${testCommand}). Returns the last part of the output.`,
      input_schema: { type: "object", properties: {} },
      async run() {
        try {
          const { stdout, stderr } = await run("sh", ["-c", testCommand], { cwd: root, timeout: 300000, maxBuffer: 1e7 });
          return `passed\n${(stdout + stderr).slice(-4000)}`;
        } catch (e) {
          return `failed (exit ${e.code})\n${((e.stdout || "") + (e.stderr || "")).slice(-4000)}`;
        }
      },
    });
  }
  return tools;
}

export const git = (cwd, ...args) => run("git", args, { cwd, maxBuffer: 1e7 }).then((r) => r.stdout.trim());
