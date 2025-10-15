// netlify/functions/submit-application.js

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// cache the token between warm invocations
let _cachedToken = null; // { access_token, instance_url, exp }

/** Entry */
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ ok: true, fn: "submit-application" }),
    };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Parse JSON body
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

  // Split name -> first/last
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");

  // Payload for Apex REST
  const msBody = {
    vacancyId: vacatureId,
    candidate: { firstName, lastName, email },
  };

  // Build target URL (replace placeholder)
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace(
    "{vacatureId}",
    encodeURIComponent(vacatureId)
  );

  // Debug mode: show target URL + body, do NOT call upstream
  const isDebug =
    (event.queryStringParameters &&
      event.queryStringParameters.debug === "1") ||
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

    // 2) Use explicit env endpoint if it already targets a Salesforce domain,
    //    otherwise build from instance_url to be robust across orgs
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

    // Retry once on 401 (token just expired)
    if (upstream.status === 401) {
      invalidateTokenCache();
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
      body: JSON.stringify({
        error: "Upstream failure",
        detail: err?.message,
      }),
    };
  }
};

/* ========================= JWT helpers ========================= */

function invalidateTokenCache() {
  _cachedToken = null;
}

const crypto = require("crypto");

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Prefer base64 var (bulletproof against newline issues), then plaintext var
function readPrivateKeyPemFromEnv() {
  const b64 = process.env.SF_JWT_PRIVATE_KEY_B64;
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      /* fall through to plaintext var */
    }
  }
  const raw = process.env.SF_JWT_PRIVATE_KEY || "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function base64url(json) {
  return Buffer.from(JSON.stringify(json))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJWT({ header, claims, privateKeyPem }) {
  const encHeader = base64url(header);
  const encClaims = base64url(claims);
  const toSign = `${encHeader}.${encClaims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(toSign);
  const sig = signer.sign(privateKeyPem).toString("base64");
  const encSig = sig
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${toSign}.${encSig}`;
}

async function getSalesforceAccessTokenJWT() {
  // reuse cached token if still valid (>30s left)
  if (_cachedToken && _cachedToken.exp > nowSeconds() + 30) {
    return _cachedToken;
  }

  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
    .replace(/\/services.*$/i, "")
    .replace(/\/+$/, ""); // normalize

  const clientId = process.env.SF_CLIENT_ID;      // Consumer Key
  const subject  = process.env.SF_JWT_SUBJECT;    // user email
  const privateKeyPem = readPrivateKeyPemFromEnv();

  if (!clientId || !subject || !privateKeyPem) {
    throw new Error(
      "JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY(_B64)"
    );
  }

  // Build JWT assertion
  const header = { alg: "RS256" };
  const claims = {
    iss: clientId, // connected app client id
    sub: subject,  // integration user
    aud: loginUrl, // MUST match login host exactly
    exp: nowSeconds() + 180, // 3 minutes
  };
  const assertion = signJWT({ header, claims, privateKeyPem });

  // Exchange JWT for access token
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
    throw new Error(
      `Failed to fetch Salesforce JWT token (${res.status}): ${txt.slice(0, 800)}`
    );
  }

  const json = await res.json(); // { access_token, instance_url, ... }
  _cachedToken = {
    access_token: json.access_token,
    instance_url: json.instance_url,
    exp: nowSeconds() + 600, // cache ~10 minutes
  };
  return _cachedToken;
}
