/**
 * جَلّي — /api/analyze
 * Secure server-side proxy to the Anthropic Messages API.
 *
 * - The API key is read ONLY from process.env.ANTHROPIC_API_KEY (Vercel env var).
 * - The model is selected server-side via ANTHROPIC_MODEL (frontend cannot choose it).
 * - Contract text is never logged.
 * - Errors returned to the browser are generic, safe Arabic messages.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-5"; // supported fallback; override with ANTHROPIC_MODEL
const MAX_BODY_BYTES = 400_000;      // ~400 KB JSON request cap
const MAX_PROMPT_CHARS = 200_000;    // total prompt content cap
const MAX_TOKENS_LIMIT = 8_192;      // upper bound the server will allow
const UPSTREAM_TIMEOUT_MS = 120_000;

/* Best-effort in-memory rate limit. NOTE: serverless instances are ephemeral
   and horizontally scaled, so this is NOT a complete production solution —
   it only softens bursts on a warm instance. Use Vercel WAF / Upstash /
   a gateway limiter for real production rate limiting. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // memory guard
  return recent.length > RATE_MAX_REQUESTS;
}

const ERR = {
  method: "الطريقة غير مسموح بها.",
  contentType: "نوع المحتوى غير مدعوم؛ المطلوب JSON.",
  badJson: "تعذّرت قراءة الطلب: JSON غير صالح.",
  badRequest: "طلب غير صالح: الرسائل مفقودة أو فارغة.",
  tooLarge: "حجم الطلب يتجاوز الحد المسموح.",
  tooLong: "نص الطلب أطول من الحد المسموح؛ جرّب تقسيم العقد.",
  rateLimited: "تم تجاوز الحد المؤقت لطلبات التحليل. حاول مرة أخرى بعد قليل.",
  notConfigured: "خدمة التحليل غير مهيأة حاليًا. تأكد من إعداد مفتاح API في خادم Vercel.",
  upstreamAuth: "تعذّر التحقق من مفتاح خدمة الذكاء الاصطناعي. راجع إعدادات الخادم.",
  upstreamRate: "خدمة الذكاء الاصطناعي مشغولة حاليًا. حاول مرة أخرى بعد قليل.",
  upstreamModel: "نموذج الذكاء الاصطناعي المهيأ غير متاح. راجع إعداد ANTHROPIC_MODEL.",
  timeout: "استغرق التحليل وقتًا أطول من المتوقع وتم إيقاف الطلب.",
  upstream: "تعذّر إتمام تحليل الذكاء الاصطناعي. حاول مرة أخرى لاحقًا."
};

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(status).json(body);
}

async function readJsonBody(req) {
  // Vercel usually pre-parses JSON into req.body; handle both cases.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (req.body.length > MAX_BODY_BYTES) throw new Error("tooLarge");
      return JSON.parse(req.body);
    }
    return req.body;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("tooLarge");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = async function handler(req, res) {
  // Same-origin API: no CORS headers are added, so browsers on other origins
  // are blocked by default. Preflights are answered without permissive headers.
  if (req.method === "OPTIONS") return send(res, 405, { error: ERR.method });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: ERR.method });
  }

  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json")) return send(res, 415, { error: ERR.contentType });

  const declaredSize = Number(req.headers["content-length"] || 0);
  if (declaredSize > MAX_BODY_BYTES) return send(res, 413, { error: ERR.tooLarge });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return send(res, 429, { error: ERR.rateLimited });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[jalli-api] ANTHROPIC_API_KEY is not configured");
    return send(res, 503, { error: ERR.notConfigured });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return send(res, e.message === "tooLarge" ? 413 : 400, {
      error: e.message === "tooLarge" ? ERR.tooLarge : ERR.badJson
    });
  }

  // ---- validation (never trust the client) ----
  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return send(res, 400, { error: ERR.badRequest });
  let promptChars = 0;
  for (const m of messages) {
    if (!m || m.role !== "user" || typeof m.content !== "string" || !m.content.trim()) {
      return send(res, 400, { error: ERR.badRequest });
    }
    promptChars += m.content.length;
  }
  if (promptChars === 0) return send(res, 400, { error: ERR.badRequest });
  if (promptChars > MAX_PROMPT_CHARS) return send(res, 413, { error: ERR.tooLong });

  const maxTokens = Math.min(
    Math.max(parseInt(body.max_tokens, 10) || 4096, 256),
    MAX_TOKENS_LIMIT
  );
  const analysisId = typeof body.analysisId === "string" ? body.analysisId.slice(0, 64) : undefined;

  // Model is chosen by the server only; any client-sent model is ignored.
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  // Safe diagnostics only — never the prompt or contract text.
  console.log(`[jalli-api] analyze request id=${analysisId || "-"} chars=${promptChars} max_tokens=${maxTokens}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages })
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") return send(res, 504, { error: ERR.timeout });
    console.error("[jalli-api] upstream network error:", e && e.name);
    return send(res, 502, { error: ERR.upstream });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    // Log status only; never forward Anthropic's raw error body to users.
    console.error(`[jalli-api] upstream status ${upstream.status} id=${analysisId || "-"}`);
    if (upstream.status === 401 || upstream.status === 403) return send(res, 503, { error: ERR.upstreamAuth });
    if (upstream.status === 429) return send(res, 429, { error: ERR.upstreamRate });
    if (upstream.status === 404 || upstream.status === 400) return send(res, 502, { error: ERR.upstreamModel });
    if (upstream.status === 529) return send(res, 429, { error: ERR.upstreamRate });
    return send(res, 502, { error: ERR.upstream });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return send(res, 502, { error: ERR.upstream });
  }

  // Return only what the frontend needs: the content blocks.
  return send(res, 200, {
    content: Array.isArray(data.content) ? data.content : [],
    analysisId: analysisId || null
  });
};
