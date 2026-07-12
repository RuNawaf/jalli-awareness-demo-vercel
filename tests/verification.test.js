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

  // 9. .env hygiene
  t(".gitignore blocks .env", read(".gitignore").split("\n").includes(".env"));
  t(".env.example has no real key", read(".env.example").includes("your_anthropic_api_key_here"));

  // 10. api/analyze unit behavior (no network): method + validation + missing key
  const handler = require(path.join(root, "api", "analyze.js"));
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
