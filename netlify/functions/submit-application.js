/* =================== CORS / headers =================== */
const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
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

  // Minimal “alive” check
  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  // Parse body
  let fields = {};
  try {
    fields = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("Invalid JSON body:", e);
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Ongeldige aanvraag" }),
    };
  }

  // Accept vacatureID from body or id from query (en trimmen)
  const qsId = (event.queryStringParameters?.id || "").trim();
  const vacatureId = (fields.vacatureID || fields.vacancyId || fields.jobId || qsId || "").trim();
  const email = (fields.email || fields.Email || "").trim();
  const name = (fields.name || fields.Naam || "").trim();

  if (!vacatureId || !email || !name) {
    // Geen details naar de client – houd het generiek
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Aanvraag onvolledig" }),
    };
  }

  // Naam splitsen in Voornaam / Tussenvoegsels / Achternaam
  const parts = String(name).trim().split(/\s+/);
  const firstName = parts.shift() || "";
  const lastName = parts.length ? parts.pop() : "";
  const tussenvoegsels = parts.join(" ");

  const phone =
    (fields.phone || fields.telefoon || fields.telefoonnummer || fields["Mobiel_nummer"] || "")
      .toString()
      .trim();

  const utm =
    (fields.utm || fields.utm_source || fields.utmSource || fields["form-field-utm"] || "")
      .toString()
      .trim();

  // LinkedIn accepteren uit meerdere mogelijke invoervelden
  const linkedin =
    (fields.Linkedin_profiel ||
      fields.linkedin ||
      fields.LinkedIn ||
      fields.linkedin_url ||
      fields.LinkedInURL ||
      "").toString().trim();

  // CV (optioneel): { fileName, contentType, base64 }
  const MAX_BYTES = 5 * 1024 * 1024; // 5MB
  const cv = fields.cv && typeof fields.cv === "object" ? fields.cv : null;
  if (cv) {
    const okShape = cv.fileName && cv.contentType && cv.base64;
    if (!okShape) {
      console.warn("CV object invalid shape");
      return { statusCode: 422, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Ongeldige bijlage" }) };
    }
    // ~5MB check (base64->bytes)
    const approxBytes = Math.floor((cv.base64.length * 3) / 4);
    if (approxBytes > MAX_BYTES) {
      return { statusCode: 413, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Bijlage te groot" }) };
    }
  }

  // === Payload naar MySolution/Apex ===
  const cleanBase64 = cv ? (cv.base64 || "").replace(/^data:.*?;base64,/, "") : "";
  const fileName = cv ? (cv.fileName || "cv") : "";

  const msBody = {
    setApiName: "default",
    status: "Application",
    utm_source: utm,
    fields: {
      Voornaam:         { value: firstName },
      Tussenvoegsels:   { value: tussenvoegsels },
      Achternaam:       { value: lastName },
      Email:            { value: email },
      Mobiel_nummer:    { value: phone },
      PrivacyAgreement: { value: "true" },
      ...(linkedin ? { Linkedin_profiel: { value: linkedin } } : {}),
      ...(cv ? { CV: { value: cleanBase64, fileName } } : {}),
    },
  };

  // Doel-URL (env ondersteunt {vacatureId})
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  try {
    // 1) JWT access token (cached)
    const { access_token, instance_url } = await getSalesforceAccessTokenJWT();

    // 2) Apex URL bepalen
    const apexUrl = /:\/\/[^/]*\.salesforce\.com/i.test(targetUrl)
      ? targetUrl
      : `${instance_url.replace(/\/+$/, "")}/services/apexrest/msf/api/job/Apply?id=${encodeURIComponent(
          vacatureId
        )}`;

    // 3) POST naar Apex
    let upstream = await fetch(apexUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify(msBody),
    });

    // Retry op 401
    if (upstream.status === 401) {
      _cachedToken = null;
      const fresh = await getSalesforceAccessTokenJWT();
      upstream = await fetch(apexUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${fresh.access_token}`,
        },
        body: JSON.stringify(msBody),
      });
    }

    // Geen details naar de client
    if (upstream.ok) {
      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true }) };
    }

    console.error("Upstream error status:", upstream.status);
    return {
      statusCode: 502,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Er ging iets mis bij het verzenden" }),
    };
  } catch (err) {
    console.error("Unhandled server error:", err);
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Er ging iets mis" }),
    };
  }
};

/* =================== JWT helpers =================== */
// Gebruik expliciete Node built-in om bundling-issues te vermijden
const crypto = require("node:crypto");
const nowSeconds = () => Math.floor(Date.now() / 1000);

function normalizePem(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/^["']|["']$/g, "");
  s = s.replace(/\\n/g, "\n");
  s = s.replace(/\r\n/g, "\n");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}
function readPrivateKeyPemFromEnv() {
  const b64 = process.env.SF_JWT_PRIVATE_KEY_B64;
  if (b4) { // typo fixed below
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      return normalizePem(decoded);
    } catch {}
  }
  return normalizePem(process.env.SF_JWT_PRIVATE_KEY || "");
}
function parsePrivateKey(pem) {
  try { return crypto.createPrivateKey(pem); } catch (e1) {}
  try { return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" }); } catch (e2) {}
  try { return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs1" }); } catch (e3) {}
  throw new Error("Unsupported private key format");
}
function b64u(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJWT({ header, claims, privateKeyPem }) {
  const toSign = `${b64u(header)}.${b64u(claims)}`;
  const keyObj = parsePrivateKey(privateKeyPem);
  const sig = crypto
    .sign("RSA-SHA256", Buffer.from(toSign), keyObj)
    .toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${toSign}.${sig}`;
}
async function getSalesforceAccessTokenJWT() {
  if (_cachedToken && _cachedToken.exp > nowSeconds() + 30) return _cachedToken;

  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
    .replace(/\/services.*$/i, "").replace(/\/+$/, "");
  const clientId = process.env.SF_CLIENT_ID;
  const subject = process.env.SF_JWT_SUBJECT;
  const privateKeyPem = readPrivateKeyPemFromEnv();
  if (!clientId || !subject || !privateKeyPem) {
    throw new Error("JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY(_B64)");
  }

  const header = { alg: "RS256" };
  const claims = { iss: clientId, sub: subject, aud: loginUrl, exp: nowSeconds() + 120 };
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
    const txt = await res.text().catch(() => "");
    console.error("Failed to fetch Salesforce JWT token:", res.status, txt.slice(0, 800));
    throw new Error("JWT token fetch failed");
  }

  const json = await res.json();
  _cachedToken = { access_token: json.access_token, instance_url: json.instance_url, exp: nowSeconds() + 600 };
  return _cachedToken;
}
