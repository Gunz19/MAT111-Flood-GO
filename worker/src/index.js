// Flood Go AI proxy (Cloudflare Worker).
// Keeps the Gemini API key on the server and answers short Thai flood questions for the website.
// Secrets: GEMINI_API_KEY (wrangler secret). Vars: ALLOWED_ORIGINS, GEMINI_MODEL, RATE_LIMIT_PER_MINUTE.

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_BODY_BYTES = 4096;
const MAX_QUESTION = 500;
const MAX_CONTEXT = 800;
const MAX_ANSWER = 2000;
const GEMINI_TIMEOUT_MS = 20000;

const SYSTEM_PROMPT = [
  "คุณคือผู้ช่วยเรื่องน้ำท่วมและการเดินทางในประเทศไทย",
  "ตอบเป็นภาษาไทยง่ายๆ สั้นๆ ไม่เกิน 5 ประโยค เหมาะกับผู้สูงอายุ",
  "ข้อมูลฝนที่ผู้ใช้แนบมาเป็นพยากรณ์ ไม่ใช่ระดับน้ำจริง",
  "ห้ามแต่งข้อมูลระดับน้ำ ถนนปิด หรือประกาศทางการ ถ้าไม่รู้ให้บอกว่าไม่รู้",
  "ห้ามบอกว่าถนนปลอดภัยเพียงเพราะพยากรณ์ฝนน้อย",
  "ถ้าเป็นเรื่องด่วนหรืออันตราย ให้แนะนำโทร 1784 (ปภ.) หรือ 1669 (เจ็บป่วยฉุกเฉิน) และติดตามประกาศจากหน่วยงานทางการ"
].join(" ");

// Best-effort per-isolate limiter, used only when the RATE_LIMITER binding is missing.
const memoryHits = new Map();

export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};

export async function handle(request, env, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = deps.timeoutMs || GEMINI_TIMEOUT_MS;
  const now = deps.now || Date.now;

  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cors = allowed.includes(origin) ? corsHeaders(origin) : null;

  if (url.pathname !== "/api/ask") return json({ error: "not_found" }, 404, cors);
  if (!cors) return json({ error: "origin_not_allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415, cors);
  }
  if (!env.GEMINI_API_KEY) return json({ error: "ai_not_configured" }, 503, cors);

  const client = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await allow(client, env, now))) {
    return json({ error: "rate_limited" }, 429, { ...cors, "Retry-After": "60" });
  }

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413, cors);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413, cors);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad_json" }, 400, cors);
  }
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question || question.length > MAX_QUESTION) return json({ error: "bad_question" }, 400, cors);
  const context = typeof body?.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT) : "";

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const userText = (context ? "ข้อมูลฝนพยากรณ์จากแอป: " + context + "\n\n" : "") + "คำถาม: " + question;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: { maxOutputTokens: 1024 }
        }),
        signal: ctrl.signal
      }
    );
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    log("gemini_fetch_failed", { reason: timedOut ? "timeout" : "network" });
    return json({ error: timedOut ? "ai_timeout" : "ai_upstream" }, timedOut ? 504 : 502, cors);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // A wrong key comes back as 400 with reason API_KEY_INVALID, not 401/403.
    const reasons = await res.json().then(
      (e) => (Array.isArray(e?.error?.details) ? e.error.details.map((d) => d?.reason).filter(Boolean) : []),
      () => []
    );
    log("gemini_http_error", { status: res.status, model, reasons });
    if (res.status === 429) return json({ error: "ai_quota" }, 503, { ...cors, "Retry-After": "60" });
    if (res.status === 401 || res.status === 403 || reasons.includes("API_KEY_INVALID")) return json({ error: "ai_auth" }, 502, cors);
    if (res.status === 404) return json({ error: "ai_model_unavailable" }, 502, cors);
    if (res.status === 400) return json({ error: "ai_bad_request" }, 502, cors);
    return json({ error: "ai_upstream" }, 502, cors);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    log("gemini_bad_response", { reason: "not_json" });
    return json({ error: "ai_bad_response" }, 502, cors);
  }
  if (data?.promptFeedback?.blockReason) return json({ error: "ai_blocked" }, 422, cors);
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const answer = parts
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!answer) {
    if (candidate && /SAFETY|BLOCKLIST|PROHIBITED/.test(candidate.finishReason || "")) {
      return json({ error: "ai_blocked" }, 422, cors);
    }
    log("gemini_bad_response", { reason: "empty", finishReason: candidate?.finishReason || null });
    return json({ error: "ai_bad_response" }, 502, cors);
  }
  return json({ answer: answer.slice(0, MAX_ANSWER) }, 200, cors);
}

async function allow(client, env, now) {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: client });
    return success;
  }
  const limit = Number(env.RATE_LIMIT_PER_MINUTE) || 10;
  const t = now();
  const hit = memoryHits.get(client);
  if (!hit || t - hit.start >= 60000) {
    memoryHits.set(client, { start: t, count: 1 });
    if (memoryHits.size > 5000) memoryHits.clear();
    return true;
  }
  hit.count++;
  return hit.count <= limit;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(headers || {}) }
  });
}

// Logs carry only event names and status codes: never the API key or the user's question.
function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
