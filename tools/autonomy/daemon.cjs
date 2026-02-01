#!/usr/bin/env node
/*
  Clawdbot Autonomy Daemon
  - Receives webhooks (Slack/GitHub/NocoDB)
  - Watches _codex
  - Runs optional poll commands for Gmail/Calendar
  - Queues events and invokes `clawdbot agent`

  No external deps; Node >=18 recommended.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULTS = {
  server: {
    port: 18790,
    basePath: '/hooks',
  },
  clawdbot: {
    sessionId: 'bb-autonomy-main',
    agentId: '',
    timeoutSeconds: 55,
    reply: {
      channel: 'line',
      target: '',
    },
  },
  queue: {
    maxPending: 200,
    dedupeTtlMs: 60 * 60 * 1000,
    lineCooldownMs: 0,
  },
  sources: {
    slack: { enabled: true, signingSecretEnv: 'SLACK_SIGNING_SECRET' },
    github: { enabled: true, secretEnv: 'GITHUB_WEBHOOK_SECRET' },
    nocodb: { enabled: true, secretEnv: 'NOCODB_WEBHOOK_SECRET' },
    codex: {
      enabled: true,
      path: path.resolve(__dirname, '../../shared/_codex'),
      debounceMs: 5000,
      ignore: ['.git', 'node_modules'],
    },
    gmail: {
      enabled: true,
      poll: {
        intervalMs: 120000,
        command: '',
      },
    },
    gcal: {
      enabled: true,
      poll: {
        intervalMs: 180000,
        command: '',
      },
    },
  },
};

function resolveStateDir() {
  const override = (process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || '').trim();
  if (override) {
    if (override.startsWith('~')) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(override);
  }
  const home = os.homedir();
  const newDir = path.join(home, '.openclaw');
  if (fs.existsSync(newDir)) return newDir;
  const legacyDirs = [path.join(home, '.clawdbot'), path.join(home, '.moltbot'), path.join(home, '.moldbot')];
  const existing = legacyDirs.find((dir) => fs.existsSync(dir));
  return existing || newDir;
}

const LINE_ACTIVITY_PATH = path.join(resolveStateDir(), 'line-activity.json');

function readLineActivity() {
  try {
    const raw = fs.readFileSync(LINE_ACTIVITY_PATH, 'utf8');
    return JSON.parse(raw || '{}') || {};
  } catch (_) {
    return {};
  }
}

function getLastLineInboundAt(activity) {
  if (!activity || typeof activity !== 'object') return 0;
  if (typeof activity.lastInboundAt === 'number') return activity.lastInboundAt;
  const accounts = activity.accounts || {};
  let max = 0;
  for (const entry of Object.values(accounts)) {
    if (entry && typeof entry.lastInboundAt === 'number') {
      max = Math.max(max, entry.lastInboundAt);
    }
  }
  return max;
}

function deepMerge(base, override) {
  if (!override) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  const configPath = process.env.AUTONOMY_CONFIG
    ? path.resolve(process.env.AUTONOMY_CONFIG)
    : path.resolve(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { config: DEFAULTS, configPath };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return { config: deepMerge(DEFAULTS, parsed), configPath };
}

function nowIso() {
  return new Date().toISOString();
}

function logLine(line) {
  const msg = `[${nowIso()}] ${line}`;
  console.log(msg);
  const logPath = path.resolve(__dirname, 'events.log');
  try {
    fs.appendFileSync(logPath, msg + '\n');
  } catch (_) {
    // ignore
  }
}

function jsonl(obj) {
  return JSON.stringify(obj);
}

function writeEventLog(event) {
  const logPath = path.resolve(__dirname, 'events.jsonl');
  try {
    fs.appendFileSync(logPath, jsonl(event) + '\n');
  } catch (_) {
    // ignore
  }
}

function hashPayload(payload) {
  const h = crypto.createHash('sha256');
  h.update(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return h.digest('hex');
}

const queue = [];
const seen = new Map();
let running = false;
const pollState = new Map();

function dedupeKey(event) {
  if (event.dedupeId) return `${event.source}:${event.dedupeId}`;
  return `${event.source}:${hashPayload(event.payload || event.summary || '')}`;
}

function cleanupSeen(ttlMs) {
  const cutoff = Date.now() - ttlMs;
  for (const [key, ts] of seen.entries()) {
    if (ts < cutoff) seen.delete(key);
  }
}

function enqueue(event, config) {
  const ttl = config.queue.dedupeTtlMs;
  cleanupSeen(ttl);
  const key = dedupeKey(event);
  if (seen.has(key)) return;
  seen.set(key, Date.now());
  if (queue.length >= config.queue.maxPending) {
    logLine(`queue full; dropping event ${event.source}`);
    return;
  }
  queue.push(event);
  writeEventLog(event);
  processQueue(config);
}

function buildPrompt(event, config) {
  const header = `# autonomy event\nsource: ${event.source}\ntype: ${event.type || 'event'}\ntime: ${event.time || nowIso()}\n`;
  const summary = event.summary ? `summary: ${event.summary}\n` : '';
  const payloadText = event.payload ? `payload:\n${truncate(JSON.stringify(event.payload, null, 2), 12000)}\n` : '';
  const instructions = [
    'instructions:',
    '- You are running in autonomous mode for Keigo (Sato).',
    '- You may read/write files and run commands as needed.',
    '- Persist durable memory to shared/_codex when useful.',
    '- Reply with a concise status update for LINE.',
  ].join('\n');
  return `${header}${summary}${payloadText}${instructions}`;
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...(${text.length - max} chars truncated)`;
}

function runClawdbot(event, config) {
  return new Promise((resolve) => {
    const msg = buildPrompt(event, config);
    const args = ['agent', '--message', msg, '--timeout', String(config.clawdbot.timeoutSeconds)];
    if (config.clawdbot.sessionId) args.push('--session-id', config.clawdbot.sessionId);
    if (config.clawdbot.agentId) args.push('--agent', config.clawdbot.agentId);

    if (config.clawdbot.reply && config.clawdbot.reply.target) {
      args.push('--deliver', '--reply-channel', config.clawdbot.reply.channel, '--reply-to', config.clawdbot.reply.target);
    }

    const child = spawn('clawdbot', args, {
      env: { ...process.env, CLAWDBOT_CLI_TOOLS_DISABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        logLine(`clawdbot ok (${event.source})`);
      } else {
        logLine(`clawdbot error (${event.source}) code=${code} stderr=${truncate(stderr, 800)}`);
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function processQueue(config) {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  const lineCooldownMs = Number(config.queue?.lineCooldownMs ?? 0);
  if (
    lineCooldownMs > 0 &&
    config.clawdbot?.reply?.channel === 'line'
  ) {
    const activity = readLineActivity();
    const lastInboundAt = getLastLineInboundAt(activity);
    const now = Date.now();
    if (lastInboundAt && now - lastInboundAt < lineCooldownMs) {
      const deferMs = Math.max(1000, lineCooldownMs - (now - lastInboundAt));
      queue.unshift(next);
      setTimeout(() => processQueue(config), deferMs);
      return;
    }
  }
  running = true;
  try {
    await runClawdbot(next, config);
  } finally {
    running = false;
    processQueue(config);
  }
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    cb(raw.toString('utf8'), raw);
  });
}

function verifySlackSignature(signingSecret, rawBody, ts, sig) {
  if (!signingSecret || !ts || !sig) return false;
  const base = `v0:${ts}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (_) {
    return false;
  }
}

function verifyGitHubSignature(secret, rawBody, sig256) {
  if (!secret || !sig256) return false;
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = `sha256=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig256));
  } catch (_) {
    return false;
  }
}

function ok(res, body = 'ok') {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end(body);
}

function bad(res, body = 'bad request') {
  res.statusCode = 400;
  res.setHeader('content-type', 'text/plain');
  res.end(body);
}

function unauthorized(res, body = 'unauthorized') {
  res.statusCode = 401;
  res.setHeader('content-type', 'text/plain');
  res.end(body);
}

function routeHandlers(config) {
  const base = config.server.basePath.replace(/\/$/, '');
  return {
    [`${base}/slack`]: (req, res) => {
      readBody(req, (raw, rawBuf) => {
        const secret = process.env[config.sources.slack.signingSecretEnv] || '';
        if (secret) {
          const ts = req.headers['x-slack-request-timestamp'];
          const sig = req.headers['x-slack-signature'];
          if (!verifySlackSignature(secret, raw, ts, sig)) {
            return unauthorized(res, 'invalid slack signature');
          }
        }
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (_) {
          return bad(res, 'invalid json');
        }
        if (payload.type === 'url_verification') {
          res.setHeader('content-type', 'text/plain');
          res.end(payload.challenge || '');
          return;
        }
        if (payload.event) {
          const ev = payload.event;
          const summary = ev.text ? ev.text.slice(0, 200) : `${ev.type || 'event'}`;
          enqueue({
            source: 'slack',
            type: ev.type || payload.type,
            time: nowIso(),
            summary,
            payload: {
              team_id: payload.team_id,
              api_app_id: payload.api_app_id,
              event_id: payload.event_id,
              event_time: payload.event_time,
              event: ev,
            },
            dedupeId: payload.event_id,
          }, config);
        }
        ok(res);
      });
    },
    [`${base}/github`]: (req, res) => {
      readBody(req, (raw, rawBuf) => {
        const secret = process.env[config.sources.github.secretEnv] || '';
        if (secret) {
          const sig = req.headers['x-hub-signature-256'];
          if (!verifyGitHubSignature(secret, rawBuf, sig)) {
            return unauthorized(res, 'invalid github signature');
          }
        }
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (_) {
          return bad(res, 'invalid json');
        }
        const event = req.headers['x-github-event'] || 'event';
        if (event === 'ping') {
          return ok(res, 'pong');
        }
        const summary = `${event}${payload.action ? `:${payload.action}` : ''}`;
        enqueue({
          source: 'github',
          type: event,
          time: nowIso(),
          summary,
          payload,
          dedupeId: req.headers['x-github-delivery'],
        }, config);
        ok(res);
      });
    },
    [`${base}/nocodb`]: (req, res) => {
      readBody(req, (raw) => {
        const secret = process.env[config.sources.nocodb.secretEnv] || '';
        if (secret) {
          const headerSecret = req.headers['x-nocodb-webhook-secret'] || req.headers['x-webhook-secret'];
          if (headerSecret !== secret) {
            return unauthorized(res, 'invalid nocodb secret');
          }
        }
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (_) {
          return bad(res, 'invalid json');
        }
        const summary = payload.type || payload.action || 'nocodb';
        enqueue({
          source: 'nocodb',
          type: payload.type || 'event',
          time: nowIso(),
          summary,
          payload,
          dedupeId: payload.id || payload.eventId,
        }, config);
        ok(res);
      });
    },
  };
}

function startServer(config) {
  const handlers = routeHandlers(config);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') return bad(res, 'POST only');
    const url = req.url.split('?')[0];
    const handler = handlers[url];
    if (!handler) return bad(res, 'unknown endpoint');
    handler(req, res);
  });
  server.listen(config.server.port, () => {
    logLine(`autonomy server listening on :${config.server.port}`);
    logLine(`endpoints: ${Object.keys(handlers).join(', ')}`);
  });
}

function startCodexWatcher(config) {
  const src = config.sources.codex;
  if (!src.enabled) return;
  const target = process.env.CODEX_PATH ? path.resolve(process.env.CODEX_PATH) : src.path;
  if (!fs.existsSync(target)) {
    logLine(`codex path not found: ${target}`);
    return;
  }
  let timer = null;
  const changed = new Set();
  const ignore = new Set(src.ignore || []);

  function flush() {
    timer = null;
    if (changed.size === 0) return;
    const files = Array.from(changed).slice(0, 50);
    changed.clear();
    enqueue({
      source: 'codex',
      type: 'fswatch',
      time: nowIso(),
      summary: `changed files: ${files.length}`,
      payload: { files },
    }, config);
  }

  const watcher = fs.watch(target, { recursive: true }, (_, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.some((p) => ignore.has(p))) return;
    changed.add(filename);
    if (!timer) timer = setTimeout(flush, src.debounceMs || 5000);
  });

  watcher.on('error', (err) => {
    logLine(`codex watch error: ${err.message}`);
  });

  logLine(`codex watcher active: ${target}`);
}

function runCommand(command) {
  return new Promise((resolve) => {
    if (!command) return resolve({ code: 0, stdout: '', stderr: '' });
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startPolling(config, key, label) {
  const src = config.sources[key];
  if (!src || !src.enabled) return;
  const poll = src.poll || {};
  const commands = buildPollCommands(poll);
  if (commands.length === 0) {
    logLine(`${label} poll disabled (no command)`);
    return;
  }
  logLine(`${label} poll commands: ${commands.length}`);
  logLine(`${label} poll sample: ${commands[0]}`);
  async function tick() {
    const changed = [];
    for (const cmd of commands) {
      const { code, stdout, stderr } = await runCommand(cmd);
      if (code !== 0) {
        logLine(`${label} poll error code=${code} stderr=${truncate(stderr, 400)}`);
        continue;
      }
      const out = stdout.trim();
      if (!out) continue;
      const hash = hashPayload(out);
      const stateKey = `${label}:${cmd}`;
      const prev = pollState.get(stateKey);
      if (prev && prev.hash === hash) {
        continue; // no change
      }
      pollState.set(stateKey, { hash, at: Date.now() });
      let payload = out;
      try {
        payload = JSON.parse(out);
      } catch (_) {
        // keep as text
      }
      changed.push({
        command: cmd,
        account: extractAccount(cmd),
        output: payload,
      });
    }
    if (changed.length === 0) return;
    enqueue(
      {
        source: label,
        type: 'poll',
        time: nowIso(),
        summary: `poll update (${label}) ${changed.length} account(s)`,
        payload: { items: changed },
      },
      config,
    );
  }
  tick();
  setInterval(tick, poll.intervalMs);
  logLine(`${label} polling every ${poll.intervalMs}ms`);
}

function main() {
  const { config, configPath } = loadConfig();
  logLine(`config: ${configPath}`);
  if (!config.clawdbot.reply.target) {
    logLine('warning: LINE target not set; replies will be suppressed');
  }
  startServer(config);
  startCodexWatcher(config);
  startPolling(config, 'gmail', 'gmail');
  startPolling(config, 'gcal', 'gcal');
}

main();

function buildPollCommands(poll) {
  if (!poll) return [];
  if (Array.isArray(poll.commands) && poll.commands.length > 0) {
    return poll.commands.filter(Boolean);
  }
  if (Array.isArray(poll.accounts) && poll.accounts.length > 0 && poll.commandTemplate) {
    return poll.accounts
      .map((account) => poll.commandTemplate.replace(/\{\{account\}\}/g, account))
      .filter(Boolean);
  }
  if (poll.command) return [poll.command];
  return [];
}

function extractAccount(cmd) {
  const match = cmd.match(/GOG_ACCOUNT=([^\\s]+)/);
  return match ? match[1] : undefined;
}
