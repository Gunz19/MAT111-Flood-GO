// Tests for the AI proxy with a mocked Gemini API. Run: npm test (inside worker/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";

const ORIGIN = "https://gunz19.github.io";
const KEY = "test-key-not-real";

function env(extra = {}) {
  return { ALLOWED_ORIGINS: ORIGIN + ", http://localhost:8080", GEMINI_API_KEY: KEY, RATE_LIMITER: { limit: async () => ({ success: true }) }, ...extra };
}
function req(body, { origin = ORIGIN, method = "POST", type = "application/json", path = "/api/ask", ip = "1.2.3.4" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (type) headers["Content-Type"] = type;
  return new Request("https://floodgo-ai.example.workers.dev" + path, {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
  });
}
function gemini(status, payload) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  fn.calls = calls;
  return fn;
}
const ok = { candidates: [{ content: { parts: [{ text: "เตรียมยาและไฟฉาย" }] }, finishReason: "STOP" }] };

test("preflight from allowed origin returns CORS headers", async () => {
  const res = await handle(req(null, { method: "OPTIONS" }), env());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("unknown origin is rejected without CORS headers", async () => {
  const res = await handle(req({ question: "x" }, { origin: "https://evil.example" }), env(), { fetch: gemini(200, ok) });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("other paths and methods are refused", async () => {
  assert.equal((await handle(req({ question: "x" }, { path: "/" }), env())).status, 404);
  assert.equal((await handle(req(null, { method: "GET" }), env())).status, 405);
  assert.equal((await handle(req("q=1", { type: "text/plain" }), env())).status, 415);
});

test("missing key reports ai_not_configured", async () => {
  const res = await handle(req({ question: "ต้องเตรียมอะไร" }), env({ GEMINI_API_KEY: "" }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "ai_not_configured");
});

test("request validation", async () => {
  const f = gemini(200, ok);
  assert.equal((await handle(req("{bad"), env(), { fetch: f })).status, 400);
  assert.equal((await handle(req("null"), env(), { fetch: f })).status, 400);
  assert.equal((await handle(req({ question: "   " }), env(), { fetch: f })).status, 400);
  assert.equal((await handle(req({ question: "ก".repeat(501) }), env(), { fetch: f })).status, 400);
  assert.equal((await handle(req({ question: "a", context: "x".repeat(5000) }), env(), { fetch: f })).status, 413);
  assert.equal(f.calls.length, 0);
});

test("success: key goes in a header, never the URL, and answer is returned", async () => {
  const f = gemini(200, ok);
  const res = await handle(req({ question: "ต้องเตรียมอะไร", context: "ฝน 2.0 มม." }), env({ GEMINI_MODEL: "gemini-3.5-flash-lite" }), { fetch: f });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: "เตรียมยาและไฟฉาย" });
  const call = f.calls[0];
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  assert.ok(!call.url.includes(KEY));
  assert.equal(call.init.headers["x-goog-api-key"], KEY);
  const sent = JSON.parse(call.init.body);
  assert.match(sent.systemInstruction.parts[0].text, /1784/);
  assert.match(sent.contents[0].parts[0].text, /ต้องเตรียมอะไร/);
  assert.match(sent.contents[0].parts[0].text, /ฝน 2\.0 มม\./);
});

test("thought parts are dropped from the answer", async () => {
  const f = gemini(200, { candidates: [{ content: { parts: [{ text: "คิด...", thought: true }, { text: "คำตอบ" }] } }] });
  const res = await handle(req({ question: "a" }), env(), { fetch: f });
  assert.equal((await res.json()).answer, "คำตอบ");
});

test("Gemini errors map to stable codes", async () => {
  const cases = [
    [429, 503, "ai_quota"],
    [403, 502, "ai_auth"],
    [401, 502, "ai_auth"],
    [404, 502, "ai_model_unavailable"],
    [400, 502, "ai_bad_request"],
    [500, 502, "ai_upstream"],
    [503, 502, "ai_upstream"]
  ];
  for (const [upstream, status, code] of cases) {
    const res = await handle(req({ question: "a" }), env(), { fetch: gemini(upstream, { error: { message: "x" } }) });
    assert.equal(res.status, status, "upstream " + upstream);
    assert.equal((await res.json()).error, code);
  }
});

test("invalid key (real Gemini shape: 400 API_KEY_INVALID) maps to ai_auth", async () => {
  const body = { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID", domain: "googleapis.com" }] } };
  const res = await handle(req({ question: "a" }), env(), { fetch: gemini(400, body) });
  assert.equal((await res.json()).error, "ai_auth");
});

test("malformed, empty and blocked responses", async () => {
  let res = await handle(req({ question: "a" }), env(), { fetch: gemini(200, "<html>") });
  assert.equal((await res.json()).error, "ai_bad_response");
  res = await handle(req({ question: "a" }), env(), { fetch: gemini(200, { candidates: [] }) });
  assert.equal((await res.json()).error, "ai_bad_response");
  res = await handle(req({ question: "a" }), env(), { fetch: gemini(200, { promptFeedback: { blockReason: "SAFETY" } }) });
  assert.equal(res.status, 422);
  res = await handle(req({ question: "a" }), env(), { fetch: gemini(200, { candidates: [{ finishReason: "SAFETY" }] }) });
  assert.equal((await res.json()).error, "ai_blocked");
});

test("timeout and network failure", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let res = await handle(req({ question: "a" }), env(), { fetch: hang, timeoutMs: 20 });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error, "ai_timeout");
  res = await handle(req({ question: "a" }), env(), { fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(res.status, 502);
});

test("rate limit binding blocks with 429", async () => {
  const res = await handle(req({ question: "a" }), env({ RATE_LIMITER: { limit: async () => ({ success: false }) } }), { fetch: gemini(200, ok) });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("fallback in-memory limiter allows N per minute", async () => {
  let t = 1_000_000;
  const e = env({ RATE_LIMITER: undefined, RATE_LIMIT_PER_MINUTE: "3" });
  const deps = { fetch: gemini(200, ok), now: () => t };
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await handle(req({ question: "a" }, { ip: "9.9.9.9" }), e, deps)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  t += 61000;
  assert.equal((await handle(req({ question: "a" }, { ip: "9.9.9.9" }), e, deps)).status, 200);
});

test("logs never contain the key or the question", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await handle(req({ question: "คำถามส่วนตัว" }), env(), { fetch: gemini(403, {}) });
    await handle(req({ question: "คำถามส่วนตัว" }), env(), { fetch: gemini(200, "x") });
  } finally {
    console.log = orig;
  }
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(!l.includes(KEY));
    assert.ok(!l.includes("คำถามส่วนตัว"));
  }
});
