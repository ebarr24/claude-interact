# claude-interact

One connector that lets Claude Duet (or any claude.ai chat) start and message Claude Code sessions on your own machines.

```
Claude Duet ──MCP over HTTPS──▶ hub (Cloudflare Worker + Durable Object)
                                  ▲            ▲
                         WebSocket│            │WebSocket (outbound, no open ports)
                           agent (desktop)   agent (laptop) ...
                              │
                         claude -p / --resume
```

- **hub/** is the connector you add in Claude. It holds a WebSocket from each machine and exposes each machine's tools as `<machine>__<tool>`, plus `list_machines`, `run_machine_tool` (for machines that connected after Duet loaded its tool list) and `forget_machine` (removes an offline machine, such as a test agent; an agent-token socket can send `{"type":"forget","machine":...}` for the same thing). Machines offline for 3 days are dropped on their own and re-register when their agent reconnects.
- **agent/** runs on each machine. Single file, no dependencies, Node 22+. Each agent declares its own tools, so different machines can offer different tools through the same connector.

## Tools each agent offers today

| Tool | What it does |
|---|---|
| `list_projects` | Projects by name (discovered under `projectDirs`, plus `projects` from config), most recently used first |
| `list_sessions` | Recent chats: title (the desktop app's title when it has one), folder, last prompt, whether it's a desktop chat, whether an app has it loaded; skips archived desktop chats |
| `start_session` | New chat in a project (default project if omitted) with a first message; waits up to `wait_seconds` for the reply. `where` picks a desktop chat or a background run |
| `send_message` | Next message to an existing chat. A chat the desktop app has loaded gets it there; otherwise `where` decides. `fork: true` continues a copy in the background |
| `get_session` | Recent messages + status of a reply still running; can wait for it |
| `stop_session_run` | Kill a background reply the connector started |
| `open_in_desktop` | Open a chat in the Claude desktop app (adding it to the sidebar if the app doesn't know it yet) |

### Where the work runs

Every run the connector starts or continues uses **auto mode** unless the call names another `permission_mode`. A desktop chat that already exists keeps its own mode; nothing outside the app can change it.

When the desktop app adds a chat to its sidebar, it takes the mode of the last prompt in the final 256 KB of the transcript. If no prompt falls in that window, which is common after a long background run, it uses `permissions.defaultMode` from your Claude settings, or manual mode if that isn't set. Set `"permissions": { "defaultMode": "auto" }` in `~/.claude/settings.json` so those chats open in auto too. The agent warns at startup when that setting isn't `auto`, and a run's result includes `desktop_mode` when the app opened its chat in a mode other than auto.

- **`background`** (the default): a headless `claude -p` run on the machine, saved to the chat. Faster, and doesn't depend on the relay. No desktop-only tools. When it finishes, the chat (or fork) is added to the desktop app's sidebar so every connector run can be reviewed there; this opens the app on that chat.
- **`desktop`** (chosen deliberately): the chat is a full Claude desktop app chat, with the app's own tools such as the built-in browser. A message to a chat the app already has loaded always goes here.
  - New chats: a one-line setup turn creates the session, the agent opens it in the app, and the real prompt is relayed in. The app adopts the setup turn's model and permission mode, so the agent uses the model and effort of your most recent chat made in the app (override with `desktopDefaults`, or `model` per call) and auto mode.
  - Existing chats: the message is relayed into the chat, loading it in the app first if needed.
  - The relay is Claude Code's cross-session messaging, sent by a short Haiku run (`ListAgents` + `SendMessage`). The chat sees the message as coming from another Claude session named "Duet: <label>": the `title` for new chats, the `label` for `send_message`, or the start of the message.
  - Delivery is confirmed from the chat's transcript, so a relay run that ends without reporting still counts when the message arrived.

The tool descriptions and the hub's server instructions tell Duet to decide per request: background for code, config and repo work and smaller fixes; desktop when the work needs the app's browser, visual checks of front-end work, or other app-only tools. They also tell Duet to merge forks back with a summary, and to suggest standing rules as changes to this connector rather than saving them to its own memory.

Both use the desktop app's bundled CLI (`%APPDATA%\Claude\claude-code\<version>`) when it exists, so they stay current with the app; `claudeCommand` overrides that.

Tools return within 45 seconds (`wait_seconds` is capped there because claude.ai gives up on a tool call after 60). Longer work, including setting up a new desktop chat, keeps going: the result says `status: "running"` with the session_id, and Duet follows up with `get_session`.

## Setup

### 1. Deploy the hub (once)

```bash
cd hub
npm install
npx wrangler login
npx wrangler secret put MCP_API_KEY    # long random string; the connector sends it in a header
npx wrangler secret put AGENT_TOKEN    # long random string; agents use it to connect
npx wrangler deploy
```

Generate the secrets with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

### 2. Add the connector in Claude

Settings → Connectors → Add custom connector:

- URL: `https://duet.ethanbarr.net/mcp`
- Request header: `X-API-Key` = the `MCP_API_KEY` value (the hub also accepts `Authorization: Bearer <key>`)

Anyone with the key can drive your machines. Rotate it with `wrangler secret put MCP_API_KEY` and update the connector.

### 3. On each machine

Needs Node 22+ (24 tested) and, for desktop chats, the Claude desktop app signed in.

0. Clone the repo: `gh repo clone ebarr24/claude-interact` (private; sign in with `gh auth login` first). Only `agent/` is needed on a machine; `git pull` later picks up agent updates, then restart the agent.
1. Make sure the standalone `claude` CLI is signed in. The desktop app signs in separately, so check with `claude auth status`. For an always-on agent, `claude setup-token` creates a long-lived token; put it in the agent's environment as `CLAUDE_CODE_OAUTH_TOKEN`.
2. `cp agent/config.example.json agent/config.json` and edit:
   - `machine`: unique per machine (letters, digits, `-`, up to 24 chars). Two agents with the same name kick each other off, and the replaced one exits.
   - `allowedRoots`: only sessions and folders under these are listed or usable.
   - `projectDirs`: folders whose subfolders become projects when they look like code (git repo, `package.json`, Python files, `CLAUDE.md`, a Worker config, ...).
   - `projects` / `defaultProject`: extra named projects, and the one used when Duet doesn't name a project. The default project's folder is created when first used.
   - `permissionModes.allowed`: the modes a call may pick; must include `auto`, which every run defaults to. `bypassPermissions` is left out on purpose; add it only if you mean it.
   - Optional:
     - `claudeCommand`: the CLI for runs (default: the desktop app's bundled one, else `claude` on PATH).
     - `relayClaudeCommand`: the CLI for relaying (needs 2.1.234+ on Windows).
     - `defaultWhere`: `background` (default) or `desktop`.
     - `desktopDefaults`: `{ "model", "effort", "permissionMode" }` for new desktop chats.
     - `showRunsInDesktop`: add background and forked chats to the desktop app's sidebar when they finish (default `true`). They open in auto mode only if `permissions.defaultMode` is `auto` (see "Where the work runs").
     - `desktopSessionsDir`: where the desktop app keeps its chat records.
3. Run it: `node agent/agent.mjs` (or pass a config path as the first argument).
4. Keep it running across reboots. On Windows, `pwsh -File agent/install-windows.ps1` registers a hidden logon task that restarts on crash and logs to `agent/agent.log` (`-Uninstall` removes it). On macOS use a launchd agent, on Linux a systemd user unit.

## Local development

```bash
cd hub && printf 'MCP_API_KEY=dev\nAGENT_TOKEN=dev\n' > .dev.vars && npx wrangler dev
# agent config: "hubUrl": "http://127.0.0.1:8787", "agentToken": "dev"
```

## Limits worth knowing

- **Desktop runs need the app running and signed in.** Anything the chat's permission mode doesn't allow waits for you to approve it in the app; a relayed message can't approve it. New desktop chats start in auto mode; an older chat in `acceptEdits` waits for approval even to open a page in the built-in browser.
- **Relay timing.** A desktop chat that's mid-turn gets the message after its current turn. The connector tracks a desktop reply only while the agent is running; after a restart, `get_session` still shows the chat's messages.
- **Desktop chat records.** The agent reads the desktop app's per-chat records (`%APPDATA%\Claude\claude-code-sessions`) for titles, archived state, settings and links. That format is internal to the app; the agent skips records it can't read.
- **Headless permissions.** Nobody is there to approve tool use in background runs, so anything the permission mode doesn't allow is denied. Denied tools come back in `permission_denials`.
- **Connector auth** is a static API key in a header. claude.ai custom connectors also support OAuth ("sign in"), which would need a sign-in server in the hub.
