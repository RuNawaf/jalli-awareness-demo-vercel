/**
 * جَلّي — /api/health
 * Safe status probe. Reports whether the server-side API key is configured
 * without ever revealing the key itself.
 */
module.exports = function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, service: "jalli-api", error: "method not allowed" });
  }

  const apiConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  return res.status(apiConfigured ? 200 : 503).json({
    ok: apiConfigured,
    service: "jalli-api",
    apiConfigured
  });
};
