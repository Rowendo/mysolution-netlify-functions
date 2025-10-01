// netlify/functions/submit-application.js

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// simple in-memory cache between cold starts
let _cachedToken = null; // { access_token, instance_url, exp }

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true, fn: "submit-application" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // parse JSON body
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

  // Build target Apex URL (env with {vacatureId} placeholder OR fallback to instance_url later)
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // Debug: echo url + body, skip upstream call
  const isDebug =
    (event.queryStringParameters && event.queryStringParameters.debug === "1") ||
    fields.debug === "1";
  if (isDebug) {
    return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ debug: true, url: targetUrl, msBody }, null, 2) };
  }

  try {
    // 1) OAuth token (get or refresh)
    const { access_token, instance_url } = await getSalesforceAccessToken();

    // 2) use explicit env endpoint if it already points to your domain,
    //    otherwise build from instance_url to be robust across orgs
    const apexUrl = /:\/\/[^/]*\.my\.salesforce\.com/i.test(targetUrl)
      ? targetUrl
      : `${instance_url.replace(/\/+$/,"")}/services/apexrest/msf/api/job/Apply?id=${encodeURIComponent(vacatureId)}`;

    // 3) call Apex REST
    let upstream = await fetch(apexUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
      body: JSON.stringify(msBody),
    });

    // retry once on 401 (expired token)
    if (upstream.status === 401) {
      invalidateTokenCache();
      const fresh = await getSalesforceAccessToken();
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

// ===== Helpers =====

function invalidateTokenCache() { _cachedToken = null; }

async function getSalesforceAccessToken() {
  const now = Date.now() / 1000;
  if (_cachedToken && _cachedToken.exp && _cachedToken.exp > now + 60) {
    return _cachedToken;
  }

  // Prefer override if you can't edit SF_LOGIN_URL in Netlify
  const loginUrlRaw =
    process.env.SF_LOGIN_URL_OVERRIDE ||
    process.env.SF_LOGIN_URL ||
    "https://login.salesforce.com";

  // normalize: remove any trailing `/` and any accidental `/services...`
  const loginUrl = loginUrlRaw.replace(/\/services.*$/i, "").replace(/\/+$/,"");

  const clientId     = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const username     = process.env.SF_USERNAME;
  const password     = process.env.SF_PASSWORD; // password + security token (concatenated)

  if (!loginUrl || !clientId || !clientSecret || !username || !password) {
    throw new Error("Salesforce OAuth env vars missing");
  }

  const form = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to fetch Salesforce token (${res.status}): ${txt.slice(0, 800)}`);
  }

  const json = await res.json(); // { access_token, instance_url, ... }
  const exp = Math.floor(Date.now() / 1000) + 7200; // ~2 hours
  _cachedToken = { access_token: json.access_token, instance_url: json.instance_url, exp };
  return _cachedToken;
}
