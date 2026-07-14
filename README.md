# جَلِيّ (JALIY) — Intelligent Arabic Contract Analysis

A production-deployable contract analysis application: a self-contained static frontend (`index.html`) plus a secure Vercel serverless backend that proxies requests to the Anthropic API. The API key lives **only** in server-side environment variables — it never appears in the browser, the HTML, the JavaScript bundle, or this repository.

---

## Architecture

```text
Browser
→ local document extraction (pdf.js / mammoth / Tesseract OCR — runs in the browser)
→ POST /api/analyze            (Vercel serverless function)
→ Anthropic Messages API        (server-side, key from process.env)
→ structured JSON analysis
→ schema validation + evidence verification (anti-hallucination gate)
→ UI rendering (Arabic, RTL)
```

The frontend extracts text from PDF / DOCX / TXT / images (with Arabic+English OCR for scanned documents), chunks long contracts at clause boundaries, and sends only the analysis prompt to `/api/analyze`. The server selects the model, attaches the key, forwards to Anthropic, and returns the content blocks. Every finding must carry a verbatim quote from the contract and is verified against the extracted text before rendering — unsupported findings are rejected, never shown. There is no mock analysis and no fallback sample anywhere in the flow; failures produce clear Arabic error messages.

## Project structure

```text
jaliy/
├── index.html                 # complete frontend: bilingual (AR/EN) design system + embedded logos + extraction + analysis UI
├── assets/
│   ├── jaliy-logo-ar.png      # Arabic logo (جَلِيّ) — transparent, shown when UI language is Arabic
│   └── jaliy-logo-en.png      # English logo (JALIY) — transparent, shown when UI language is English
├── README.md                  # this file
├── package.json               # npm test script (no frontend framework, no dependencies)
├── vercel.json                # security headers; static + /api routing (Vercel defaults)
├── .gitignore                 # blocks .env, .vercel, node_modules from being committed
├── .env.example               # documented server-side env vars (no real secrets)
├── api/
│   ├── analyze.js             # secure Anthropic proxy: validation, limits, timeouts, safe Arabic errors
│   └── health.js              # GET /api/health → { ok, service, apiConfigured }
└── tests/
    └── verification.test.js   # anti-hallucination + deployment/security tests (37 assertions)
```

## Language & branding

The UI is fully bilingual. The language button in the top bar switches instantly between Arabic (RTL, default) and English (LTR) with no page reload; the brand logo swaps with the language (Arabic جَلِيّ logo ⇄ English JALIY logo — both embedded directly in `index.html` as data URIs, so they always render even without the `assets/` folder; the full-resolution originals remain in `assets/` for brand use), all interface text, progress stages, result labels, and error messages are translated, and the choice is remembered locally. AI explanations are produced in the interface language active at analysis time, while every `sourceText` quote stays verbatim from the contract.

## Required environment variables (server-side only, set in Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key. Read only via `process.env` inside `api/analyze.js`. |
| `ANTHROPIC_MODEL` | No | Supported Anthropic model id. Falls back to `claude-sonnet-4-5` when unset. Change models here — never in frontend code. |

## Deploy to Vercel

1. Push this project to a GitHub repository (structure exactly as above).
2. In Vercel: **Add New → Project → Import** the repository.
3. Framework Preset: **Other** (no build step; static file + `/api` functions).
4. Under **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`).
5. **Deploy.**
6. If you change environment variables later, you must **Redeploy** for them to take effect.
7. Open `https://<your-app>.vercel.app/api/health` — expect `{"ok":true,"service":"jalli-api","apiConfigured":true}`. If `apiConfigured` is `false`, the key is missing or the deployment predates it.
8. Open the app root, upload a contract, and run an analysis.

### Verifying the server endpoint is used
Open browser DevTools → Network while analyzing: you should see `POST /api/analyze` requests to your own domain and **no** requests to `api.anthropic.com`. The debug panel (`Ctrl+Shift+D` or `?debug=1`) shows `endpoint: /api/analyze` and `model: Server-managed Anthropic model (ANTHROPIC_MODEL)`.

## Local testing

```bash
npm test          # runs tests/verification.test.js (37 assertions, no network / no paid API calls)
```

For full local end-to-end testing you need the Vercel runtime so `/api/analyze` exists:

```bash
npm install -g vercel
cp .env.example .env    # put your real key in .env (git-ignored)
vercel dev
```

Do **not** test full AI analysis by opening `index.html` directly from disk — without the Vercel runtime there is no `/api/analyze`, and the app will correctly show the Arabic "service not configured/unreachable" error rather than any fake result.

## Security notes

- **Never** put the API key in `index.html`, any frontend file, or GitHub.
- **Never** expose the key through client-side variables (`VITE_…`, `NEXT_PUBLIC_…`, etc.).
- `api/analyze.js` enforces: POST-only, JSON-only, request-size and prompt-length caps, a `max_tokens` ceiling, upstream timeout via `AbortController`, and generic Arabic errors (Anthropic's raw error bodies and stack traces are never forwarded). Contract text is never logged — only safe metadata (request id, character count).
- A best-effort in-memory rate limiter softens bursts on a warm serverless instance. **This is not a complete production solution** — serverless instances are ephemeral and scaled horizontally; use Vercel WAF, an API gateway, or a shared store (e.g., Upstash) for real rate limiting.
- Uploaded contract text **is sent to Anthropic** for analysis. Use fictional contracts in demonstrations unless full privacy controls (auth, retention, consent) are implemented.

## GitHub Pages

GitHub Pages can host only the static UI. It **cannot** run the serverless backend or hold a secret key, so analysis will not work there. Use Vercel (or an equivalent functions host) for the working version.

## Anti-hallucination guarantees (unchanged)

Every risk, right, obligation, financial item, deadline, and unclear clause must include supporting `sourceText`, a page number, and a confidence score, and is verified against the extracted document using Arabic-aware normalization (exact match or ≥60% 3-word-shingle overlap). Unsupported findings are discarded and counted in the UI warning. Contract text is treated as untrusted data — instructions inside uploaded documents cannot override the analysis rules. The server integration does not bypass any of this: verification runs in the frontend after every response.

## Known limitations

- The retrieval-based learning system, admin review workflow, authentication, and per-user storage require a database phase (e.g., Supabase + pgvector) and are not part of this deployment.
- OCR language models are fetched from Tesseract's CDN at runtime; on restricted networks OCR fails gracefully with an Arabic error.
- The in-memory rate limiter is best-effort only (see Security notes).
