import type { WebhookRequestBody } from "@line/bot-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { danger, logVerbose } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLineBot } from "./bot.js";
import { validateLineSignature } from "./signature.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import {
  replyMessageLine,
  showLoadingAnimation,
  getUserDisplayName,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
  pushTextMessageWithQuickReplies,
  pushMessageLine,
  pushMessagesLine,
  createFlexMessage,
  createImageMessage,
  createLocationMessage,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { chunkMarkdownText } from "../auto-reply/chunk.js";
import { processLineMessage } from "./markdown-to-line.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import { appendHistoryEntry, buildHistoryContextFromMap } from "../auto-reply/reply/history.js";

export interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: (body: WebhookRequestBody) => Promise<void>;
  stop: () => void;
}

// Track runtime state in memory (simplified version)
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function resolveLineStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    if (override.startsWith("~")) {
      return path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

const LINE_ACTIVITY_PATH = path.join(resolveLineStateDir(), "line-activity.json");
const LINE_HISTORY_DIR = path.join(resolveLineStateDir(), "line-history");

function sanitizeLineHistoryKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function resolveLineHistoryPath(accountId: string, chatId: string): string {
  const safeAccount = sanitizeLineHistoryKey(accountId);
  const safeChat = sanitizeLineHistoryKey(chatId);
  return path.join(LINE_HISTORY_DIR, `${safeAccount}-${safeChat}.jsonl`);
}

async function loadLineHistoryFromDisk(params: {
  accountId: string;
  chatId: string;
  limit: number;
}): Promise<HistoryEntry[]> {
  const filePath = resolveLineHistoryPath(params.accountId, params.chatId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-params.limit);
    const entries = tail
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HistoryEntry => Boolean(entry && entry.body));
    return entries;
  } catch {
    return [];
  }
}

async function appendLineHistoryToDisk(params: {
  accountId: string;
  chatId: string;
  entry: HistoryEntry;
}): Promise<void> {
  const filePath = resolveLineHistoryPath(params.accountId, params.chatId);
  await fs.mkdir(LINE_HISTORY_DIR, { recursive: true });
  const payload = JSON.stringify(params.entry);
  await fs.appendFile(filePath, `${payload}\n`);
}

async function updateLineActivity(params: {
  accountId: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}): Promise<void> {
  const now = Date.now();
  let data: {
    updatedAt?: number;
    accounts?: Record<string, { lastInboundAt?: number; lastOutboundAt?: number }>;
  } = {};
  try {
    const raw = await fs.readFile(LINE_ACTIVITY_PATH, "utf-8");
    data = JSON.parse(raw) || {};
  } catch {
    data = {};
  }
  if (!data.accounts) {
    data.accounts = {};
  }
  const account = data.accounts[params.accountId] ?? {};
  if (typeof params.lastInboundAt === "number") {
    account.lastInboundAt = params.lastInboundAt;
  }
  if (typeof params.lastOutboundAt === "number") {
    account.lastOutboundAt = params.lastOutboundAt;
  }
  data.accounts[params.accountId] = account;
  data.updatedAt = now;
  await fs.mkdir(path.dirname(LINE_ACTIVITY_PATH), { recursive: true });
  await fs.writeFile(LINE_ACTIVITY_PATH, JSON.stringify(data));
}

// Track message history per chat (user or group)
// Key format: "line:{accountId}:{chatId}"
const messageHistory = new Map<string, HistoryEntry[]>();
const DEFAULT_HISTORY_LIMIT = 100;

async function ensureLineHistoryLoaded(params: {
  accountId: string;
  chatId: string;
  limit: number;
}): Promise<void> {
  const key = `line:${params.accountId}:${params.chatId}`;
  if (messageHistory.has(key)) {
    return;
  }
  const entries = await loadLineHistoryFromDisk({
    accountId: params.accountId,
    chatId: params.chatId,
    limit: params.limit,
  });
  if (entries.length > 0) {
    messageHistory.set(key, entries);
  }
}

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getLineRuntimeState(accountId: string) {
  return runtimeState.get(`line:${accountId}`);
}

/**
 * Get message history for a specific chat
 */
export function getLineMessageHistory(params: {
  accountId: string;
  chatId: string;
  limit?: number;
}): HistoryEntry[] {
  const key = `line:${params.accountId}:${params.chatId}`;
  const history = messageHistory.get(key) ?? [];
  const limit = params.limit ?? DEFAULT_HISTORY_LIMIT;
  return history.slice(-limit);
}

/**
 * Add a message to history
 */
function addToLineMessageHistory(params: {
  accountId: string;
  chatId: string;
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
}): void {
  const key = `line:${params.accountId}:${params.chatId}`;
  appendHistoryEntry({
    historyMap: messageHistory,
    historyKey: key,
    entry: {
      sender: params.sender,
      body: params.body,
      timestamp: params.timestamp ?? Date.now(),
      messageId: params.messageId,
    },
    limit: DEFAULT_HISTORY_LIMIT,
  });
  void appendLineHistoryToDisk({
    accountId: params.accountId,
    chatId: params.chatId,
    entry: {
      sender: params.sender,
      body: params.body,
      timestamp: params.timestamp,
      messageId: params.messageId,
    },
  }).catch(() => {});
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function startLineLoadingKeepalive(params: {
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) {
      return;
    }
    void showLoadingAnimation(params.userId, {
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export async function monitorLineProvider(
  opts: MonitorLineProviderOptions,
): Promise<LineProviderMonitor> {
  const {
    channelAccessToken,
    channelSecret,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? "default";

  // Record starting state
  recordChannelRuntimeState({
    channel: "line",
    accountId: resolvedAccountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // Create the bot
  const bot = createLineBot({
    channelAccessToken,
    channelSecret,
    accountId,
    runtime,
    config,
    onMessage: async (ctx) => {
      if (!ctx) {
        return;
      }

      const { ctxPayload, replyToken, route } = ctx;

      // Record inbound activity
      recordChannelRuntimeState({
        channel: "line",
        accountId: resolvedAccountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });
      void updateLineActivity({
        accountId: resolvedAccountId,
        lastInboundAt: Date.now(),
      }).catch(() => {});

      const userId = ctx.userId ?? ctxPayload.From;
      const shouldShowLoading = Boolean(userId && !ctx.isGroup);

      // Fetch display name for logging (non-blocking)
      const displayNamePromise = ctx.userId
        ? getUserDisplayName(ctx.userId, { accountId: ctx.accountId })
        : Promise.resolve(ctxPayload.From);

      // Show loading animation while processing (non-blocking, best-effort)
      const stopLoading =
        shouldShowLoading && userId
          ? startLineLoadingKeepalive({ userId, accountId: ctx.accountId })
          : null;

      const displayName = await displayNamePromise;
      logVerbose(`line: received message from ${displayName} (${ctxPayload.From})`);

      const historyKey = `line:${resolvedAccountId}:${ctxPayload.From}`;
      await ensureLineHistoryLoaded({
        accountId: resolvedAccountId,
        chatId: ctxPayload.From,
        limit: DEFAULT_HISTORY_LIMIT,
      });
      const inboundBody = ctxPayload.RawBody?.trim() ?? ctxPayload.Body?.trim() ?? "";
      const historyEntry = inboundBody
        ? {
            sender: displayName,
            body: inboundBody,
            timestamp: ctxPayload.Timestamp ?? Date.now(),
            messageId: ctxPayload.MessageSid,
          }
        : undefined;

      // Build context with message history for the AI (standard markers + append current entry)
      const bodyForAgent = buildHistoryContextFromMap({
        historyMap: messageHistory,
        historyKey,
        limit: DEFAULT_HISTORY_LIMIT,
        entry: historyEntry,
        currentMessage: ctxPayload.Body ?? inboundBody,
        formatEntry: (entry) => {
          const time = entry.timestamp
            ? new Date(entry.timestamp).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
            : "";
          const timeLabel = time ? `[${time}] ` : "";
          return `${timeLabel}${entry.sender}: ${entry.body}`;
        },
      });
      if (historyEntry) {
        void appendLineHistoryToDisk({
          accountId: resolvedAccountId,
          chatId: ctxPayload.From,
          entry: historyEntry,
        }).catch(() => {});
      }

      // Update context with history
      const contextWithHistory = {
        ...ctxPayload,
        BodyForAgent: bodyForAgent,
      };

      // Dispatch to auto-reply system for AI response
      let replyTokenUsed = false; // Track if we've used the one-time reply token
      try {
        const textLimit = 5000; // LINE max message length

        const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
          ctx: contextWithHistory,
          cfg: config,
          dispatcherOptions: {
            responsePrefix: resolveEffectiveMessagesConfig(config, route.agentId).responsePrefix,
            deliver: async (payload, _info) => {
              const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

              // Show loading animation before each delivery (non-blocking)
              if (shouldShowLoading && userId) {
                void showLoadingAnimation(userId, { accountId: ctx.accountId }).catch(() => {});
              }

              const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
                payload,
                lineData,
                to: ctxPayload.From,
                replyToken,
                replyTokenUsed,
                accountId: ctx.accountId,
                textLimit,
                deps: {
                  buildTemplateMessageFromPayload,
                  processLineMessage,
                  chunkMarkdownText,
                  sendLineReplyChunks,
                  replyMessageLine,
                  pushMessageLine,
                  pushTextMessageWithQuickReplies,
                  createQuickReplyItems,
                  createTextMessageWithQuickReplies,
                  pushMessagesLine,
                  createFlexMessage,
                  createImageMessage,
                  createLocationMessage,
                  onReplyError: (replyErr) => {
                    logVerbose(
                      `line: reply token failed, falling back to push: ${String(replyErr)}`,
                    );
                  },
                },
              });
              replyTokenUsed = nextReplyTokenUsed;

              // Save bot's reply to history
              if (payload.text?.trim()) {
                addToLineMessageHistory({
                  accountId: resolvedAccountId,
                  chatId: ctxPayload.From,
                  sender: "Assistant",
                  body: payload.text,
                  timestamp: Date.now(),
                });
              }

              recordChannelRuntimeState({
                channel: "line",
                accountId: resolvedAccountId,
                state: {
                  lastOutboundAt: Date.now(),
                },
              });
              void updateLineActivity({
                accountId: resolvedAccountId,
                lastOutboundAt: Date.now(),
              }).catch(() => {});
            },
            onError: (err, info) => {
              runtime.error?.(danger(`line ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {},
        });

        if (!queuedFinal) {
          logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
        }
      } catch (err) {
        runtime.error?.(danger(`line: auto-reply failed: ${String(err)}`));

        // Send error message to user
        if (replyToken && !replyTokenUsed) {
          try {
            await replyMessageLine(
              replyToken,
              [{ type: "text", text: "Sorry, I encountered an error processing your message." }],
              { accountId: ctx.accountId },
            );
            replyTokenUsed = true;
          } catch (replyErr) {
            runtime.error?.(danger(`line: error reply failed: ${String(replyErr)}`));
          }
        }
        if (!replyTokenUsed) {
          try {
            await pushMessageLine(
              ctxPayload.From,
              "Sorry, I encountered an error processing your message.",
              {
                accountId: ctx.accountId,
              },
            );
            replyTokenUsed = true;
          } catch (pushErr) {
            runtime.error?.(danger(`line: error push failed: ${String(pushErr)}`));
          }
        }
      } finally {
        stopLoading?.();
      }
    },
  });

  // Register HTTP webhook handler
  const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "line",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Handle GET requests for webhook verification
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("OK");
        return;
      }

      // Only accept POST requests
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        const signature = req.headers["x-line-signature"];

        // Validate signature
        if (!signature || typeof signature !== "string") {
          logVerbose("line: webhook missing X-Line-Signature header");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
          return;
        }

        if (!validateLineSignature(rawBody, signature, channelSecret)) {
          logVerbose("line: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        // Parse and process the webhook body
        const body = JSON.parse(rawBody) as WebhookRequestBody;

        // Respond immediately with 200 to avoid LINE timeout
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process events asynchronously
        if (body.events && body.events.length > 0) {
          logVerbose(`line: received ${body.events.length} webhook events`);
          await bot.handleWebhook(body).catch((err) => {
            runtime.error?.(danger(`line webhook handler failed: ${String(err)}`));
          });
        }
      } catch (err) {
        runtime.error?.(danger(`line webhook error: ${String(err)}`));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal
  const stopHandler = () => {
    logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    recordChannelRuntimeState({
      channel: "line",
      accountId: resolvedAccountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
