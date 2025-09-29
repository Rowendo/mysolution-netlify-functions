const multipart = require("parse-multipart");

const ALLOWED_ORIGIN = "*";
const baseHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: baseHeaders, body: "" };
  if (event.httpMethod === "GET")    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true, function: "submit-application" }) };
  if (event.httpMethod !== "POST")   return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: "Method not allowed" }) };

  const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
  let fields = {}; let cvBase64; let cvFilename;

  try {
    if (contentType.includes("multipart/form-data")) {
      const boundary = multipart.getBoundary(contentType);
      const bodyBuffer = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");
      const parts = multipart.Parse(bodyBuffer, boundary);
      for (const part of parts) {
        if (part.filename) { if (!cvBase64) { cvBase64 = part.data.toString("base64"); cvFilename = part.filename; } }
        else if (part.name) { fields[part.name] = part.data.toString("utf8"); }
      }
    } else {
      fields = JSON.parse(event.body || "{}");
      cvBase64 = fields.cvBase64; cvFilename = fields.cvFilename;
    }
  } catch {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  const vacatureId = (fields.vacatureID || "").toString().trim();
  const email = (fields.email || "").toString().trim();
  const name = (fields.name || "").toString().trim();
  const linkedin = (fields.linkedin || "").toString().trim();

  if (!vacatureId || !email || !name /* || !linkedin */) {
    return { statusCode: 422, headers: baseHeaders, body: JSON.stringify({ error: "Missing required fields", needed: { vacatureID: !!vacatureId, email: !!email, name: !!name /*, linkedin: !!linkedin */ } }) };
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");
  const utm = {
    source: fields.utm_source || "",
    medium: fields.utm_medium || "",
    campaign: fields.utm_campaign || "",
    term: fields.utm_term || "",
    content: fields.utm_content || "",
  };

  const msBody = {
    vacancyId: vacatureId,
    candidate: {
      firstName: fields.firstName || firstName,
      lastName:  fields.lastName  || lastName,
      email,
      phone: fields.phone || "",
      // kies één van deze twee keys afhankelijk van MS:
      linkedinUrl: linkedin || fields.linkedinUrl || "",
      // linkedin: linkedin || "",
      notes: fields.message || "",
      language: (fields.language || "nl").toLowerCase(),
    },
    meta: { pageTitle: fields.page_title || "", pageUrl: fields.page_url || "" },
    utm,
  };
  if (cvBase64 && cvFilename) msBody.cv = { filename: cvFilename, contentBase64: cvBase64 };

  const endpointTpl = process.env.MYSOLUTION_ENDPOINT || ""; // bv: https://api.mysolution.nl/v1/vacancies/{vacatureId}/applications
  const apiKey = process.env.MYSOLUTION_API_KEY || "";
  if (!endpointTpl || !apiKey) return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Server not configured" }) };

  const url = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // 🔎 DEBUG MODE — geen upstream call; echo wat we zouden sturen
  const isDebug = (event.queryStringParameters && event.queryStringParameters.debug === "1") || fields.debug === "1";
  if (isDebug) {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({
      debug: true,
      url,
      headers: maskAuthHeaders(buildAuthHeaders(apiKey)),
      msBody
    }, null, 2) };
  }

  // Upstream call — met flexibele headers
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders(apiKey) },
      body: JSON.stringify(msBody),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return { statusCode: 502, headers: baseHeaders, body: JSON.stringify({ error: "MySolution error", status: upstream.status, body: text.slice(0, 2000) }) };
    }
    return { statusCode: 200, headers: baseHeaders, body: text || JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Upstream failure", detail: err?.message }) };
  }
};

// ===== Helpers =====
// Standaard: Authorization: Bearer <token>. Aanpasbaar via env vars:
//   MYSOLUTION_AUTH_HEADER_NAME  (default: "Authorization")
//   MYSOLUTION_AUTH_SCHEME       (default: "Bearer")  -> zet "" als je raw token wilt
//   MYSOLUTION_EXTRA_HEADERS     (JSON string), bv: {"x-tenant":"acme-nl"}
function buildAuthHeaders(token) {
  const name   = (process.env.MYSOLUTION_AUTH_HEADER_NAME || "Authorization").trim();
  const scheme = (process.env.MYSOLUTION_AUTH_SCHEME || "Bearer").trim();
  const value  = scheme ? `${scheme} ${token}` : token;
  let headers = { [name]: value };
  if (process.env.MYSOLUTION_EXTRA_HEADERS) {
    try { headers = { ...headers, ...JSON.parse(process.env.MYSOLUTION_EXTRA_HEADERS) }; } catch {}
  }
  return headers;
}
function maskAuthHeaders(h) {
  const out = { ...h };
  for (const k of Object.keys(out)) if (typeof out[k] === "string") out[k] = out[k].slice(0, 12) + "…";
  return out;
}
