/**
 * جَلّي — /api/compare
 * Secure server-side proxy used by the two-contract comparison feature.
 *
 * It intentionally reuses the exact same hardened implementation as
 * /api/analyze (validation, size caps, rate limiting, timeout handling,
 * bilingual error mapping, and server-side ANTHROPIC_API_KEY handling)
 * instead of duplicating it. Only the log label differs.
 */

"use strict";

module.exports = require("./analyze.js").createHandler("compare");
