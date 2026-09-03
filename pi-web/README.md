# pi-web

Personal LAN web interface for [Pi](https://pi.dev). A local Node daemon serves the UI and supervises one `pi --mode rpc` process per active session. Pi processes continue running when browsers disconnect.

## Requirements

- Node.js 22.19 or newer
- `pi` installed and authenticated on the host
- Repositories available on the host filesystem

## Install

```bash
cd ~/d/p/toolsets/pi-web
npm install --ignore-scripts
```

## Run locally

```bash
npm start
# Open http://127.0.0.1:31415
```

Loopback mode does not require an access token.

## Run on the LAN

A token is mandatory whenever the server binds beyond loopback:

```bash
export PI_WEB_HOST=0.0.0.0
export PI_WEB_TOKEN="$(openssl rand -hex 24)"
npm start
```

Open `http://<host-lan-address>:31415` on another device and enter the token. Store the token in a password manager; browsers retain it in local storage.

For regular use, put the daemon behind Caddy with a locally trusted TLS certificate. Pi exposes shell and filesystem access, so do not expose this service directly to the internet.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_HOST` | `127.0.0.1` | HTTP listen address |
| `PI_WEB_PORT` | `31415` | HTTP listen port |
| `PI_WEB_TOKEN` | unset | WebSocket access token; required for non-loopback binds |
| `PI_WEB_PI_BIN` | `pi` | Pi executable |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | pi-web registry directory |
| `PI_WEB_SESSION_DIR` | `~/.pi/agent/sessions` | Native Pi session directory searched by the resume dialog |
| `PI_WEB_RPC_TIMEOUT_MS` | `600000` | RPC request timeout |

Pi's own credentials, settings, extensions, skills, and sessions remain under `~/.pi/agent` unless Pi is configured otherwise.

## Session behavior

- Creating a session starts a persistent Pi RPC process. The working-directory picker browses directories on the Pi host, including when the browser runs on another LAN device.
- Closing every browser leaves the process running.
- Reopening a managed session after daemon restart starts Pi with the original session file.
- **Find Pi Sessions** searches native Pi history by name, directory, session ID, model, and recent messages. Resuming adds the session to the Pi Web registry without rewriting its history.
- Trash controls in the managed-session list and native-session search stop Pi Web-managed runs and permanently remove their JSONL history after confirmation.
- **Hibernate** stops an idle process while retaining its session history.
- Project-local Pi resources are disabled unless **Trust project-local Pi resources** is selected when creating the session.
- Several devices may observe and control the same session. Commands are serialized by Pi; extension dialogs should be answered from one device only.

## Current MVP scope

Implemented:

- Managed persistent sessions and background execution
- Streaming text, thinking, and tool activity
- Prompt, steer, follow-up, and abort
- Model and thinking-level selection
- Manual compaction
- Extension select, confirm, input, editor, notification, status, widget, title, and editor-text requests
- Native Pi session search and resume
- Pasted, dropped, and selected image attachments
- Sanitized Markdown rendering for agent messages
- Responsive desktop/mobile UI

Not yet implemented:

- Session tree navigation, fork, clone, and export UI
- Automatic idle hibernation
- Rich unified diffs
- Durable recovery of an in-flight operation after the host or daemon process stops

## Development

```bash
npm run dev
npm run check
npm test
```

The browser uses only authoritative RPC snapshots and disposable streaming events. Session JSONL remains Pi's canonical history.
