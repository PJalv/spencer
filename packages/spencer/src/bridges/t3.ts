/**
 * `spencer mcp t3`: a stdio MCP server that gives Spencer T3 Code's threads (list, start, send, read) through the
 * `t3` CLI, which talks to the running T3 Code server. The binary is found per call (`T3_BIN`, `PATH`, then the
 * `~/.t3/bin/t3`, then the newest `~/.t3/runtime/versions/<v>/t3`), so T3 updates need no reconfiguration.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { McpServerConfig } from "../config.ts";
import { type BridgeTool, ToolError, int, selfCommand, serveStdio, sleep, str } from "./stdio-server.ts";

/** Spencer gives an MCP call 120 s; stay well under it. */
const MAX_WAIT_S = 100;
const CLI_TIMEOUT_MS = 60_000;
/** Whole-call budget for thread_start/thread_send, CLI calls included. */
const CALL_BUDGET_MS = 110_000;

const timeLeft = (deadline: number) => Math.max(1_000, Math.min(CLI_TIMEOUT_MS, deadline - Date.now()));

export function findT3(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (env.T3_BIN) return env.T3_BIN;
  const exe = process.platform === "win32" ? "t3.exe" : "t3";
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isFile(join(dir, exe))) return join(dir, exe);
  }
  const installed = join(home, ".t3", "bin", exe);
  if (isFile(installed)) return installed;
  const root = join(home, ".t3", "runtime", "versions");
  let versions: string[] = [];
  try {
    versions = readdirSync(root);
  } catch {
    return undefined;
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  // A version folder without the marker may still be installing.
  for (const v of versions) if (isFile(join(root, v, exe)) && existsSync(join(root, v, ".install-complete"))) return join(root, v, exe);
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Run `t3 <args>`; stdout on success, a ToolError with its stderr otherwise. */
async function t3(args: string[], stdin?: string, timeoutMs = CLI_TIMEOUT_MS): Promise<string> {
  const bin = findT3();
  if (!bin || !existsSync(bin)) throw new ToolError("T3 Code's `t3` command was not found (set T3_BIN to its path).");
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`could not run t3: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const e = new ToolError((err || out).trim() || `t3 ${args[0]} ${args[1]} failed (exit ${code})`);
      e.stdout = out.trim();
      reject(e);
    });
    child.stdin.on("error", () => {}); // EPIPE when t3 exits without reading; its exit code tells the story
    child.stdin.end(stdin ?? "");
  });
}

/** The thread id (and link) from `t3 thread start --json` output, if it has one. */
function parseStarted(out: string): { id: string; link: string } | undefined {
  try {
    const j = JSON.parse(out) as { threadId?: string; link?: string; thread?: { threadId?: string; link?: string } };
    const id = j.threadId ?? j.thread?.threadId;
    return id ? { id, link: j.link ?? j.thread?.link ?? "" } : undefined;
  } catch {
    const id = out.trim();
    return /^[\w-]{8,}$/.test(id) ? { id, link: "" } : undefined;
  }
}

interface ThreadJson {
  thread: { status?: string; activeRunId?: string | null; pendingRequestCount?: number };
}

/** Wait until the thread's run is over (or it waits for an answer), at most `seconds`. True when it finished. */
async function waitIdle(thread: string, until: number, deadline: number): Promise<boolean> {
  const start = Date.now();
  let seenActive = false;
  while (Date.now() < until) {
    const t = (JSON.parse(await t3(["thread", "show", thread, "--messages", "0", "--json"], undefined, timeLeft(deadline))) as ThreadJson).thread;
    const active = !!t.activeRunId || t.status === "running";
    if (active) seenActive = true;
    if ((t.pendingRequestCount ?? 0) > 0) return true;
    // A just-sent message may take a moment to start its run.
    if (!active && (seenActive || Date.now() - start > 8_000)) return true;
    await sleep(2_000);
  }
  return false;
}

/** Never throws: the thread already exists, so the caller must get its id back. */
async function afterWait(thread: string, seconds: number, prefix: string, deadline: number): Promise<string> {
  if (seconds <= 0) return `${prefix}\nIt runs in the background; read it later with thread_show.`;
  try {
    // Leave room for the final `thread show`.
    const done = await waitIdle(thread, Math.min(Date.now() + seconds * 1000, deadline - 10_000), deadline);
    const shown = await t3(["thread", "show", thread, "--messages", "3"], undefined, timeLeft(deadline));
    return `${prefix}\n${done ? "" : "Still working; read it again later with thread_show.\n"}\n${shown}`;
  } catch (e) {
    return `${prefix}\nCould not read it back (${(e as Error).message}); try thread_show later.`;
  }
}

export function t3Tools(defaultProject: string): BridgeTool[] {
  const projectProp = {
    type: "string",
    description: `T3 Code project id or a folder path inside the project. Default: ${defaultProject}`,
  };
  const waitProp = {
    type: "number",
    description: `Seconds to wait for the agent's reply before returning (0-${MAX_WAIT_S}, default 0). For longer work, return at once and check back with thread_show (e.g. via schedule_followup).`,
  };
  return [
    {
      name: "thread_list",
      description: "List a T3 Code project's threads, newest first: id, title, status, model.",
      inputSchema: { type: "object", properties: { project: projectProp } },
      run: async (a) => (await t3(["thread", "list", "--project", str(a, "project") ?? defaultProject])) || "No threads.",
    },
    {
      name: "thread_start",
      description:
        "Start a new T3 Code thread: a coding agent working in the project's folder (or a new git worktree) on the message. Returns the thread id.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The task or question for the agent." },
          project: projectProp,
          title: { type: "string", description: "Thread title (default: the message's first line)." },
          worktree: { type: "string", description: "Run in a new git worktree based on this branch, tag or commit instead of the project folder." },
          branch: { type: "string", description: "Branch name for the new worktree." },
          provider: { type: "string", description: "Provider instance id (with model). Default: the project's." },
          model: { type: "string", description: "Model slug. Default: the project's default model." },
          options: { type: "array", items: { type: "string" }, description: "Provider options as id=value pairs." },
          generate_title: { type: "boolean", description: "Generate a title for the thread." },
          wait_seconds: waitProp,
        },
        required: ["message"],
      },
      run: async (a) => {
        const args = ["thread", "start", "--json"];
        for (const k of ["title", "worktree", "branch", "provider", "model"]) {
          const v = str(a, k);
          if (v) args.push(`--${k}`, v);
        }
        if (a.options !== undefined) {
          if (!Array.isArray(a.options) || !a.options.every((option) => typeof option === "string")) throw new ToolError("options must be an array of strings");
          for (const option of a.options) args.push("--option", option);
        }
        if (a.generate_title !== undefined && typeof a.generate_title !== "boolean") throw new ToolError("generate_title must be a boolean");
        if (a.generate_title) args.push("--generate-title");
        args.push(str(a, "project") ?? defaultProject, "-");
        const deadline = Date.now() + CALL_BUDGET_MS;
        // Check every argument before the thread exists, so a bad one can't lose its id.
        const message = str(a, "message", true);
        const wait = int(a, "wait_seconds", 0, 0, MAX_WAIT_S);
        let out: string;
        let warning = "";
        try {
          out = await t3(args, message);
        } catch (e) {
          // t3 may print the new thread before it fails or times out; then the thread exists and must not be started again.
          if (!(e instanceof ToolError) || !e.stdout || !parseStarted(e.stdout)) throw e;
          out = e.stdout;
          warning = `\nt3 reported a problem after creating it (${e.message}); do not start it again.`;
        }
        const { id, link } = parseStarted(out) ?? { id: out, link: "" };
        return await afterWait(id, wait, `Started thread ${id}${link ? ` (${link})` : ""}.${warning}`, deadline);
      },
    },
    {
      name: "thread_send",
      description: "Send a message to an existing T3 Code thread. A busy thread gets it as its next turn; nothing is interrupted.",
      inputSchema: {
        type: "object",
        properties: { thread: { type: "string", description: "Thread id." }, message: { type: "string" }, wait_seconds: waitProp },
        required: ["thread", "message"],
      },
      run: async (a) => {
        const thread = str(a, "thread", true);
        const deadline = Date.now() + CALL_BUDGET_MS;
        const message = str(a, "message", true);
        const wait = int(a, "wait_seconds", 0, 0, MAX_WAIT_S);
        await t3(["thread", "send", thread, "-"], message);
        return await afterWait(thread, wait, `Sent to thread ${thread}.`, deadline);
      },
    },
    {
      name: "thread_show",
      description: "Show a T3 Code thread's state (running, idle, waiting for an answer) and its latest messages.",
      inputSchema: {
        type: "object",
        properties: {
          thread: { type: "string", description: "Thread id." },
          messages: { type: "number", description: "How many of the latest messages (1-20, default 5)." },
        },
        required: ["thread"],
      },
      run: async (a) => await t3(["thread", "show", str(a, "thread", true), "--messages", String(int(a, "messages", 5, 1, 20))]),
    },
  ];
}

export interface McpPreset {
  name: string;
  title: string;
  description: string;
  config: McpServerConfig;
  /** Why it would not work here yet (e.g. T3 Code is not installed). */
  problem?: string;
}

/** The "T3 Code" entry offered in the MCP servers page. */
export function t3Preset(cwd = process.cwd()): McpPreset {
  const bin = findT3();
  // A service usually runs from / or $HOME, which is no project; then the user must fill T3_PROJECT in.
  const project = cwd !== "/" && cwd !== homedir() ? cwd : "";
  const problem = !bin
    ? "T3 Code's t3 command was not found on this machine."
    : !project
      ? "Set T3_PROJECT (under Environment) to your T3 Code project's folder."
      : undefined;
  return {
    name: "t3code",
    title: "T3 Code",
    description:
      "List, start, message and read T3 Code threads (coding agents on this machine). T3_PROJECT is the default project. Its tools start turned off; check the ones Spencer may use.",
    // Off until the owner checks them: these tools start coding agents on this machine.
    config: { ...selfCommand(["mcp", "t3"]), env: { T3_PROJECT: project }, disabledTools: t3Tools("").map((t) => t.name) },
    ...(problem ? { problem } : {}),
  };
}

export async function runT3Bridge(): Promise<void> {
  const project = process.env.T3_PROJECT || process.cwd();
  const tools = t3Tools(project);
  await serveStdio(
    "t3code",
    "T3 Code threads: coding agents on the owner's machine. Start one for real coding work, then check on it with thread_show.",
    () => tools,
  );
}
