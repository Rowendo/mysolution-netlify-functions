/* =================== CORS / headers =================== */
const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
  "Content-Type": "application/json",
};

/* =================== Token cache =================== */
let _cachedToken = null; // { access_token, instance_url, exp }

/* =================== SMTP helper =================== */
const nodemailer = require("nodemailer");

async function notifyTeamEmail({ name, email, phone, linkedin, vacatureId, cv }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || "no-reply@localhost";

  // Meerdere ontvangers via komma-gescheiden lijst
  const toEnv = process.env.MAIL_TO || "we@freelancersunitd.nl";
  const to = toEnv.includes(",")
    ? toEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : toEnv;

  if (!host || !user || !pass) {
    console.warn("SMTP env missing; skipping email");
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,      // 465 = SMTPS, 587 = STARTTLS
    requireTLS: port === 587,  // force STARTTLS op 587
    auth: { user, pass },
    tls: { ciphers: "TLSv1.2" },
  });

  const subject = `Nieuwe sollicitatie: ${name} – ${vacatureId}`;
  const lines = [
    "Er is zojuist een sollicitatie binnengekomen.",
    "",
    `Naam: ${name}`,
    `E-mail: ${email}`,
    `Telefoon: ${phone || "-"}`,
    `LinkedIn: ${linkedin || "-"}`,
    `VacatureID: ${vacatureId}`,
    `CV bijgevoegd: ${cv ? "ja" : "nee"}`,
    "",
    "— Automatische melding",
  ];
  const text = lines.join("\n");

  const mailOptions = {
    from,
    to,
    subject,
    text,
    attachments: cv
      ? [
          {
            filename: cv.fileName || "cv",
            // Defensief: strip een eventuele data-URL prefix
            content: (cv.base64 || "").replace(/^data:.*?;base64,/, ""),
            encoding: "base64",
            contentType: cv.contentType || "application/octet-stream",
          },
        ]
      : [],
  };

  const res = await transporter.sendMail(mailOptions);
  return res;
}

/* =================== Entry =================== */
exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  /* ---------- DEBUG: environment presence (safe) ---------- */
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
        login_url: (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
          .replace(/\/services.*$/i, "")
          .replace(/\/+$/, ""),
        endpoint_tpl:
          process.env.MYSOLUTION_ENDPOINT ||
          "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}",
      }),
    };
  }

  /* ---------- DEBUG: key shape (no secrets) ---------- */
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

  /* ---------- DEBUG: key parse test ---------- */
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

  /* ---------- Simple GET “is alive” ---------- */
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

  /* ---------- POST flow ---------- */
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Parse body
  let fields = {};
  try {
    fields = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  // Accept vacatureID from body or id from query (and trim)
  const qsId = (event.queryStringParameters?.id || "").trim();
  const vacatureId = (fields.vacatureID || fields.vacancyId || fields.jobId || qsId || "").trim();
  const email = (fields.email || fields.Email || "").trim();
  const name = (fields.name || fields.Naam || "").trim();

  if (!vacatureId || !email || !name) {
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({
        error: "Missing required fields",
        needed: { vacatureID_or_id: !!vacatureId, email: !!email, name: !!name },
      }),
    };
  }

  // Split name into Voornaam / Tussenvoegsels / Achternaam
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

  // LinkedIn accepteren en mappen naar exact MySolution veld
  const linkedin =
    (fields.msf_Linkedin_URL_c || fields.msf__Linkedin_URL__c || fields.linkedin || fields.LinkedIn || "")
      .toString()
      .trim();

  // CV (optioneel): { fileName, contentType, base64 }
  const MAX_BYTES = 5 * 1024 * 1024; // 5MB
  const cv = fields.cv && typeof fields.cv === "object" ? fields.cv : null;
  if (cv) {
    const okShape = cv.fileName && cv.contentType && cv.base64;
    if (!okShape) {
      return { statusCode: 422, headers: baseHeaders, body: JSON.stringify({ error: "CV object invalid" }) };
    }
    // ~5MB check (base64->bytes)
    const approxBytes = Math.floor((cv.base64.length * 3) / 4);
    if (approxBytes > MAX_BYTES) {
      return { statusCode: 413, headers: baseHeaders, body: JSON.stringify({ error: "CV > 5MB" }) };
    }
  }

  // === WordPress-style payload + LinkedIn + CV ===
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
      ...(linkedin ? { FU_Linkedin_profiel__c: { value: linkedin } } : {}),
    },
    ...(cv ? { cv } : {}),
    ...(cv ? { attachments: [cv] } : {}), // extra kanalen voor compat.
    ...(cv ? { files: [cv] } : {}),
  };

  // Build target URL (env supports {vacatureId})
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // Debug echo (no upstream)
  const isDebug =
    (event.queryStringParameters && event.queryStringParameters.debug === "1") || fields.debug === "1";
  if (isDebug) {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify(
        {
          debug: true,
          url: targetUrl,
          msBody,
          note: "Echo van payload; verwijder debug=1 om upstream te posten.",
        },
        null,
        2
      ),
    };
  }

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

    const text = await upstream.text();

    if (!upstream.ok) {
      return { statusCode: upstream.status, headers: baseHeaders, body: text || JSON.stringify({ ok: false }) };
    }

    // ✅ Apex ok → stuur teammail (fout mag niet de response blokkeren)
    try {
      await notifyTeamEmail({ name, email, phone, linkedin, vacatureId, cv });
    } catch (mailErr) {
      console.warn("notifyTeamEmail failed:", mailErr);
    }

    return { statusCode: upstream.status, headers: baseHeaders, body: text || JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Upstream failure", detail: err?.message }) };
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
  if (b64) {
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
    const txt = await res.text();
    throw new Error(`Failed to fetch Salesforce JWT token (${res.status}): ${txt.slice(0, 800)}`);
  }

  const json = await res.json();
  _cachedToken = { access_token: json.access_token, instance_url: json.instance_url, exp: nowSeconds() + 600 };
  return _cachedToken;
}
