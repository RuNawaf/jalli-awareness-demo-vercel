/**
 * جَلّي — /api/analyze
 * Secure server-side proxy to the Anthropic Messages API.
 *
 * Required Vercel environment variable:
 *   ANTHROPIC_API_KEY
 *
 * Optional Vercel environment variable:
 *   ANTHROPIC_MODEL
 */

"use strict";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";

const MAX_BODY_BYTES = 400_000;
const MAX_PROMPT_CHARS = 200_000;
const MAX_TOKENS_LIMIT = 16_000;
const UPSTREAM_TIMEOUT_MS = 180_000;

/* Best-effort in-memory rate limiting. This is not a complete production
   rate limiter because Vercel functions can run on multiple instances. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const previous = rateBuckets.get(ip) || [];
  const recent = previous.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);

  recent.push(now);
  rateBuckets.set(ip, recent);

  if (rateBuckets.size > 5_000) rateBuckets.clear();
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
  upstreamBilling: "توجد مشكلة في الرصيد أو معلومات الفوترة لخدمة الذكاء الاصطناعي.",
  upstreamPermission: "مفتاح API لا يملك صلاحية استخدام النموذج المحدد.",
  upstreamRate: "خدمة الذكاء الاصطناعي مشغولة حاليًا. حاول مرة أخرى بعد قليل.",
  upstreamModel: "نموذج الذكاء الاصطناعي المهيأ غير متاح. راجع إعداد ANTHROPIC_MODEL.",
  upstreamRequest: "رفضت خدمة الذكاء الاصطناعي إعدادات الطلب. راجع سجلات Vercel لمعرفة السبب.",
  timeout: "استغرق التحليل وقتًا أطول من المتوقع وتم إيقاف الطلب.",
  invalidResponse: "أعادت خدمة الذكاء الاصطناعي استجابة غير صالحة.",
  upstream: "تعذّر إتمام تحليل الذكاء الاصطناعي. حاول مرة أخرى لاحقًا."
};

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(body);
}

function cleanEnvironmentValue(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      if (Buffer.byteLength(req.body, "utf8") > MAX_BODY_BYTES) {
        throw new Error("tooLarge");
      }
      return JSON.parse(req.body);
    }

    const serialized = JSON.stringify(req.body);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
      throw new Error("tooLarge");
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

  if (chunks.length === 0) throw new Error("badJson");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const normalized = [];
  let promptChars = 0;

  for (const message of messages) {
    if (
      !message ||
      message.role !== "user" ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      return null;
    }

    const content = message.content.trim();
    promptChars += content.length;
    normalized.push({ role: "user", content });
  }

  return { messages: normalized, promptChars };
}

async function readAnthropicError(upstream) {
  const rawBody = await upstream.text();
  let parsed = null;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  return {
    type:
      parsed?.error && typeof parsed.error.type === "string"
        ? parsed.error.type
        : "unknown",
    message:
      parsed?.error && typeof parsed.error.message === "string"
        ? parsed.error.message
        : rawBody.slice(0, 500) || "No error message returned",
    requestId:
      upstream.headers.get("request-id") || parsed?.request_id || null
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, 405, { error: ERR.method });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: ERR.method });
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return send(res, 415, { error: ERR.contentType });
  }

  const declaredSize = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    return send(res, 413, { error: ERR.tooLarge });
  }

  const forwardedFor = String(req.headers["x-forwarded-for"] || "");
  const ip =
    forwardedFor.split(",")[0].trim() ||
    String(req.socket?.remoteAddress || "unknown");

  if (rateLimited(ip)) {
    return send(res, 429, { error: ERR.rateLimited });
  }

  const apiKey = cleanEnvironmentValue(process.env.ANTHROPIC_API_KEY);
  const model =
    cleanEnvironmentValue(process.env.ANTHROPIC_MODEL) || DEFAULT_MODEL;

  if (!apiKey) {
    console.warn("[jalli-api] ANTHROPIC_API_KEY is not configured");
    return send(res, 503, { error: ERR.notConfigured });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const isTooLarge = error?.message === "tooLarge";
    return send(res, isTooLarge ? 413 : 400, {
      error: isTooLarge ? ERR.tooLarge : ERR.badJson
    });
  }

  const validation = validateMessages(body?.messages);
  if (!validation) return send(res, 400, { error: ERR.badRequest });

  const { messages, promptChars } = validation;
  if (promptChars > MAX_PROMPT_CHARS) {
    return send(res, 413, { error: ERR.tooLong });
  }

  const requestedMaxTokens = Number.parseInt(body.max_tokens, 10);
  const maxTokens = Math.min(
    Math.max(Number.isFinite(requestedMaxTokens) ? requestedMaxTokens : 4096, 256),
    MAX_TOKENS_LIMIT
  );

  const analysisId =
    typeof body.analysisId === "string"
      ? body.analysisId.slice(0, 64)
      : null;

  console.log("[jalli-api] analyze request", {
    analysisId: analysisId || "-",
    promptChars,
    maxTokens,
    model
  });

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
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        messages
      })
    });
  } catch (error) {
    clearTimeout(timer);

    if (error?.name === "AbortError") {
      console.error("[jalli-api] Anthropic timeout", {
        analysisId: analysisId || "-",
        model
      });
      return send(res, 504, { error: ERR.timeout });
    }

    console.error("[jalli-api] Anthropic network error", {
      analysisId: analysisId || "-",
      model,
      errorName: error?.name || "unknown"
    });
    return send(res, 502, { error: ERR.upstream });
  }

  clearTimeout(timer);

  if (!upstream.ok) {
    const anthropicError = await readAnthropicError(upstream);

    console.error("[jalli-api] Anthropic error", {
      status: upstream.status,
      type: anthropicError.type,
      message: anthropicError.message,
      requestId: anthropicError.requestId,
      model,
      analysisId: analysisId || "-"
    });

    switch (upstream.status) {
      case 400:
        return send(res, 502, { error: ERR.upstreamRequest });
      case 401:
        return send(res, 503, { error: ERR.upstreamAuth });
      case 402:
        return send(res, 503, { error: ERR.upstreamBilling });
      case 403:
        return send(res, 503, { error: ERR.upstreamPermission });
      case 404:
        return send(res, 502, { error: ERR.upstreamModel });
      case 413:
        return send(res, 413, { error: ERR.tooLarge });
      case 429:
      case 529:
        return send(res, 429, { error: ERR.upstreamRate });
      case 504:
        return send(res, 504, { error: ERR.timeout });
      default:
        return send(res, 502, { error: ERR.upstream });
    }
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    console.error("[jalli-api] Invalid Anthropic success response", {
      analysisId: analysisId || "-",
      model,
      status: upstream.status
    });
    return send(res, 502, { error: ERR.invalidResponse });
  }

  if (!data || !Array.isArray(data.content)) {
    console.error("[jalli-api] Anthropic response missing content", {
      analysisId: analysisId || "-",
      model,
      requestId: upstream.headers.get("request-id") || null
    });
    return send(res, 502, { error: ERR.invalidResponse });
  }

  return send(res, 200, {
    content: data.content,
    analysisId,
    requestId: upstream.headers.get("request-id") || null,
    stopReason: data.stop_reason || null
  });
};
