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

The app has two pages: a **homepage** (`/`) that presents the brand story — what JALIY is, why JALIY, how it works, and the feature set — and a **dedicated analysis page** (`/analyze`, also reachable as `#analyze`) that contains the complete analysis experience: file upload **or** direct paste-text input, live analysis status, the tabbed results (summary, risks, rights, obligations, fees, dates, unclear clauses, original text), and grounded follow-up Q&A.

The frontend extracts text from PDF / DOCX / TXT / images (with Arabic+English OCR for scanned documents) or accepts pasted contract text directly, chunks long contracts at clause boundaries (there is no artificial character cap — arbitrarily long contracts are analyzed chunk by chunk and the results merged), and sends only the analysis prompt to `/api/analyze`. The server selects the model, attaches the key, forwards to Anthropic, and returns the content blocks. Every finding must carry a verbatim quote from the contract and is verified against the extracted text before rendering — unsupported findings are rejected, never shown. There is no mock analysis and no fallback sample anywhere in the flow; failures produce clear Arabic error messages.

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
│   ├── analyze.js             # secure Anthropic proxy factory: validation, limits, timeouts, safe Arabic errors
│   ├── compare.js             # /api/compare — same hardened handler (shared factory), comparison log label
│   └── health.js              # GET /api/health → { ok, service, apiConfigured }
└── tests/
    └── verification.test.js   # anti-hallucination + deployment/security tests (71 assertions)
```

## Features

- **Single contract analysis** (`/analyze`): upload PDF/DOCX/TXT/image or paste text → grounded, evidence-gated analysis (risks, rights, obligations, fees, dates, unclear clauses) + follow-up Q&A.
- **Two-contract comparison** (`/compare`, MVP): upload or paste Contract A and Contract B → clause-by-clause differences (payment, fees, dates, renewal, termination, liability, indemnity, confidentiality, IP, governing law, disputes, penalties…), similarities, clauses present in only one contract, risk comparison, and a text-grounded "more favorable" verdict. Every finding that cites a contract is verified literally against that contract's extracted text or rejected and counted — the same anti-hallucination gate as single analysis. A/B are always distinguished by letter + label + color (never color alone).
- **PDF export**: "تحميل ملخص PDF / Download PDF Summary" on analysis results and "تحميل تقرير المقارنة PDF / Download Comparison PDF" on comparison results. Bilingual, RTL-correct branded reports with page-level source quotes and a legal disclaimer. html2canvas 1.4.1 + jsPDF 2.5.1 load lazily from cdnjs on first export (no npm dependencies added).

## Language & branding

The UI is fully bilingual. The language button in the top bar switches instantly between Arabic (RTL, default) and English (LTR) with no page reload; the brand logo swaps with the language (Arabic جَلِيّ logo ⇄ English JALIY logo — both embedded directly in `index.html` as data URIs), all interface text, progress stages, result labels, and error messages are translated, and the choice is remembered locally.

**Analysis output language always follows the selected UI language, never the contract's language.** If the UI is English and the contract is Arabic, every interpretive field — summary, risks, rights, obligations, fees, dates, unclear clauses, headings, chat answers, empty states, and warnings — is produced 100% in English (and vice versa). Only `sourceText` quotes stay verbatim in the contract's original language. This rule is enforced in the analysis prompt, the JSON-repair prompt, and the follow-up Q&A prompt.

## Required environment variables (server-side only, set in Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key. Read only via `process.env` inside `api/analyze.js`. |
| `ANTHROPIC_MODEL` | No | Supported Anthropic model id. Falls back to **`claude-opus-4-8`** (Claude Opus 4.8) when unset. Change models here — never in frontend code; the frontend cannot override the model. |

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
Open browser DevTools → Network while analyzing: you should see `POST /api/analyze` requests to your own domain and **no** requests to `api.anthropic.com`. The debug panel (`Ctrl+Shift+D` or `?debug=1`) shows `endpoint: /api/analyze` and `model: Server-managed Claude Opus (default claude-opus-4-8; override via ANTHROPIC_MODEL)`.

## Local testing

```bash
npm test          # runs tests/verification.test.js (44 assertions, no network / no paid API calls)
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
- `api/analyze.js` enforces: POST-only, JSON-only, large safety ceilings on request size (4 MB body / 1 M prompt chars — never reached in practice because long contracts are chunked client-side), a `max_tokens` ceiling, upstream timeout via `AbortController`, and generic Arabic errors (Anthropic's raw error bodies and stack traces are never forwarded). Contract text is never logged — only safe metadata (request id, character count).
- A best-effort in-memory rate limiter softens bursts on a warm serverless instance. **This is not a complete production solution** — serverless instances are ephemeral and scaled horizontally; use Vercel WAF, an API gateway, or a shared store (e.g., Upstash) for real rate limiting.
- Uploaded contract text **is sent to Anthropic** for analysis. Use fictional contracts in demonstrations unless full privacy controls (auth, retention, consent) are implemented.

## GitHub Pages

GitHub Pages can host only the static UI. It **cannot** run the serverless backend or hold a secret key, so analysis will not work there. Use Vercel (or an equivalent functions host) for the working version.

## Anti-hallucination guarantees (unchanged)

Every risk, right, obligation, financial item, deadline, and unclear clause must include supporting `sourceText`, a page number, and a confidence score, and is verified against the extracted document using Arabic-aware normalization (exact match or ≥60% 3-word-shingle overlap). Unsupported findings are discarded and counted in the UI warning. Contract text is treated as untrusted data — instructions inside uploaded documents cannot override the analysis rules. The server integration does not bypass any of this: verification runs in the frontend after every response.

## Limits

- **File size:** the old 20 MB hard cap is removed. A generous 100 MB technical safety ceiling remains in the frontend (browser memory for extraction/OCR is the real constraint); the visible "maximum size" UI text was removed.
- **Contract length:** no fixed character cap. Long contracts are chunked at clause boundaries (~11k chars per chunk), analyzed sequentially, deduplicated, and merged; the anti-hallucination gate runs on the merged result against the full document.
- **Follow-up Q&A context:** up to 60,000 characters of the contract are sent per question (with a clear truncation note beyond that).
- **Comparison (MVP):** exactly two contracts; each contract is capped at 40,000 characters per comparison request (a visible warning appears if truncated). The comparison runs as a single grounded AI call plus at most one JSON-repair retry. Extracted text is cached per slot, so re-running a comparison never re-extracts or re-OCRs an unchanged contract. `onlyInA/onlyInB` absence claims are verified on the presence side (the quote must exist in the contract that contains the clause); risk comparison, review points, and the favorability verdict are model assessments and are labeled as such in the UI.
- **PDF export:** reports are rendered via the browser (HTML → canvas → PDF) so Arabic shaping and RTL are pixel-correct, but the text is image-based (not selectable). Page footers use numeric page counters. The two PDF libraries are fetched from cdnjs at export time, so the first export needs network access.

## Known limitations

- The retrieval-based learning system, admin review workflow, authentication, and per-user storage require a database phase (e.g., Supabase + pgvector) and are not part of this deployment.
- OCR language models are fetched from Tesseract's CDN at runtime; on restricted networks OCR fails gracefully with an Arabic error.
- The in-memory rate limiter is best-effort only (see Security notes).
