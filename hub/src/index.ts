// claude-interact hub: one remote MCP connector (for Claude Duet / claude.ai) that fans out
// to machine agents connected over WebSocket. Each agent registers its own tools; the hub
// exposes them as `<machine>__<tool>`.

import { DurableObject } from "cloudflare:workers";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  MCP_API_KEY: string;
  AGENT_TOKEN: string;
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface MachineRecord {
  machine: string;
  tools: ToolDef[];
  info: Record<string, unknown>;
  lastSeen: number;
}

interface ToolResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
}

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const SERVER_NAME = "claude-interact-hub";
const SERVER_VERSION = "0.5.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MACHINE_NAME_RE = /^[A-Za-z0-9-]{1,24}$/;
const SEP = "__";
// Upper bound on how long the hub waits for an agent to answer a tool call. Agent tools that
// can run long (Claude sessions) take their own wait_seconds and return early with a status.
const CALL_TIMEOUT_MS = 150_000;
// Machines offline longer than this are forgotten (tools and all); an agent re-registers on reconnect.
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
// Claude Code cloud session ids (claude.ai/code). Agents send one a notice when a run ends.
const CLOUD_SESSION_RE = /^(session|cse)_[A-Za-z0-9]{8,64}$/;
const NOTIFY_KEY = "notify:session";

const INSTRUCTIONS = `This connector reaches the user's own computers ("machines"). Each machine runs an agent that
registers tools, exposed here as <machine>${SEP}<tool>. Call list_machines first to see which machines
are online and what they can do. If a machine's tools are missing from your tool list (it registered
after you connected), use run_machine_tool with the machine and tool name instead.

How the user wants these tools used:
- You convey; the session on the machine does the thinking. You don't have the machine's files, the project's
  history or the session's tools, so don't design the solution yourself. Give the session the user's request
  in their own words (you may frame and tidy it), what you have observed (results, errors, how the user
  reacted), and what it needs to know about you: what you are, what you can and can't see, and how its reply
  reaches you and the user. Leave the approach, the design and the decisions to the session. Add ideas of
  your own only when the user asks you to, and mark them as suggestions.
- Wait for a notice instead of polling. Pass your own Claude Code session id (session_...) as notify_session
  on start_session and send_message, or call set_notify_session once when your session starts. When a run
  ends and you haven't seen its result yet (it finished, failed, or stopped to ask for something), the
  machine sends a short notice into your session, which wakes you; then read the reply with get_session.
  The connector notifies the latest id it was given, so a session that takes over your chat registers its
  own id the same way. Use wait_seconds on the call that starts a run, and after that don't call get_session
  over and over while you wait.
- Decide where each chat runs. Headless ("background") is the default because it is faster and doesn't
  depend on the relay: use it for code, config and repo work, smaller changes and fixes. Choose "desktop"
  (a full Claude desktop app chat) deliberately when the work needs the app's built-in browser, front-end
  or UI work that should be verified visually, or other app-only tools. A message to a chat the desktop app
  already has open always goes there.
- Every run uses auto mode: leave permission_mode unset unless the user asks for another mode. A background
  run can't ask for approval, so tell the user about anything that was denied (permission_denials).
- All work ends up in the desktop app so the user can review it afterwards: background and forked runs are
  added to the app's sidebar when they finish. Forks are fine, but merge them back: when a fork's work is done,
  send the original chat a summary of what it did.
- When the user gives you a standing rule about how to use these tools, default to suggesting it as a change
  to this connector (its tools or these instructions) rather than saving it to your own memory.`;

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// Connector clients send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`.
function apiKeyFrom(request: Request): string | null {
  return request.headers.get("X-API-Key") ?? request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

async function safeEqual(a: string | null | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "agent") {
      const auth = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!(await safeEqual(auth, env.AGENT_TOKEN))) return new Response("unauthorized", { status: 401 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.HUB.getByName("hub").fetch(request);
    }

    if (url.pathname === "/mcp") {
      if (!(await safeEqual(apiKeyFrom(request), env.MCP_API_KEY))) return new Response("unauthorized", { status: 401 });
      return env.HUB.getByName("hub").fetch(request);
    }

    if (url.pathname === "/") return new Response(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export class Hub extends DurableObject<Env> {
  // In-flight tool calls awaiting an agent's result. Only lives while an MCP request is open,
  // so it never needs to survive hibernation.
  private pending = new Map<string, { ws: WebSocket; resolve: (r: ToolResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer keepalive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/agent") return this.acceptAgent();
    return this.handleMcp(request);
  }

  // ---------- agents ----------

  private acceptAgent(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // The agent identifies itself with a hello message; until then it has no machine tag.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const machine = String(msg.machine ?? "");
      if (!MACHINE_NAME_RE.test(machine)) {
        ws.send(JSON.stringify({ type: "error", error: `machine name must match ${MACHINE_NAME_RE}` }));
        ws.close(4000, "bad machine name");
        return;
      }
      const tools: ToolDef[] = Array.isArray(msg.tools) ? msg.tools.filter((t: any) => t && typeof t.name === "string") : [];
      // A reconnecting agent replaces its older socket.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && this.machineOf(other) === machine) other.close(4001, "replaced by newer connection");
      }
      ws.serializeAttachment({ machine });
      const record: MachineRecord = { machine, tools, info: msg.info ?? {}, lastSeen: Date.now() };
      await this.ctx.storage.put(`machine:${machine}`, record);
      const notify = (await this.ctx.storage.get<string>(NOTIFY_KEY)) ?? null;
      ws.send(JSON.stringify({ type: "welcome", machine, tools: tools.length, notify_session: notify }));
      return;
    }

    // Lets agent scripts remove a leftover registration, e.g. after a test agent.
    if (msg.type === "forget") {
      const r = await this.forgetMachine(msg.machine);
      ws.send(JSON.stringify({ type: "forgot", ok: !r.isError, text: r.content[0].text }));
      return;
    }

    if (msg.type === "result" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
      p.resolve({ content, ...(msg.isError ? { isError: true } : {}) });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const machine = this.machineOf(ws);
    if (!machine) return;
    // Fail calls that were waiting on this socket instead of letting them time out.
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(textResult(`Machine "${machine}" disconnected before answering.`, true));
    }
    const record = await this.ctx.storage.get<MachineRecord>(`machine:${machine}`);
    if (record) await this.ctx.storage.put(`machine:${machine}`, { ...record, lastSeen: Date.now() });
  }

  private machineOf(ws: WebSocket): string | undefined {
    return (ws.deserializeAttachment() as { machine?: string } | null)?.machine;
  }

  private socketFor(machine: string): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => this.machineOf(ws) === machine && ws.readyState === WebSocket.OPEN);
  }

  private async machines(): Promise<MachineRecord[]> {
    const map = await this.ctx.storage.list<MachineRecord>({ prefix: "machine:" });
    const now = Date.now();
    const stale = [...map.values()].filter((m) => now - m.lastSeen > STALE_MS && !this.socketFor(m.machine));
    if (stale.length) await this.ctx.storage.delete(stale.map((m) => `machine:${m.machine}`));
    return [...map.values()].filter((m) => !stale.includes(m)).sort((a, b) => a.machine.localeCompare(b.machine));
  }

  private async forgetMachine(machine: unknown): Promise<ToolResult> {
    if (typeof machine !== "string") return textResult("forget_machine needs machine.", true);
    if (this.socketFor(machine)) return textResult(`Machine "${machine}" is online; stop its agent first.`, true);
    if (!(await this.ctx.storage.delete(`machine:${machine}`))) return textResult(`No machine "${machine}".`, true);
    return textResult(`Forgot machine "${machine}".`);
  }

  // The cloud session agents notify when a run ends. Every agent gets the latest one, so a run
  // started by an earlier session of the same chat still reaches the session that took over.
  private async setNotifySession(id: unknown): Promise<ToolResult> {
    if (id === undefined) {
      const current = await this.ctx.storage.get<string>(NOTIFY_KEY);
      return textResult(current ? `Runs notify ${current}.` : "No session is registered for notices.");
    }
    if (id === "none") {
      await this.ctx.storage.delete(NOTIFY_KEY);
      this.broadcast({ type: "notify-session", notify_session: null });
      return textResult("Cleared. Runs send no notices until a session registers again.");
    }
    if (typeof id !== "string" || !CLOUD_SESSION_RE.test(id)) {
      return textResult('session_id must be a Claude Code cloud session id (session_... or cse_...), or "none".', true);
    }
    if ((await this.ctx.storage.get<string>(NOTIFY_KEY)) !== id) {
      await this.ctx.storage.put(NOTIFY_KEY, id);
      this.broadcast({ type: "notify-session", notify_session: id });
    }
    return textResult(`Runs on every machine notify ${id} when they end before you've seen the result.`);
  }

  // A notify_session passed to any machine tool also registers it.
  private async noteNotifySession(args: any): Promise<void> {
    const id = args?.notify_session;
    if (typeof id === "string" && CLOUD_SESSION_RE.test(id)) await this.setNotifySession(id);
  }

  private broadcast(msg: object): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.machineOf(ws) && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private callAgent(machine: string, tool: string, args: unknown): Promise<ToolResult> {
    const ws = this.socketFor(machine);
    if (!ws) return Promise.resolve(textResult(`Machine "${machine}" is offline.`, true));
    const id = crypto.randomUUID();
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(textResult(`Timed out after ${CALL_TIMEOUT_MS / 1000}s waiting for "${machine}".`, true));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { ws, resolve, timer });
      ws.send(JSON.stringify({ type: "call", id, tool, args: args ?? {} }));
    });
  }

  // ---------- MCP (streamable HTTP, stateless, JSON responses) ----------

  private async handleMcp(request: Request): Promise<Response> {
    if (request.method === "GET") return new Response("SSE stream not supported", { status: 405, headers: { Allow: "POST" } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }

    const batch = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(batch.map((m) => this.dispatch(m)))).filter((r) => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  }

  private async dispatch(msg: JsonRpcRequest): Promise<object | null> {
    // Notifications (no id) get no response.
    if (msg.id === undefined || msg.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: await this.listTools() });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string") return fail(-32602, "missing tool name");
        return ok(await this.callTool(name, msg.params?.arguments ?? {}));
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  private async listTools(): Promise<ToolDef[]> {
    const tools: ToolDef[] = [
      {
        name: "list_machines",
        description: "List the user's machines connected to this connector: online status, platform, and the tools each one offers.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "run_machine_tool",
        description:
          "Call any tool on a machine by name. Use this when a machine's tools are not in your tool list (for example it connected after you did). Get tool names and argument schemas from list_machines.",
        inputSchema: {
          type: "object",
          properties: {
            machine: { type: "string", description: "Machine name from list_machines." },
            tool: { type: "string", description: "Tool name on that machine (without the machine prefix)." },
            arguments: { type: "object", description: "Arguments for the tool, per its inputSchema." },
          },
          required: ["machine", "tool"],
          additionalProperties: false,
        },
      },
      {
        name: "forget_machine",
        description:
          "Remove an offline machine and its tools from this connector (for example a test agent). Machines offline for 3 days are forgotten on their own; a forgotten machine re-registers if its agent connects again.",
        inputSchema: {
          type: "object",
          properties: { machine: { type: "string", description: "Machine name from list_machines." } },
          required: ["machine"],
          additionalProperties: false,
        },
      },
      {
        name: "set_notify_session",
        description:
          "Register your own Claude Code session id (session_...) so runs on the user's machines send you a notice when they end, instead of you polling get_session. " +
          "Passing notify_session to start_session or send_message does the same. Register when your session starts: your id changes when a new session takes over your chat, and the latest id registered is the one notified. " +
          'Omit session_id to see the registered id; pass "none" to stop notices.',
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string", description: 'Your current session id (session_...), or "none".' } },
          additionalProperties: false,
        },
      },
    ];
    for (const m of await this.machines()) {
      for (const t of m.tools) {
        tools.push({
          name: `${m.machine}${SEP}${t.name}`.slice(0, 64),
          description: `[machine: ${m.machine}] ${t.description ?? ""}`.trim(),
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    return tools;
  }

  private async callTool(name: string, args: any): Promise<ToolResult> {
    if (name === "list_machines") {
      const list = (await this.machines()).map((m) => ({
        machine: m.machine,
        online: !!this.socketFor(m.machine),
        lastSeen: new Date(m.lastSeen).toISOString(),
        info: m.info,
        tools: m.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
      return textResult(list.length ? JSON.stringify(list, null, 2) : "No machines have connected yet.");
    }

    if (name === "run_machine_tool") {
      if (typeof args?.machine !== "string" || typeof args?.tool !== "string") {
        return textResult("run_machine_tool needs machine and tool.", true);
      }
      await this.noteNotifySession(args.arguments);
      return this.callAgent(args.machine, args.tool, args.arguments ?? {});
    }

    if (name === "forget_machine") return this.forgetMachine(args?.machine);
    if (name === "set_notify_session") return this.setNotifySession(args?.session_id);

    const i = name.indexOf(SEP);
    if (i <= 0) return textResult(`Unknown tool "${name}".`, true);
    await this.noteNotifySession(args);
    return this.callAgent(name.slice(0, i), name.slice(i + SEP.length), args);
  }
}
