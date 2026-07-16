/**
 * جَلّي — unit tests for the anti-hallucination core
 * Run with: node tests/verification.test.js  (from the project root)
 * Extracts the pure functions from index.html and asserts:
 *  - Arabic normalization (diacritics, alef forms, Arabic digits)
 *  - Evidence gate accepts quotes present in the contract
 *  - Evidence gate REJECTS invented clauses (incl. the old prototype's
 *    repeated results: تجديد تلقائي، رسوم غير مستردة)
 *  - Language detection (ar / en / mixed)
 *  - Clause-aware chunking preserves page markers, never explodes size
 */
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const src = html.split("<script>")[1].split("</" + "script>")[0];
const CHUNK_TARGET_CHARS = 11000;
function grab(name) {
  const re = new RegExp("function " + name + "\\([\\s\\S]*?\\n}");
  const m = src.match(re);
  if (!m) throw new Error("missing " + name);
  return m[0];
}
eval([grab("normalizeText"), grab("isSupported"), grab("detectLanguage"), grab("buildChunks")].join("\n"));

let pass = 0, fail = 0;
function t(name, cond) { cond ? pass++ : (fail++, console.log("FAIL:", name)); }

t("normalize diacritics", normalizeText("غَرَامَةُ الإِلْغَاءِ") === normalizeText("غرامه الالغاء"));
t("arabic digits", normalizeText("١٠٠٠٠ ريال") === "10000 ريال");

const contract = "المادة الخامسة: في حال إنهاء العقد قبل انتهاء مدته يتحمل العميل غرامة قدرها ٥٠٠٠ ريال. المادة السادسة: يحق للعميل الحصول على نسخة من العقد.";
const nf = normalizeText(contract);
t("supported exact quote accepted", isSupported("يتحمل العميل غرامة قدرها ٥٠٠٠ ريال", nf) === true);
t("supported despite diacritics variance", isSupported("يَتحمل العميلُ غرامةً قدرها 5000 ريال", nf) === true);
t("rejects invented automatic-renewal clause", isSupported("يتم تجديد الاشتراك تلقائيًا لمدة مماثلة ما لم يقدم المستخدم طلب الإلغاء", nf) === false);
t("rejects invented non-refundable-fee clause", isSupported("تعد الرسوم المدفوعة غير قابلة للاسترداد بعد إتمام التسجيل", nf) === false);
t("rejects too-short quote", isSupported("العقد", nf) === false);

t("lang ar", detectLanguage("هذا عقد إيجار سكني") === "ar");
t("lang en", detectLanguage("This is a lease agreement between parties") === "en");
t("lang mixed", detectLanguage("يوافق العميل customer agrees to the terms والشروط المذكورة herein and below") === "mixed");

const doc = { pages: Array.from({ length: 8 }, (_, i) => ({ pageNumber: i + 1, text: "المادة " + (i + 1) + ": " + "نص تعاقدي طويل ".repeat(180) })) };
const chunks = buildChunks(doc);
t("long doc chunked", chunks.length > 1);
t("page markers preserved", chunks.join("").includes("[[صفحة 1]]") && chunks.join("").includes("[[صفحة 8]]"));
t("no chunk wildly oversized", chunks.every(c => c.length < CHUNK_TARGET_CHARS * 1.6));
t("short doc stays single chunk", buildChunks({ pages: [{ pageNumber: 1, text: "عقد قصير" }] }).length === 1);

/* =====================================================================
   Deployment & security tests (static / unit-level only — no paid API
   calls). Added for the Vercel serverless architecture.
   ===================================================================== */
(function deploymentTests() {
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  // 1. Frontend no longer calls Anthropic directly
  t("frontend has no direct api.anthropic.com call", !html.includes("api.anthropic.com"));

  // 2. Frontend calls the serverless endpoint
  t("frontend calls /api/analyze", html.includes('"/api/analyze"') && html.includes("API_ENDPOINT"));

  // 3. Serverless endpoints exist
  t("api/analyze.js exists", fs.existsSync(path.join(root, "api", "analyze.js")));
  t("api/health.js exists", fs.existsSync(path.join(root, "api", "health.js")));

  // 4. API key comes only from process.env; never from the client
  const analyzeSrc = read(path.join("api", "analyze.js"));
  t("analyze.js reads key from process.env", analyzeSrc.includes("process.env.ANTHROPIC_API_KEY"));
  t("analyze.js sends anthropic-version header", analyzeSrc.includes("anthropic-version"));
  t("analyze.js never reads a client-supplied key", !/body\.[a-zA-Z_]*key/i.test(analyzeSrc) && !/apiKey\s*=\s*body/.test(analyzeSrc));

  // 5. No API key placeholder or real key embedded anywhere shippable
  const shipped = ["index.html", path.join("api", "analyze.js"), path.join("api", "health.js"), "vercel.json", "package.json"];
  t("no sk-ant key in shipped files", shipped.every((f) => !read(f).includes("sk-ant")));
  t("no ANTHROPIC_API_KEY reference in frontend", !html.includes("ANTHROPIC_API_KEY=") && !/x-api-key/i.test(html));

  // 6. No mock/fallback analysis in the production flow
  t("no mock fallback in frontend", !/mockAnalysis|sampleAnalysis|fallbackAnalysis|demoResult/i.test(html));
  t("no mock fallback in API", !/mock|placeholder analysis|sample result/i.test(analyzeSrc));

  // 7. Frontend model constant removed (server-managed model)
  t("frontend no longer defines MODEL constant", !/const MODEL\s*=/.test(html));

  // 8. Config files are valid JSON
  t("package.json is valid JSON", (() => { try { JSON.parse(read("package.json")); return true; } catch { return false; } })());
  t("vercel.json is valid JSON", (() => { try { JSON.parse(read("vercel.json")); return true; } catch { return false; } })());

  // 8b. Product requirements (2026-07 update)
  t("backend default model is Claude Opus 4.8", analyzeSrc.includes('"claude-opus-4-8"'));
  t("frontend offers a paste-text input", html.includes('id="pasteInput"') && html.includes('id="modePasteBtn"'));
  t("analysis lives on a dedicated view", html.includes('id="viewAnalyze"') && html.includes('id="viewHome"'));
  t("vercel routes /analyze to the app", read("vercel.json").includes('"/analyze"'));
  t("small fixed size-cap text removed", !html.includes("20 م.ب") && !html.includes("20 MB"));
  t("hero decorative pills removed", !html.includes("float-chip") && !html.includes("hero-eyebrow"));
  t("prompts enforce UI output language", html.includes("outputLanguageDirective"));

  // 9. .env hygiene
  t(".gitignore blocks .env", read(".gitignore").split("\n").includes(".env"));
  t(".env.example has no real key", read(".env.example").includes("your_anthropic_api_key_here"));

  /* ===================================================================
     Contract comparison (MVP: two contracts) + PDF export (2026-07)
     =================================================================== */
  // comparison endpoint exists and reuses the hardened analyze proxy
  t("api/compare.js exists", fs.existsSync(path.join(root, "api", "compare.js")));
  const compareSrc = read(path.join("api", "compare.js"));
  t("compare.js delegates to shared analyze handler", compareSrc.includes('require("./analyze.js")') && compareSrc.includes('createHandler("compare")'));
  t("analyze.js exports the shared handler factory", analyzeSrc.includes("createHandler") && analyzeSrc.includes('createHandler("analyze")'));
  t("compare.js never touches a client-supplied key", !/x-api-key|sk-ant|apiKey\s*=\s*body/.test(compareSrc));

  // frontend comparison experience
  t("frontend has a dedicated compare view", html.includes('id="viewCompare"'));
  t("frontend calls /api/compare", html.includes('"/api/compare"') && html.includes("COMPARE_ENDPOINT"));
  t("compare has two contract inputs (A and B)", html.includes('id="cmpFileInputA"') && html.includes('id="cmpFileInputB"'));
  t("compare supports pasting both contracts", html.includes('id="cmpPasteA"') && html.includes('id="cmpPasteB"'));
  t("compare button starts disabled until both ready", /id="compareBtn"[^>]*disabled/.test(html));
  t("comparison findings are evidence-gated", html.includes("verifyCompareEvidence") && html.includes("COMPARE_SCHEMA_TEXT"));
  t("compare route wired in navigation", html.includes('data-nav="compare"') && read("vercel.json").includes('"/compare"'));
  t("compare progress has genuine stages", html.includes('id="cmpStageList"') && html.includes('data-stage="verify"'));

  // PDF export (single + comparison), bilingual with disclaimer
  t("single analysis has a PDF download button", html.includes('id="downloadPdfBtn"'));
  t("comparison has a PDF download button", html.includes('id="downloadCmpPdfBtn"'));
  t("PDF reports include a legal disclaimer", html.includes("pdfDisclaimer") && /لا يُعد استشارة قانونية/.test(html) && /not legal advice/.test(html));
  t("PDF libs are loaded lazily from cdnjs", html.includes("html2canvas/1.4.1") && html.includes("jspdf/2.5.1") && html.includes("ensurePdfLibs"));
  t("PDF export builds bilingual reports", html.includes("buildSingleReportHTML") && html.includes("buildCompareReportHTML"));

  // pure-function behavior: slot readiness & per-contract truncation cap
  const MIN_READABLE_CHARS = 120;
  const CMP_MAX_CHARS_PER_CONTRACT = 40000;
  eval([grab("slotReady"), grab("markedContractText")].join("\n"));
  t("slot not ready when empty", slotReady({ mode: "file", file: null }, "") === false);
  t("slot ready with a file", slotReady({ mode: "file", file: { name: "a.pdf" } }, "") === true);
  t("slot not ready with short pasted text", slotReady({ mode: "paste", file: null }, "قصير") === false);
  t("slot ready with long pasted text", slotReady({ mode: "paste", file: null }, "نص تعاقدي ".repeat(30)) === true);
  const bigDoc = { pages: [{ pageNumber: 1, text: "بند ".repeat(30000) }] };
  const mk = markedContractText(bigDoc);
  t("long contract capped for one comparison request", mk.truncated === true && mk.text.length <= CMP_MAX_CHARS_PER_CONTRACT + 4);
  t("page markers preserved in comparison text", markedContractText({ pages: [{ pageNumber: 3, text: "بند" }] }).text.includes("[[صفحة 3]]"));

  // 10. api/analyze unit behavior (no network): method + validation + missing key
  const handler = require(path.join(root, "api", "analyze.js"));
  const compareHandler = require(path.join(root, "api", "compare.js"));
  const health = require(path.join(root, "api", "health.js"));
  function mockRes() {
    const r = { headers: {}, statusCode: 0, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  }
  const asyncTests = (async () => {
    delete process.env.ANTHROPIC_API_KEY;

    let res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    t("analyze rejects GET with 405", res.statusCode === 405);

    res = mockRes();
    await handler({ method: "POST", headers: { "content-type": "text/plain" } }, res);
    t("analyze rejects non-JSON content-type", res.statusCode === 415);

    res = mockRes();
    await handler({ method: "POST", headers: { "content-type": "application/json" }, body: { messages: [] } }, res);
    t("analyze with missing key or bad body never returns 200", res.statusCode === 503 || res.statusCode === 400);

    res = mockRes();
    process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
    await handler({ method: "POST", headers: { "content-type": "application/json" }, body: { messages: [] } }, res);
    t("analyze rejects empty messages with 400", res.statusCode === 400);

    res = mockRes();
    await handler({ method: "POST", headers: { "content-type": "application/json" }, body: { messages: [{ role: "user", content: "" }] } }, res);
    t("analyze rejects empty prompt content with 400", res.statusCode === 400);
    delete process.env.ANTHROPIC_API_KEY;

    /* /api/compare shares the exact same hardened behavior */
    res = mockRes();
    await compareHandler({ method: "GET", headers: {} }, res);
    t("compare rejects GET with 405", res.statusCode === 405);

    res = mockRes();
    await compareHandler({ method: "POST", headers: { "content-type": "text/plain" } }, res);
    t("compare rejects non-JSON content-type", res.statusCode === 415);

    res = mockRes();
    await compareHandler({ method: "POST", headers: { "content-type": "application/json" }, body: { messages: [] } }, res);
    t("compare with missing key or bad body never returns 200", res.statusCode === 503 || res.statusCode === 400);

    res = mockRes();
    process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
    await compareHandler({ method: "POST", headers: { "content-type": "application/json" }, body: { messages: [{ role: "user", content: "" }] } }, res);
    t("compare rejects a one-sided/empty request with 400", res.statusCode === 400);
    delete process.env.ANTHROPIC_API_KEY;

    res = mockRes();
    health({ method: "GET", headers: {} }, res);
    t("health reports apiConfigured=false without key", res.statusCode === 503 && res.body.apiConfigured === false && res.body.service === "jalli-api");

    process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
    res = mockRes();
    health({ method: "GET", headers: {} }, res);
    t("health reports apiConfigured=true with key", res.statusCode === 200 && res.body.ok === true);
    delete process.env.ANTHROPIC_API_KEY;

    console.log("PASS:", pass, "FAIL:", fail);
    process.exit(fail ? 1 : 0);
  })();
})();
