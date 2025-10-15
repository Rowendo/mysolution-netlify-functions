// netlify/functions/submit-application.js

/* =================== CORS / headers =================== */
const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

/* =================== Token cache =================== */
let _cachedToken = null; // { access_token, instance_url, exp }

/* =================== Entry =================== */
exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  // ---------- DEBUG: environment presence (safe) ----------
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
        login_url: (process.env.SF_LOGIN_URL || "https://login.salesforce.com").replace(
          /\/services.*$/i,
          ""
        ),
      }),
    };
  }

  // ---------- DEBUG: key shape (no secrets) ----------
  if (event.httpMethod === "GET" && event.queryStringParameters?.keyinfo === "1") {
    const pem = readPrivateKeyPemFromEnv();
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        present: !!pem,
        length: pem ? pem.length : 0,
        beginsWith: pem ? pem.slice(0, 30) : null,
        headerDetected: pem
          ? pem.includes("BEGIN PRIVATE KEY") || pem.includes("BEGIN RSA PRIVATE KEY")
          : false,
      }),
    };
  }

  // ---------- DEBUG: key parse test ----------
  if (event.httpMethod === "GET" && event.queryStringParameters?.keytest === "1") {
    try {
      const pem = readPrivateKeyPemFromEnv();
      if (!pem) throw new Error("no key read from env");
      parsePrivateKey(pem); // throws if invalid
      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: String(e.message) }),
      };
    }
  }

  // Simple GET “is alive”
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        ok: true,
        fn: "submit-application",
        url: "https://idyllic-clafoutis-89e556.netlify.app/.netlify/functions/submit-application",
      }),
    };
  }

  // ---------- POST flow ----------
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Parse body
  let fields = {};
  try {
    fields = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Invalid body" }),
    };
  }

  // Minimal validation
  const vacatureId = (fields.vacatureID || "").trim();
  const email = (fields.email || "").trim();
  const name = (fields.name || "").trim();

  if (!vacatureId || !email || !name) {
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({
        error: "Missing required fields",
        needed: { vacatureID: !!vacatureId, email: !!email, name: !!name },
      }),
    };
  }

  // Split name
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");

  // Payload for Apex REST
  const msBody = {
    vacancyId: vacatureId,
    candidate: { firstName, lastName, email },
  };

  // Build target URL (env supports {vacatureId})
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // Debug echo (no upstream)
  const isDebug =
    (event.queryStringParameters && event.queryStringParameters.debug === "1") ||
    fields.debug === "1";
  if (isDebug) {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ debug: true, url: targetUrl, msBody }, null, 2),
    };
  }

  try {
    // 1) Get JWT access token (cached)
    const { access_token, instance_url } = await getSalesforceAccessTokenJWT();

    // 2) Use explicit env endpoint if it’s already a Salesforce host, else derive from instance_url
    const apexUrl = /:\/\/[^/]*\.my\.salesforce\.com/i.test(targetUrl)
      ? targetUrl
      : `${instance_url.replace(/\/+$/, "")}/services/apexrest/msf/api/job/Apply?id=${encodeURIComponent(
          vacatureId
        )}`;

    // 3) POST to Apex REST
    let upstream = await fetch(apexUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify(msBody),
    });

    // Retry once on 401 (expired token)
    if (upstream.status === 401) {
      _cachedToken = null;
      const fresh = await getSalesforceAccessTokenJWT();
      upstream = await fetch(apexUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fresh.access_token}`,
        },
        body: JSON.stringify(msBody),
      });
    }

    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: baseHeaders,
      body: text || JSON.stringify({ ok: upstream.ok }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Upstream failure", detail: err?.message }),
    };
  }
};

/* =================== JWT helpers =================== */
const crypto = require("crypto");
const nowSeconds = () => Math.floor(Date.now() / 1000);

function normalizePem(pem) {
  if (!pem) return "";
  let s = pem.trim();
  // Strip accidental wrapping quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Unescape \n and normalize CRLF
  s = s.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  // Ensure final newline
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

function readPrivateKeyPemFromEnv() {
  // Prefer plain PEM
  const plain = process.env.SF_JWT_PRIVATE_KEY || "";
  if (plain && plain.includes("BEGIN")) {
    return normalizePem(plain);
  }
  // Fallback: base64
  const b64 = (process.env.SF_JWT_PRIVATE_KEY_B64 || "").trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (decoded.includes("BEGIN")) return normalizePem(decoded);
    } catch {
      // ignore
    }
  }
  return "";
}

function parsePrivateKey(pem) {
  try {
    return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs1" });
  }
}

function b64u(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJWT({ header, claims, privateKeyPem }) {
  const toSign = `${b64u(header)}.${b64u(claims)}`;
  const keyObj = parsePrivateKey(privateKeyPem);
  const sig = crypto
    .sign("RSA-SHA256", Buffer.from(toSign), keyObj)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${toSign}.${sig}`;
}

async function getSalesforceAccessTokenJWT() {
  // reuse cached token if >30s left
  if (_cachedToken && _cachedToken.exp > nowSeconds() + 30) return _cachedToken;

  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
    .replace(/\/services.*$/i, "")
    .replace(/\/+$/, "");

  const clientId = process.env.SF_CLIENT_ID;     // Connected App Consumer Key
  const subject = process.env.SF_JWT_SUBJECT;    // Integration user (email/username)
  const privateKeyPem = readPrivateKeyPemFromEnv();

  if (!clientId || !subject || !privateKeyPem) {
    throw new Error(
      "JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY(_B64)"
    );
  }

  const header = { alg: "RS256" };
  const claims = {
    iss: clientId,
    sub: subject,
    aud: loginUrl,
    exp: nowSeconds() + 180, // 3 minutes
  };
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
    throw new Error(`Failed to fetch Salesforce JWT token (${res.status}): ${txt.slice(0, 800)}`);
  }

  const json = await res.json(); // { access_token, instance_url, ... }
  _cachedToken = {
    access_token: json.access_token,
    instance_url: json.instance_url,
    exp: nowSeconds() + 600, // cache ~10 minutes
  };
  return _cachedToken;
}
