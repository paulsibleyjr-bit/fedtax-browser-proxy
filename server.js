async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl = buildVerifyUrl();
  if (!verifyUrl) {
    return { ok: false, error: "Missing BASE44_APP_ID env var on Render." };
  }

  const headers = { "Content-Type": "application/json" };

  // ✅ REQUIRED: send the proxy verify key to Base44
  if (process.env.PROXY_VERIFY_KEY) {
    headers["x-proxy-verify-key"] = process.env.PROXY_VERIFY_KEY;
    headers["authorization"] = `Bearer ${process.env.PROXY_VERIFY_KEY}`;
  } else {
    console.warn("[VERIFY] PROXY_VERIFY_KEY is missing on Render");
  }

  const resp = await fetch(verifyUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: text || `verifyBrowserSession failed (${resp.status})` };
  }

  return { ok: true };
}
