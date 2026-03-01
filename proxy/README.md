# codexrouter

Simple proxy tools for PI:
- reverse relays for specific providers (Codex/Anthropic)
- a minimal forward proxy for all outbound PI traffic

## Included servers

- **Codex reverse relay** (`proxy-server.js`)
  - Listen: `0.0.0.0:8787`
  - Upstream: `https://chatgpt.com/backend-api`
  - Rewrites incoming path to `/backend-api/...`

- **Anthropic reverse relay** (`anthropic-proxy-server.js`)
  - Listen: `0.0.0.0:8788`
  - Upstream: `https://api.anthropic.com`
  - Pass-through path behavior (`/v1/...`)

- **Forward proxy** (`forward-proxy-server.js`)
  - Listen: `0.0.0.0:8789`
  - Supports plain HTTP proxying and HTTPS `CONNECT` tunneling

## Install

```bash
npm install
```

## Run

```bash
npm start                 # codex reverse relay
npm run start:anthropic   # anthropic reverse relay
npm run start:forward     # forward proxy
```

Health checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8788/healthz
curl http://127.0.0.1:8789/healthz
```

## Configure PI (reverse relay mode)

`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "http://127.0.0.1:8787"
    },
    "anthropic": {
      "baseUrl": "http://127.0.0.1:8788"
    }
  }
}
```

Then `/reload` in PI.

## Configure PI (forward proxy mode)

Set before launching PI:

```bash
export HTTPS_PROXY=http://dine.local:8789
export HTTP_PROXY=http://dine.local:8789
export NO_PROXY=127.0.0.1,localhost,.local
pi
```

Notes:
- With forward proxy mode, you usually **do not need** `models.json` baseUrl overrides.
- Forward proxy mode is what enables OAuth endpoints too (e.g. Anthropic login/token exchange).
- If PI runs on another machine, use reachable host/IP (e.g. `dine.local`).

## Environment variables

### Codex reverse relay
- `PORT` (default `8787`)
- `HOST` (default `0.0.0.0`)
- `TARGET_ORIGIN` (default `https://chatgpt.com`)
- `TARGET_PREFIX` (default `/backend-api`)

### Anthropic reverse relay
- `PORT` (default `8788`)
- `HOST` (default `0.0.0.0`)
- `TARGET_ORIGIN` (default `https://api.anthropic.com`)
- `TARGET_PREFIX` (default empty)

### Forward proxy
- `PORT` (default `8789`)
- `HOST` (default `0.0.0.0`)
