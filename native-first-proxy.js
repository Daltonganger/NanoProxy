"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const LISTEN_HOST = process.env.PROXY_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.PROXY_PORT || "8787");
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || "30000") || 30000);
const DIRECT_UPSTREAM_BASE_URL = process.env.DIRECT_UPSTREAM_BASE_URL || process.env.UPSTREAM_BASE_URL || "https://nano-gpt.com/api/v1";
const INTERNAL_PROXY_HOST = process.env.INTERNAL_PROXY_HOST || "127.0.0.1";
const INTERNAL_PROXY_PORT = Number(process.env.INTERNAL_PROXY_PORT || "8788");
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || `http://${INTERNAL_PROXY_HOST}:${INTERNAL_PROXY_PORT}`;
const BRIDGE_HEALTH_URL = `${BRIDGE_BASE_URL.replace(/\/+$/, "")}/health`;

function now() {
  return new Date().toISOString();
}

function log(requestId, message) {
  console.log(`[native-first ${now()}]${requestId ? ` ${requestId}` : ""} ${message}`);
}

function buildTargetUrl(base, requestPath) {
  const trimmedBase = String(base || "").replace(/\/+$/, "");
  const trimmedPath = String(requestPath || "").replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function buildForwardHeaders(reqHeaders, bodyLength) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    if (String(key).toLowerCase() === "host") continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  if (bodyLength !== undefined) headers.set("content-length", String(bodyLength));
  return headers;
}

function copyResponseHeaders(fromHeaders, res, bodyLength, extraHeaders = {}) {
  fromHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-length") return;
    if (lower === "transfer-encoding") return;
    if (lower === "content-encoding") return;
    res.setHeader(key, value);
  });
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value !== undefined) res.setHeader(key, value);
  }
  if (bodyLength !== undefined) res.setHeader("content-length", String(bodyLength));
}

function isSuccessfulStatus(status) {
  return status >= 200 && status < 300;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function contentPartsToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

function looksLikeBridgeText(text) {
  return /\[\[\s*\/?\s*OPENCODE_(TOOL|FINAL)\s*\]\]/i.test(text)
    || /\[\[\s*\/?\s*CALL\s*\]\]/i.test(text);
}

function looksLikeToolPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  const parsed = tryParseJson(trimmed);
  if (!parsed.ok) return false;
  const value = parsed.value;
  if (Array.isArray(value?.tool_calls) && value.tool_calls.length > 0) return true;
  if (value && typeof value === "object" && typeof value.name === "string" && Object.prototype.hasOwnProperty.call(value, "arguments")) return true;
  return false;
}

function shouldFallbackFromNativeText(text, finishReason) {
  const content = contentPartsToText(text).trim();
  if (finishReason === "tool_calls") return true;
  if (!content) return true;
  if (looksLikeBridgeText(content)) return true;
  if (looksLikeToolPayload(content)) return true;
  return false;
}

function acceptNativeJson(status, payload) {
  if (!isSuccessfulStatus(status)) return false;
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  if (!choice) return false;
  const message = choice?.message && typeof choice.message === "object" ? choice.message : {};
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return !shouldFallbackFromNativeText(message.content, choice?.finish_reason ?? null);
}

function applyChunkToAggregate(aggregate, payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  if (!choice || typeof choice !== "object") return;
  const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : {};
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) aggregate.nativeToolCallsSeen = true;
  if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) aggregate.nativeToolCallsSeen = true;
  if (delta.content !== undefined) aggregate.content += contentPartsToText(delta.content);
  if (choice?.message?.content !== undefined) aggregate.content += contentPartsToText(choice.message.content);
  if (choice?.finish_reason !== undefined && choice.finish_reason !== null) aggregate.finishReason = choice.finish_reason;
}

function parseSSEAggregate(streamText) {
  const aggregate = { content: "", finishReason: null, nativeToolCallsSeen: false };
  const events = String(streamText || "").split(/\n\n+/);
  for (const eventText of events) {
    const data = eventText
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    const parsed = tryParseJson(data);
    if (!parsed.ok) continue;
    applyChunkToAggregate(aggregate, parsed.value);
  }
  return aggregate;
}

function acceptNativeSSE(status, streamText) {
  if (!isSuccessfulStatus(status)) return false;
  const aggregate = parseSSEAggregate(streamText);
  if (aggregate.nativeToolCallsSeen) return true;
  return !shouldFallbackFromNativeText(aggregate.content, aggregate.finishReason);
}

function requestNeedsNativeFirst(body) {
  return !!(body && typeof body === "object" && Array.isArray(body.tools) && body.tools.length > 0);
}

async function startFetch(url, options) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

async function relayFetchResponse(response, res, extraHeaders = {}) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") && response.body) {
    copyResponseHeaders(response.headers, res, undefined, extraHeaders);
    res.writeHead(response.status);
    for await (const chunk of response.body) {
      res.write(Buffer.from(chunk));
    }
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  copyResponseHeaders(response.headers, res, buffer.length, extraHeaders);
  res.writeHead(response.status);
  res.end(buffer);
}

function sendBufferedTextResponse(response, res, text, extraHeaders = {}) {
  const buffer = Buffer.from(text, "utf8");
  copyResponseHeaders(response.headers, res, buffer.length, extraHeaders);
  res.writeHead(response.status);
  res.end(buffer);
}

function sendError(res, status, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

async function handleHealth(req, res) {
  let bridgeOk = false;
  try {
    const response = await startFetch(BRIDGE_HEALTH_URL, { method: "GET" });
    bridgeOk = response.ok;
  } catch {}

  const payload = JSON.stringify({
    ok: bridgeOk,
    mode: "native-first-overlay",
    directUpstream: DIRECT_UPSTREAM_BASE_URL,
    bridgeBaseUrl: BRIDGE_BASE_URL
  });

  res.statusCode = bridgeOk ? 200 : 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  if (req.method !== "HEAD") res.end(payload);
  else res.end();
}

async function proxyRequest(req, res) {
  const requestId = randomUUID().slice(0, 8);
  const bodyBuffer = await readRequestBody(req);
  const bodyText = bodyBuffer.toString("utf8");
  const isJson = (req.headers["content-type"] || "").includes("application/json") && bodyText.length > 0;
  const parsed = isJson ? tryParseJson(bodyText) : { ok: false };
  const directUrl = buildTargetUrl(DIRECT_UPSTREAM_BASE_URL, req.url);
  const bridgeUrl = buildTargetUrl(BRIDGE_BASE_URL, req.url);

  const forward = (url) => startFetch(url, {
    method: req.method,
    headers: buildForwardHeaders(req.headers, bodyBuffer.length),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuffer
  });

  if (!parsed.ok || !requestNeedsNativeFirst(parsed.value)) {
    log(requestId, `passthrough ${req.method} ${req.url}`);
    const response = await forward(directUrl);
    return relayFetchResponse(response, res, { "x-nanoproxy-strategy": "direct" });
  }

  log(requestId, `native-first ${req.method} ${req.url}`);

  try {
    const directResponse = await forward(directUrl);
    const contentType = directResponse.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      const streamText = await directResponse.text();
      if (acceptNativeSSE(directResponse.status, streamText)) {
        log(requestId, `native accepted stream status=${directResponse.status}`);
        return sendBufferedTextResponse(directResponse, res, streamText, { "x-nanoproxy-strategy": "native-accepted" });
      }
      log(requestId, `fallback to bridge after native stream status=${directResponse.status}`);
      const bridgeResponse = await forward(bridgeUrl);
      return relayFetchResponse(bridgeResponse, res, { "x-nanoproxy-strategy": "native-first-bridge-fallback" });
    }

    if (contentType.includes("application/json")) {
      const jsonText = await directResponse.text();
      const parsedJson = tryParseJson(jsonText);
      if (parsedJson.ok && acceptNativeJson(directResponse.status, parsedJson.value)) {
        log(requestId, `native accepted json status=${directResponse.status}`);
        return sendBufferedTextResponse(directResponse, res, jsonText, { "x-nanoproxy-strategy": "native-accepted" });
      }
      log(requestId, `fallback to bridge after native json status=${directResponse.status}`);
      const bridgeResponse = await forward(bridgeUrl);
      return relayFetchResponse(bridgeResponse, res, { "x-nanoproxy-strategy": "native-first-bridge-fallback" });
    }

    if (isSuccessfulStatus(directResponse.status)) {
      log(requestId, `native accepted raw status=${directResponse.status}`);
      return relayFetchResponse(directResponse, res, { "x-nanoproxy-strategy": "native-accepted" });
    }

    log(requestId, `fallback to bridge after native raw status=${directResponse.status}`);
    const bridgeResponse = await forward(bridgeUrl);
    return relayFetchResponse(bridgeResponse, res, { "x-nanoproxy-strategy": "native-first-bridge-fallback" });
  } catch (error) {
    log(requestId, `native error -> bridge fallback: ${error instanceof Error ? error.message : String(error)}`);
    try {
      const bridgeResponse = await forward(bridgeUrl);
      return relayFetchResponse(bridgeResponse, res, { "x-nanoproxy-strategy": "native-first-bridge-fallback" });
    } catch (bridgeError) {
      return sendError(res, 502, {
        error: {
          message: `Native and bridge upstream failed: ${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`,
          type: "bad_gateway",
          code: null
        }
      });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if ((req.method === "GET" || req.method === "HEAD") && req.url === "/health") {
      await handleHealth(req, res);
      return;
    }
    await proxyRequest(req, res);
  } catch (error) {
    sendError(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "internal_error",
        code: null
      }
    });
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(null, `listening on http://${LISTEN_HOST}:${LISTEN_PORT} direct=${DIRECT_UPSTREAM_BASE_URL} bridge=${BRIDGE_BASE_URL}`);
});
