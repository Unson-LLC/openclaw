# Clawdbot Autonomy Daemon

Autonomous event router for Clawdbot.

- Receives webhooks: Slack / GitHub / NocoDB
- Watches `_codex`
- Optional polling for Gmail + Google Calendar
- Queues events and invokes `clawdbot agent` with LINE replies

## 1) Configure

Copy the example config and edit your LINE user id + tokens.

```bash
cp tools/clawdbot-autonomy/config.example.json tools/clawdbot-autonomy/config.json
```

Set the LINE reply target (your LINE user id):

```json
"reply": { "channel": "line", "target": "Uxxxxxxxx..." }
```

Optional env secrets for webhook verification:

- `SLACK_SIGNING_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `NOCODB_WEBHOOK_SECRET`

## 2) Start the daemon

```bash
node tools/clawdbot-autonomy/daemon.js
```

It will log endpoints, for example:

```
endpoints: /hooks/slack, /hooks/github, /hooks/nocodb
```

## 3) Cloudflare Tunnel routing

Point Cloudflare to the local daemon port (default 18790). Example host:

- `hooks.mana-bot.win` → `http://127.0.0.1:18790`

Then set webhook URLs like:

- Slack: `https://hooks.mana-bot.win/hooks/slack`
- GitHub: `https://hooks.mana-bot.win/hooks/github`
- NocoDB: `https://hooks.mana-bot.win/hooks/nocodb`

## 4) Gmail / Google Calendar (polling)

This daemon supports **poll commands**. Provide any command that prints JSON to stdout.

Example placeholders (replace with your preferred CLI):

```json
"gmail": { "enabled": true, "poll": { "intervalMs": 120000, "command": "gog gmail watch --json" } },
"gcal":  { "enabled": true, "poll": { "intervalMs": 180000, "command": "gog calendar watch --json" } }
```

If `command` is empty, polling is disabled.

Notes:
- Polling is **change-only** by default: identical outputs are skipped to reduce noise.

### Multiple accounts (auto-switch)

You can have the daemon **rotate across multiple gog accounts** by using
`accounts + commandTemplate` or `commands`:

```json
"gmail": {
  "enabled": true,
  "poll": {
    "intervalMs": 120000,
    "accounts": ["a@example.com", "b@example.com"],
    "commandTemplate": "GOG_ACCOUNT={{account}} gog gmail search 'is:unread newer_than:2d' --max 20 --json"
  }
}
```

Or specify explicit commands:

```json
"commands": [
  "GOG_ACCOUNT=a@example.com gog gmail search 'is:unread newer_than:2d' --max 20 --json",
  "GOG_ACCOUNT=b@example.com gog gmail search 'is:unread newer_than:2d' --max 20 --json"
]
```

## 5) _codex watcher

The daemon watches `_codex` and sends a batched event on changes.

Configure path in `sources.codex.path` or set `CODEX_PATH` env.

## Notes

- To avoid session conflicts, this daemon processes events **sequentially**.
- If LINE delivery fails, check the Clawdbot gateway status and session health.
- Clawdbot CLI tools are force-enabled for the agent via env: `CLAWDBOT_CLI_TOOLS_DISABLED=0`.

Logs are written to:

- `tools/clawdbot-autonomy/events.log`
- `tools/clawdbot-autonomy/events.jsonl`
