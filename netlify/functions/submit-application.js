// netlify/functions/submit-application.js

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// cache token between warm invocations
let _cachedToken = null;

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  // ---- DEBUG: env presence (safe) ----
  if (event.httpMethod === "GET" && event.queryStringParameters?.env === "1") {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        ok: true,
        fn: "submit-application",
        has_client_id: !!process.env.SF_CLIENT_ID,
        has_subject: !!process.env.SF_JWT_SUBJECT,
        has_key_b64: !!process.env.SF_JWT_PRIVATE_KEY_B64,
        has_key_plain: !!process.env.SF_JWT_PRIVATE_KEY,
        login_url: (process.env.SF_LOGIN_URL || "").replace(/\/services.*$/i, ""),
      }),
    };
  }

  // ---- DEBUG: key parsing check ----
  if (event.httpMethod === "GET" && event.queryStringParameters?.keytest === "1") {
    try {
      const pem = readPrivateKeyPemFromEnv();
      if (!pem) throw new Error("no key read from env");
      parsePrivateKey(pem); // throws if invalid
      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ ok: false, error: String(e.message) }) };
    }
  }

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true, fn: "submit-application" }) };
  }

  // ---- POST flow ----
  let fields = {};
  try {
    fields = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  const vacatureId = (fields.vacatureID || "").trim();
  const email = (fields.email || "").trim();
  const name = (fields.name || "").trim();
  if (!vacatureId || !email || !name) {
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Missing required fields", needed: { vacatureID: !!vacatureId, email: !!email, name: !!name } }),
    };
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");

  const msBody = {
    vacancyId: vacatureId,
    candidate: { firstName, lastName, email },
  };

  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  const isDebug =
    (event.queryStringParameters && event.queryStringParameters.debug === "1") || fields.debug === "1";
  if (isDebug) {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ debug: true, url: targetUrl, msBody }, null, 2) };
  }

  try {
    const { access_token, instance_url } = await getSalesforceAccessTokenJWT();

    const apexUrl = /:\/\/[^/]*\.my\.salesforce\.com/i.test(targetUrl)
      ? targetUrl
      : `${instance_url.replace(/\/+$/,"")}/services/apexrest/msf/api/job/Apply?id=${encodeURIComponent(vacatureId)}`;

    let upstream = await fetch(apexUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
      body: JSON.stringify(msBody),
    });

    if (upstream.status === 401) {
      _cachedToken = null;
      const fresh = await getSalesforceAccessTokenJWT();
      upstream = await fetch(apexUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${fresh.access_token}` },
        body: JSON.stringify(msBody),
      });
    }

    const text = await upstream.text();
    return { statusCode: upstream.status, headers: baseHeaders, body: text || JSON.stringify({ ok: upstream.ok }) };
  } catch (err) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Upstream failure", detail: err?.message }) };
  }
};

/* ===== JWT helpers ===== */

const crypto = require("crypto");
const nowSeconds = () => Math.floor(Date.now() / 1000);

function readPrivateKeyPemFromEnv() {
  const b64 = process.env.SF_JWT_PRIVATE_KEY_B64;
  if (b64) {
    try { return Buffer.from(b64, "base64").toString("utf8"); } catch {}
  }
  const raw = process.env.SF_JWT_PRIVATE_KEY || "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function parsePrivateKey(pem) {
  try { return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" }); }
  catch { return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs1" }); }
}

function b64u(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}

function signJWT({ header, claims, privateKeyPem }) {
  const toSign = `${b64u(header)}.${b64u(claims)}`;
  const keyObj = parsePrivateKey(privateKeyPem);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(toSign), keyObj)
    .toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${toSign}.${sig}`;
}

async function getSalesforceAccessTokenJWT() {
  if (_cachedToken && _cachedToken.exp > nowSeconds() + 30) return _cachedToken;

  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
    .replace(/\/services.*$/i, "")
    .replace(/\/+$/,"");

  const clientId = process.env.SF_CLIENT_ID;
  const subject  = process.env.SF_JWT_SUBJECT;
  const privateKeyPem = readPrivateKeyPemFromEnv();

  if (!clientId || !subject || !privateKeyPem) {
    throw new Error("JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY(_B64)");
  }

  const header = { alg: "RS256" };
  const claims = { iss: clientId, sub: subject, aud: loginUrl, exp: nowSeconds() + 180 };
  const assertion = signJWT({ header, claims, privateKeyPem });

  const tokenUrl = `${loginUrl}/services/oauth2/token`;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to fetch Salesforce JWT token (${res.status}): ${txt.slice(0,800)}`);
  }

  const json = await res.json();
  _cachedToken = { access_token: json.access_token, instance_url: json.instance_url, exp: nowSeconds() + 600 };
  return _cachedToken;
}
