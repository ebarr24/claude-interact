#!/usr/bin/env node
// claude-interact machine agent. Connects out to the hub over WebSocket and exposes this
// machine's Claude Code sessions as tools: list, start, message, read, stop.
// Zero dependencies; needs Node >= 22 (global WebSocket) and the `claude` CLI on PATH.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const AGENT_VERSION = "0.8.0";
// claude.ai gives up on a tool call after 60s, so return well before that; work that takes longer
// keeps going and get_session picks it up.
const MAX_WAIT_SECONDS = 45;
const DEFAULT_WAIT_SECONDS = 40;
const FINISHED_RUN_TTL_MS = 60 * 60 * 1000;
const MAX_TEXT = 4000;

// ---------- config ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? process.env.CLAUDE_INTERACT_CONFIG ?? path.join(here, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const hubUrl = process.env.CLAUDE_INTERACT_HUB_URL ?? config.hubUrl;
const agentToken = process.env.CLAUDE_INTERACT_AGENT_TOKEN ?? config.agentToken;
const machine = config.machine ?? os.hostname().replace(/[^A-Za-z0-9-]/g, "-").slice(0, 24);
// The desktop app's bundled CLI when there is one (kept current by the app), else `claude` on PATH.
const claudeCommand = () => config.claudeCommand ?? relayClaude() ?? "claude";
const claudeDir = config.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const allowedRoots = (config.allowedRoots ?? []).map((r) => path.resolve(r.replace(/^~(?=$|[\\/])/, os.homedir())));
const permissionModes = config.permissionModes?.allowed ?? ["default", "acceptEdits", "plan", "auto", "dontAsk"];
// Every run the connector starts or continues uses auto mode unless the caller picks another mode.
const defaultPermissionMode = "auto";
if (config.permissionModes?.default && config.permissionModes.default !== defaultPermissionMode) {
  process.stderr.write(`note: permissionModes.default ("${config.permissionModes.default}") is ignored; runs default to auto\n`);
}

const expandHome = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const projectDirs = (config.projectDirs ?? []).map(expandHome);
const explicitProjects = Object.fromEntries(Object.entries(config.projects ?? {}).map(([name, dir]) => [name, expandHome(dir)]));
const defaultProject = config.defaultProject ?? null;

if (!hubUrl || !agentToken) fail("config needs hubUrl and agentToken");
if (allowedRoots.length === 0) fail("config needs at least one entry in allowedRoots");
if (!permissionModes.includes(defaultPermissionMode)) fail("permissionModes.allowed must include auto");
if (defaultProject && !explicitProjects[defaultProject]) fail(`defaultProject "${defaultProject}" must be listed in projects`);

function fail(msg) {
  console.error(`claude-interact agent: ${msg} (${configPath})`);
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- paths & sessions on disk ----------

const projectsDir = path.join(claudeDir, "projects");
const liveDir = path.join(claudeDir, "sessions");
const caseless = process.platform === "win32" || process.platform === "darwin";
const norm = (p) => (caseless ? path.resolve(p).toLowerCase() : path.resolve(p));

function isAllowedDir(dir) {
  const d = norm(dir);
  return allowedRoots.some((root) => {
    const r = norm(root);
    return d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

// ---------- projects ----------

// Markers that make a folder under a projectDirs entry count as a project.
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "requirements.txt", "CLAUDE.md", "Cargo.toml", "go.mod", "wrangler.toml", "wrangler.jsonc", "wrangler.json"];

function looksLikeProject(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.some((e) => PROJECT_MARKERS.includes(e) || e.endsWith(".py") || e.endsWith(".sln"));
  } catch {
    return false;
  }
}

// name -> folder. Explicit projects win over discovered ones with the same name.
function projects() {
  const out = new Map();
  for (const parent of projectDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || /^[.$]/.test(e.name)) continue;
      const dir = path.join(parent, e.name);
      if (isAllowedDir(dir) && looksLikeProject(dir)) out.set(e.name, dir);
    }
  }
  for (const [name, dir] of Object.entries(explicitProjects)) {
    if (isAllowedDir(dir)) out.set(name, dir);
    else log(`warning: project "${name}" (${dir}) is outside allowedRoots; ignoring it`);
  }
  return out;
}

function resolveProject(name) {
  const all = projects();
  const wanted = name ?? defaultProject;
  if (!wanted) throw new Error("No project given and no defaultProject configured. See list_projects.");
  const key = [...all.keys()].find((k) => k.toLowerCase() === wanted.toLowerCase());
  if (!key) throw new Error(`Unknown project "${wanted}". See list_projects.`);
  const dir = all.get(key);
  if (key === defaultProject) fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Project folder ${dir} does not exist`);
  return { name: key, dir };
}

function sessionFiles() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(projectsDir, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      try {
        out.push({ sessionId: f.slice(0, -6), file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findSessionFile(sessionId) {
  return sessionFiles().find((s) => s.sessionId === sessionId);
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // partial line at a slice boundary
  }
  return out;
}

// Cheap metadata from the head and tail of a transcript, without reading the whole file.
function sessionMeta(s) {
  const size = fs.statSync(s.file).size;
  const head = parseLines(readSlice(s.file, 0, Math.min(size, 64 * 1024)));
  const tailStart = Math.max(0, size - 256 * 1024);
  const tail = tailStart === 0 ? head : parseLines(readSlice(s.file, tailStart, size - tailStart));
  const lastOf = (entries, type) => entries.findLast((e) => e.type === type);
  const title = lastOf(tail, "custom-title")?.customTitle ?? lastOf(head, "custom-title")?.customTitle;
  const lastPrompt = lastOf(tail, "last-prompt")?.lastPrompt ?? lastOf(head, "last-prompt")?.lastPrompt;
  const withCwd = head.find((e) => e.cwd) ?? tail.find((e) => e.cwd);
  return {
    session_id: s.sessionId,
    title: title ?? null,
    cwd: withCwd?.cwd ?? null,
    last_prompt: lastPrompt ? truncate(lastPrompt, 300) : null,
    entrypoint: withCwd?.entrypoint ?? null,
    updated_at: new Date(s.mtimeMs).toISOString(),
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Sessions currently open in some Claude Code process (terminal, IDE, desktop app).
function liveSessions() {
  const live = new Map();
  let files = [];
  try {
    files = fs.readdirSync(liveDir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return live;
  }
  for (const f of files) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(liveDir, f), "utf8"));
      if (!info.sessionId || !pidAlive(info.pid) || ourPids.has(info.pid)) continue;
      live.set(info.sessionId, {
        pid: info.pid,
        status: info.status ?? null,
        entrypoint: info.entrypoint ?? null,
        name: info.name ?? null,
        startedAt: info.startedAt ?? null,
      });
    } catch {}
  }
  return live;
}

// The Claude desktop app keeps one record per Code-tab chat (local_<id>.json) holding its title,
// archived flag and the CLI session it wraps. Internal format: read-only, and skipped if it changes.
const desktopSessionsDir =
  config.desktopSessionsDir ??
  (process.platform === "win32"
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude-code-sessions")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Claude", "claude-code-sessions"));

// cliSessionId -> { desktop_id, title, archived, link }
function desktopChats() {
  const chats = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^local_[0-9a-f-]+\.json$/i.test(e.name)) {
        try {
          const r = JSON.parse(fs.readFileSync(p, "utf8"));
          if (typeof r.cliSessionId !== "string" || typeof r.sessionId !== "string") continue;
          chats.set(r.cliSessionId, {
            desktop_id: r.sessionId,
            title: typeof r.title === "string" ? r.title : null,
            archived: r.isArchived === true,
            link: `claude://claude.ai/epitaxy/${r.sessionId}`,
            settings: { model: r.model, effort: r.effort, permissionMode: r.permissionMode },
            madeInApp: !r.adoptedFromOtherSurface,
            completedTurns: typeof r.completedTurns === "number" ? r.completedTurns : 0,
            activeAt: r.lastActivityAt ?? r.createdAt ?? 0,
          });
        } catch {}
      }
    }
  };
  walk(desktopSessionsDir, 0);
  return chats;
}

// A chat the desktop app adopts keeps the model and permission mode of its first turn, so desktop
// chats start with the model and effort of the user's most recent chat made in the app (or
// config.desktopDefaults), and in auto mode.
function desktopDefaults() {
  let latest = null;
  for (const c of desktopChats().values()) {
    if (c.madeInApp && typeof c.settings.model === "string" && (!latest || c.activeAt > latest.activeAt)) latest = c;
  }
  const s = { ...latest?.settings, ...config.desktopDefaults };
  return {
    model: typeof s.model === "string" ? s.model : undefined,
    effort: typeof s.effort === "string" ? s.effort : undefined,
  };
}

function stripReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function truncate(text, n = MAX_TEXT) {
  return text.length > n ? text.slice(0, n) + `… [${text.length - n} more chars]` : text;
}

// Conversation turns (user text / assistant text + tool names) from a transcript.
async function readTurns(file) {
  const turns = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Relayed cross-session messages are meta entries with turnOrigin "peer"; keep those.
    if (e.isSidechain || (e.isMeta && e.turnOrigin !== "peer") || !e.message) continue;
    const content = e.message.content;
    if (e.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const text = stripReminders(blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
      if (!text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      // A message relayed by cross-session messaging: show just what was sent.
      const relayed = text.match(/<cross-session-message[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/);
      if (relayed) turns.push({ role: "user", at: e.timestamp, text: relayed[1].replace(RELAY_HEADER, "").trim(), relayed: true });
      else turns.push({ role: "user", at: e.timestamp, text });
    } else if (e.type === "assistant" && Array.isArray(content)) {
      let turn = turns.at(-1);
      if (turn?.role !== "assistant") turns.push((turn = { role: "assistant", at: e.timestamp, text: "", tools: [] }));
      for (const b of content) {
        if (b.type === "text" && b.text) turn.text += (turn.text ? "\n\n" : "") + b.text;
        if (b.type === "tool_use") turn.tools.push(b.name);
        turn.endsInText = b.type === "text" && !!b.text;
      }
    }
  }
  return turns.map((t) => ({ ...t, text: truncate(t.text), ...(t.tools ? { tools: [...new Set(t.tools)] } : {}) }));
}

// Turns for display, without bookkeeping fields.
async function readMessages(file) {
  return (await readTurns(file)).map(({ endsInText, ...t }) => t);
}

// ---------- runs (headless `claude -p` processes this agent started) ----------

const runs = new Map(); // sessionId -> run
const ourPids = new Set();

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      // Drop markers of a parent Claude Code session so the child starts as a normal session.
      !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_.*|EXECPATH))$/.test(k)
  )
);

// New session (sessionId), continue one (resume), or continue a copy of forkFrom saved as sessionId.
// `track: false` keeps the run out of `runs` (a desktop chat's setup turn, tracked by its desktop run).
function startRun({ sessionId, cwd, prompt, resume, forkFrom, permissionMode, model, effort, title, track = true }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode];
  if (forkFrom) args.push("--resume", forkFrom, "--fork-session", "--session-id", sessionId);
  else args.push(resume ? "--resume" : "--session-id", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (title) args.push("--name", title);

  const run = {
    sessionId,
    cwd,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    reply: "",
    result: null,
    stderr: "",
  };
  run.done = new Promise((resolve) => (run.finish = resolve));
  if (track) runs.set(sessionId, run);

  const child = spawn(claudeCommand(), args, { cwd, env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  run.child = child;
  if (child.pid) ourPids.add(child.pid);
  child.stdin.end(prompt);

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === "assistant") {
      const text = (m.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) run.reply = text; // keep the latest assistant text; the final one is the answer
    } else if (m.type === "result") {
      run.result = {
        subtype: m.subtype,
        is_error: m.is_error,
        text: m.result ?? null,
        num_turns: m.num_turns,
        duration_ms: m.duration_ms,
        total_cost_usd: m.total_cost_usd,
        permission_denials: (m.permission_denials ?? []).map((d) => d.tool_name),
      };
    }
  });
  child.stderr.on("data", (d) => (run.stderr = (run.stderr + d).slice(-2000)));

  const settle = (status) => {
    if (run.status !== "running") return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    ourPids.delete(child.pid);
    setTimeout(() => runs.get(sessionId) === run && runs.delete(sessionId), FINISHED_RUN_TTL_MS).unref();
    // Every connector chat ends up in the desktop app for the user to review.
    if (track && showRunsInDesktop) run.shownInDesktop = revealInDesktop(sessionId);
    run.finish();
  };
  child.on("error", (err) => {
    run.stderr += `\nspawn failed: ${err.message}`;
    settle("error");
  });
  child.on("exit", (code, signal) => {
    if (run.stopped) return settle("stopped");
    if (code !== 0) run.stderr += `\nexit code ${code}${signal ? ` (${signal})` : ""}`;
    settle(code === 0 && !run.result?.is_error ? "done" : "error");
  });
  return run;
}

async function waitFor(run, seconds) {
  const s = Math.max(0, Math.min(Number(seconds ?? DEFAULT_WAIT_SECONDS), MAX_WAIT_SECONDS));
  if (run.status === "running" && s > 0) {
    let t;
    await Promise.race([run.done, new Promise((r) => (t = setTimeout(r, s * 1000)))]);
    clearTimeout(t);
  }
}

// ---------- desktop relay ----------
// A chat the Claude desktop app has loaded runs a new turn when it receives a cross-session
// message, inside the app with all of the app's tools. The agent can't send one itself (only
// Claude sessions have SendMessage), so it starts a tiny headless Claude that sends the text.

const RELAY_HEADER =
  "[Sent from Claude Duet through the user's claude-interact connector. Reply in this chat as usual; the connector reads your reply here, so there is no need to message back.]";
const SETUP_PROMPT =
  "This chat was opened from Claude Duet. The user's request arrives in the next message, relayed by the claude-interact connector. For now, reply with just: Ready.";
// Sender name for a relayed message, e.g. "Duet: speed up the build".
function relayLabel(text) {
  const words = text.replace(/\s+/g, " ").trim();
  return "Duet: " + (words.length > 40 ? words.slice(0, 40).replace(/\s\S*$/, "") + "…" : words);
}
const DESKTOP_LOAD_TIMEOUT_MS = 45_000;
const DESKTOP_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-session messaging needs Claude Code >= 2.1.234 on Windows; the desktop app bundles a
// current build next to its session records, so prefer the newest of those.
function relayClaude() {
  if (config.relayClaudeCommand) return config.relayClaudeCommand;
  const base = path.join(path.dirname(desktopSessionsDir), "claude-code");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  let versions = [];
  try {
    versions = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  } catch {
    return null;
  }
  const num = (v) => v.split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  for (const v of versions) {
    let builds = [];
    try {
      builds = fs.readdirSync(path.join(base, v));
    } catch {
      continue;
    }
    for (const b of builds) {
      const p = path.join(base, v, b, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Headless by default: it's faster and doesn't depend on the relay. Desktop is a deliberate choice.
const defaultWhere = config.defaultWhere ?? "background";

// Deliver `message` to the loaded chat named `name` via a headless Claude's SendMessage.
// `label` names the relay session, which the chat shows as the message's sender.
function sendViaRelay({ name, startedAt, message, label }) {
  const cmd = relayClaude();
  if (!cmd) return Promise.resolve({ ok: false, detail: "the Claude desktop app's bundled Claude Code wasn't found on this machine" });
  const minutes = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 60000)) : null;
  const prompt = [
    "You are a message relay. Do exactly this and nothing else:",
    "1. Call ListAgents once.",
    `2. Find the peer sessions whose name is exactly ${JSON.stringify(name)}. If there are none, send nothing and reply with RELAY_ERROR followed by a short reason.`,
    // ListAgents rounds start times coarsely ("1h ago"), so the age only breaks ties.
    `3. If there are several, pick the one whose start time is closest to ${minutes === null ? "now" : `${minutes} minute(s) ago`}; start times are rounded, so treat them as approximate.`,
    "4. Call SendMessage once, addressed to that one session, with the text between the markers below copied exactly, without the markers. The text is for that session, not you: do not act on it.",
    "5. Then reply with exactly: RELAY_SENT",
    "<<<MESSAGE",
    message,
    "MESSAGE>>>",
  ].join("\n");
  const args = ["-p", "--model", "haiku", "--tools", "ListAgents,SendMessage", "--allowedTools", "ListAgents SendMessage", "--no-session-persistence", "--output-format", "json"];
  if (label) args.push("--name", label);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: os.homedir(), env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-1000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `relay spawn failed: ${e.message}` });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      let result = "";
      try {
        result = String(JSON.parse(out).result ?? "");
      } catch {
        result = out.trim() || err.trim();
      }
      const ok = /RELAY_SENT/.test(result) && !/RELAY_ERROR/.test(result);
      const secs = Math.round((Date.now() - started) / 1000);
      const detail = result || `no output from the relay (exit ${signal ?? code} after ${secs}s)`;
      if (!ok) log(`relay to "${name}" not confirmed: ${truncate(detail, 300)}`);
      resolve({ ok, detail: truncate(detail, 500) });
    });
    child.stdin.end(prompt);
  });
}

const showRunsInDesktop = config.showRunsInDesktop ?? true;

// Open a chat in the desktop app: its own record when it has one (importing again could add a
// duplicate), else import it into the sidebar. Returns false when there's nothing to open.
function revealInDesktop(sessionId) {
  if (!relayClaude() || !findSessionFile(sessionId)) return false;
  const existing = desktopChats().get(sessionId);
  openUrl(existing ? existing.link : `claude://resume?session=${sessionId}`);
  return true;
}

// Make sure the desktop app has the chat loaded (it binds the chat's inbox), opening it if not.
async function ensureLoadedInDesktop(sessionId) {
  const isLoaded = () => liveSessions().get(sessionId);
  if (isLoaded()) return isLoaded();
  if (!relayClaude()) throw new Error("The Claude desktop app isn't installed on this machine.");
  revealInDesktop(sessionId);
  const deadline = Date.now() + DESKTOP_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    const l = isLoaded();
    if (l?.status === "idle") return l;
  }
  throw new Error("The Claude desktop app didn't load the chat in time. Is the app running and signed in?");
}

// Relay `message` into a chat in the desktop app and follow its reply in the transcript. `prepare`
// (creating the chat, loading it in the app) runs inside the run, so callers can return the
// session_id before it finishes.
function startDesktopRun({ sessionId, cwd, message, label, prepare }) {
  const run = {
    sessionId,
    cwd,
    ranIn: "desktop app",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    reply: "",
    result: null,
    stderr: "",
  };
  run.done = new Promise((resolve) => (run.finish = resolve));
  runs.set(sessionId, run);
  const settle = (status, detail) => {
    if (run.status !== "running") return;
    if (detail) run.stderr = detail;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    setTimeout(() => runs.get(sessionId) === run && runs.delete(sessionId), FINISHED_RUN_TTL_MS).unref();
    run.finish();
  };

  (async () => {
    if (prepare) await prepare();
    const file = findSessionFile(sessionId)?.file;
    if (!file) return settle("error", "The chat's transcript wasn't found.");
    const live = liveSessions().get(sessionId);
    if (!live) return settle("error", "The desktop app doesn't have this chat loaded.");
    const name = live.name ?? desktopChats().get(sessionId)?.title;
    if (!name) return settle("error", "This loaded chat has no title, so the relay can't address it.");
    const baseline = (await readTurns(file)).length;
    const turnsDone = () => desktopChats().get(sessionId)?.completedTurns ?? 0;
    const turnsBefore = turnsDone();
    const arrived = async () => (await readTurns(file)).slice(baseline).some((t) => t.relayed);
    const sent = await sendViaRelay({ name, startedAt: live.startedAt, message: `${RELAY_HEADER}\n\n${message}`, label: relayLabel(label ?? message) });
    // The relay's own report can go missing even when the message got through; the chat's transcript is the proof.
    if (!sent.ok) {
      let delivered = await arrived();
      for (let i = 0; i < 5 && !delivered; i++) {
        await sleep(2000);
        delivered = await arrived();
      }
      if (!delivered) return settle("error", `The relay couldn't deliver the message: ${sent.detail}`);
    }

    const deadline = Date.now() + DESKTOP_RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      const fresh = (await readTurns(file)).slice(baseline);
      const replies = fresh.filter((t) => t.role === "assistant" && t.text);
      if (replies.length) run.reply = replies.at(-1).text;
      const l = liveSessions().get(sessionId);
      if (!l) return settle(replies.length ? "done" : "error", replies.length ? null : "The chat was closed before it replied.");
      const last = fresh.at(-1);
      // Done once the newest turn is Claude's (not the relayed message) and the app is idle again.
      if (l.status === "idle" && last?.role === "assistant") return settle("done");
      // The app can stay "busy" a while after replying (post-turn housekeeping), but its chat record
      // counts the turn as completed as soon as the reply ends.
      if (last?.role === "assistant" && last.endsInText && turnsDone() > turnsBefore) return settle("done");
    }
    settle("error", "No reply within 30 minutes; check the chat in the desktop app.");
  })().catch((e) => settle("error", e.message));
  return run;
}

function runView(run) {
  const view = { session_id: run.sessionId, status: run.status, started_at: run.startedAt, finished_at: run.finishedAt, cwd: run.cwd };
  view.ran_in = run.ranIn ?? "background";
  if (run.status === "running") {
    view.note = "Still working. Call get_session with this session_id (optionally with wait_seconds) to get the reply.";
    if (run.reply) view.latest_text = truncate(run.reply);
  } else {
    view.reply = truncate(run.result?.text ?? run.reply ?? "");
    if (run.result) {
      const { text, ...rest } = run.result;
      Object.assign(view, rest);
    }
    if (run.status === "error" && run.stderr.trim()) view.stderr = run.stderr.trim();
    if (run.shownInDesktop !== undefined) view.shown_in_desktop = run.shownInDesktop;
  }
  return view;
}

// ---------- tools ----------

const wait_seconds = {
  type: "integer",
  minimum: 0,
  maximum: MAX_WAIT_SECONDS,
  description: `How long to wait for Claude to finish before returning (default ${DEFAULT_WAIT_SECONDS}). If it is still working, the result says so; call get_session later.`,
};
const permission_mode = {
  type: "string",
  enum: permissionModes,
  description:
    `Permission mode (default ${defaultPermissionMode}, for background runs, forks and new desktop chats alike; the user wants every run in auto mode, so leave it unset unless they ask otherwise). ` +
    `A background run can't ask anyone for approval: anything its mode doesn't allow is denied (listed in permission_denials); tell the user what was denied. ` +
    `A desktop chat that already exists keeps its own mode.`,
};
const where = {
  type: "string",
  enum: ["desktop", "background"],
  description:
    `Where Claude does the work (default ${defaultWhere}). Decide per request; the default is headless because it is faster and doesn't depend on the relay. ` +
    `"background": a headless Claude Code run. Use it for code, config and repo work, smaller changes and fixes, and anything that doesn't need the desktop app. ` +
    `"desktop": a full Claude desktop app chat with the app's own tools. Choose it deliberately when the work needs the app's built-in browser, front-end or UI work that should be checked visually, or other app-only tools; it is slower (setup and relay), the app must be running, and anything needing approval waits for the user in the app. ` +
    `Either way the chat ends up in the desktop app's sidebar for the user to review.`,
};

const tools = {
  list_projects: {
    description: "List the projects on this machine (name and folder), most recently used first. Pass a project name to start_session; omit it to use the default project for general chats.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const all = [...projects()].map(([name, folder]) => ({ name, folder, sessions: 0, last_used: null }));
      const byFolder = new Map(all.map((p) => [norm(p.folder), p]));
      for (const s of sessionFiles()) {
        let cwd;
        try {
          cwd = sessionMeta(s).cwd;
        } catch {
          continue;
        }
        const p = cwd && byFolder.get(norm(cwd));
        if (!p) continue;
        p.sessions++;
        p.last_used ??= new Date(s.mtimeMs).toISOString(); // files come newest first
      }
      all.sort((a, b) => (b.last_used ?? "").localeCompare(a.last_used ?? "") || a.name.localeCompare(b.name));
      return { default_project: defaultProject, projects: all };
    },
  },

  list_sessions: {
    description:
      "List recent chats (Claude Code sessions) on this machine, newest first: title, folder, last prompt, whether it is a Claude desktop app chat, and whether the desktop app (or a terminal) has it loaded right now. " +
      "Any of them can be continued with send_message; for a chat the desktop app has loaded, the app does the work.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max sessions to return (default 15)." },
        query: { type: "string", description: "Only sessions whose title, folder or last prompt contains this text." },
        include_archived: { type: "boolean", description: "Include chats archived in the desktop app (default false)." },
      },
      additionalProperties: false,
    },
    async run({ limit = 15, query, include_archived = false } = {}) {
      const live = liveSessions();
      const desktop = desktopChats();
      const q = query?.toLowerCase();
      const out = [];
      for (const s of sessionFiles()) {
        if (out.length >= limit) break;
        const d = desktop.get(s.sessionId);
        if (d?.archived && !include_archived) continue;
        let meta;
        try {
          meta = sessionMeta(s);
        } catch {
          continue;
        }
        if (!meta.cwd || !isAllowedDir(meta.cwd)) continue;
        if (d?.title) meta.title = d.title;
        if (q && ![meta.title, meta.cwd, meta.last_prompt].some((v) => v?.toLowerCase().includes(q))) continue;
        out.push({ ...meta, ...chatState(s.sessionId, live, desktop) });
      }
      return out;
    },
  },

  start_session: {
    description:
      "Start a new chat on this machine in a project and give it a first message. Returns the session_id and, if it finishes within wait_seconds, Claude's reply. " +
      "Runs headless by default, in auto mode; pass where: \"desktop\" when the work needs the desktop app (its browser, visual checks of front-end work). Either way the chat lands in the desktop app's sidebar.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The first message for the new chat." },
        project: { type: "string", description: "Project name from list_projects. Omit for the default project (general chats)." },
        title: {
          type: "string",
          description: "A short title (3-6 words) that says what this request is about. It names the chat in the desktop app's sidebar and shows as the sender of the prompt. Defaults to the start of the prompt.",
        },
        model: { type: "string", description: "Optional model alias, e.g. opus, sonnet. A desktop chat defaults to the model of the user's latest desktop chat." },
        where,
        permission_mode,
        wait_seconds,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run({ prompt, project, title, model, where: target = defaultWhere, permission_mode: mode, wait_seconds: wait }) {
      if (!prompt?.trim()) throw new Error("prompt is empty");
      if (mode !== undefined && !permissionModes.includes(mode)) throw new Error(`permission_mode must be one of ${permissionModes.join(", ")}`);
      const { name, dir } = resolveProject(project);
      const sessionId = randomUUID();
      const chatTitle = title?.trim() || prompt.trim().split("\n")[0].slice(0, 60);

      if (target !== "desktop") {
        const run = startRun({ sessionId, cwd: dir, prompt, resume: false, permissionMode: mode ?? defaultPermissionMode, model, title: chatTitle });
        await waitFor(run, wait);
        return { project: name, ...runView(run) };
      }

      // Desktop chat: a short setup turn creates the session, the app loads it, then the real
      // prompt is relayed so the app itself does the work. The app adopts the setup turn's settings.
      // All of it runs in the background, so the session_id comes back within wait_seconds.
      const app = desktopDefaults();
      const prepare = async () => {
        const setup = startRun({
          sessionId,
          cwd: dir,
          prompt: SETUP_PROMPT,
          resume: false,
          permissionMode: mode ?? defaultPermissionMode,
          model: model ?? app.model,
          effort: model ? undefined : app.effort,
          title: chatTitle,
          track: false,
        });
        await setup.done;
        if (setup.status !== "done") throw new Error(`Setting up the chat failed: ${setup.stderr.trim() || setup.status}`);
        await ensureLoadedInDesktop(sessionId);
      };
      const run = startDesktopRun({ sessionId, cwd: dir, message: prompt, label: chatTitle, prepare });
      await waitFor(run, wait);
      return { project: name, title: chatTitle, ...runView(run) };
    },
  },

  open_in_desktop: {
    description:
      "Open a chat in the Claude desktop app on this machine, for the user to continue there. A chat the app doesn't know yet is added to its sidebar under its project. " +
      "Use it when the user wants to see or continue the chat themselves; send_message and start_session with where: \"desktop\" open chats in the app on their own.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
    async run({ session_id }) {
      if (!/^[0-9a-f-]{36}$/i.test(session_id)) throw new Error("session_id must be a session UUID");
      if (runs.get(session_id)?.status === "running") throw new Error("This session is still working. Wait for it to finish first.");
      const s = findSessionFile(session_id);
      if (!s) throw new Error(`No session ${session_id} on ${machine}`);
      const { cwd } = sessionMeta(s);
      if (!cwd || !isAllowedDir(cwd)) throw new Error(`Session folder ${cwd} is outside the allowed roots`);
      const existing = desktopChats().get(session_id);
      // Open the app's own chat when it has one; importing it again could add a duplicate.
      openUrl(existing ? existing.link : `claude://resume?session=${session_id}`);
      return {
        session_id,
        opened: true,
        note: existing ? `Opened the desktop chat "${existing.title ?? session_id}".` : "Added to the Claude desktop app's sidebar and opened.",
      };
    },
  },

  send_message: {
    description:
      "Continue an existing chat on this machine (session_id from list_sessions) with a new message and get the reply. The exchange is saved to the chat. " +
      "A chat the desktop app (or a terminal) already has loaded always gets the message there, and the app does the work. Otherwise where picks: \"desktop\" opens the chat in the app first, \"background\" runs it headless. " +
      "fork: true continues a copy of the chat as a new session in the background instead.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
        label: {
          type: "string",
          description: "A short name (3-6 words) for this request. A desktop chat shows it as the message's sender. Defaults to the start of the message.",
        },
        where,
        model: { type: "string", description: "Optional model alias for background runs." },
        permission_mode,
        wait_seconds,
        fork: {
          type: "boolean",
          description:
            "Continue a copy of the chat as a new session (new session_id in the result), in the background. It shows up in the desktop app as its own chat. " +
            "A fork must be merged back eventually: when its work is done, send the original chat a summary of what the fork did and where (send_message to the original session_id).",
        },
      },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
    async run({ session_id, message, label, where: target = defaultWhere, model, permission_mode: mode = defaultPermissionMode, wait_seconds: wait, fork = false }) {
      if (!message?.trim()) throw new Error("message is empty");
      if (!permissionModes.includes(mode)) throw new Error(`permission_mode must be one of ${permissionModes.join(", ")}`);
      if (runs.get(session_id)?.status === "running") {
        throw new Error("This session is still working on a previous message. Use get_session to wait for it, or stop_session_run.");
      }
      const s = findSessionFile(session_id);
      if (!s) throw new Error(`No session ${session_id} on ${machine}`);
      const { cwd } = sessionMeta(s);
      if (!cwd || !isAllowedDir(cwd)) throw new Error(`Session folder ${cwd} is outside the allowed roots`);
      if (fork) {
        const run = startRun({ sessionId: randomUUID(), forkFrom: session_id, cwd, prompt: message, permissionMode: mode, model });
        await waitFor(run, wait);
        return { forked_from: session_id, ...runView(run) };
      }
      if (liveSessions().get(session_id) || target === "desktop") {
        const run = startDesktopRun({
          sessionId: session_id,
          cwd,
          message,
          label: label?.trim() || undefined,
          prepare: () => ensureLoadedInDesktop(session_id),
        });
        await waitFor(run, wait);
        return runView(run);
      }
      const run = startRun({ sessionId: session_id, cwd, prompt: message, resume: true, permissionMode: mode, model });
      await waitFor(run, wait);
      return runView(run);
    },
  },

  get_session: {
    description: "Read a chat: its most recent messages, whether it is loaded in the desktop app, and the status of any reply this connector is running in it. Use wait_seconds to wait for a running reply.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        last_n: { type: "integer", minimum: 1, maximum: 50, description: "How many recent messages to return (default 6)." },
        wait_seconds: { ...wait_seconds, description: "Wait up to this long for a running reply to finish (default 0)." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async run({ session_id, last_n = 6, wait_seconds: wait = 0 }) {
      const run = runs.get(session_id);
      if (run) await waitFor(run, wait);
      const s = findSessionFile(session_id);
      if (!s && !run) throw new Error(`No session ${session_id} on ${machine}`);
      const meta = s ? sessionMeta(s) : null;
      if (meta?.cwd && !isAllowedDir(meta.cwd)) throw new Error(`Session folder ${meta.cwd} is outside the allowed roots`);
      const desktop = desktopChats();
      const title = desktop.get(session_id)?.title;
      const { connector_run, ...state } = chatState(session_id, liveSessions(), desktop);
      const messages = s ? await readMessages(s.file) : [];
      // Relayed messages don't update the transcript's last-prompt record.
      const lastUser = messages.findLast((m) => m.role === "user")?.text;
      return {
        ...(meta ?? { session_id }),
        ...(title ? { title } : {}),
        ...(lastUser ? { last_prompt: truncate(lastUser, 300) } : {}),
        ...state,
        connector_run: run ? runView(run) : null,
        messages: messages.slice(-last_n),
      };
    },
  },

  stop_session_run: {
    description: "Stop a reply this connector is running in a session (started by start_session or send_message).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
    async run({ session_id }) {
      const run = runs.get(session_id);
      if (run?.status !== "running") throw new Error("No running reply for that session.");
      if (run.ranIn === "desktop app") throw new Error("That reply is running in the Claude desktop app; stop it there.");
      run.stopped = true;
      if (process.platform === "win32") {
        // Kill the whole tree; claude may have spawned shells and tools.
        try {
          execFileSync("taskkill", ["/pid", String(run.child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      } else {
        run.child.kill("SIGTERM");
      }
      await waitFor(run, 10);
      return runView(run);
    },
  },
};

function chatState(sessionId, live, desktop) {
  const l = live.get(sessionId);
  const d = desktop.get(sessionId);
  return {
    desktop_chat: d ? { title: d.title, archived: d.archived } : null,
    loaded_in_app: l ? `${l.entrypoint ?? "unknown"} (${l.status ?? "unknown"})` : null,
    connector_run: runs.get(sessionId)?.status ?? null,
  };
}

function openUrl(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function callTool(name, args) {
  const tool = tools[name];
  if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool "${name}" on ${machine}.` }] };
  try {
    const result = await tool.run(args ?? {});
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err.message ?? String(err) }] };
  }
}

// ---------- hub connection ----------

let claudeVersion = null;
try {
  claudeVersion = execFileSync(claudeCommand(), ["--version"], { encoding: "utf8", env: childEnv, windowsHide: true }).trim();
} catch (err) {
  log(`warning: could not run "${claudeCommand()} --version": ${err.message}`);
}

const hello = () => ({
  type: "hello",
  machine,
  tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
  info: { platform: process.platform, hostname: os.hostname(), claude: claudeVersion, agent: AGENT_VERSION, allowed_roots: allowedRoots },
});

let backoff = 1000;

function connect() {
  const url = hubUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/agent";
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${agentToken}` } });
  let lastPong = Date.now();
  let pinger;

  ws.onopen = () => {
    backoff = 1000;
    ws.send(JSON.stringify(hello()));
    pinger = setInterval(() => {
      if (Date.now() - lastPong > 75_000) return ws.close(4002, "pong timeout");
      ws.send('{"type":"ping"}');
    }, 25_000);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "pong") lastPong = Date.now();
    else if (msg.type === "welcome") log(`connected to hub as "${msg.machine}" with ${msg.tools} tools`);
    else if (msg.type === "error") log(`hub error: ${msg.error}`);
    else if (msg.type === "call") {
      log(`call ${msg.tool}`);
      const result = await callTool(msg.tool, msg.args);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "result", id: msg.id, ...result }));
    }
  };

  ws.onclose = (ev) => {
    clearInterval(pinger);
    if (ev.code === 4001) {
      // Another agent connected with the same machine name. Reconnecting would just kick it off
      // in turn, so the two would keep replacing each other.
      log(`another agent connected as "${machine}"; exiting. Give each machine a unique "machine" name.`);
      process.exit(2);
    }
    log(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  ws.onerror = () => {}; // onclose follows and handles reconnecting
}

log(`claude-interact agent ${AGENT_VERSION} for machine "${machine}", roots: ${allowedRoots.join(", ")}`);
connect();
