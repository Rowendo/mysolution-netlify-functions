// netlify/functions/submit-application.js

// (optioneel voor lokaal 'netlify dev'; in Netlify zelf niet nodig)
// try { require("dotenv").config(); } catch {}

const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Eenvoudige in-memory token cache tussen invocations
let _cachedToken = null; // { access_token, instance_url, exp }

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

  // ---- body parsen (JSON) ----
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

  // ---- minimale validatie ----
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

  // Payload richting Apex REST (pas velden aan als jullie Apex iets anders verwacht)
  const msBody = {
    vacancyId: vacatureId,
    candidate: { firstName, lastName, email },
  };

  // Endpoint opbouwen (env var met {vacatureId} placeholder)
  const endpointTpl =
    process.env.MYSOLUTION_ENDPOINT ||
    "https://freelancersunited.my.salesforce.com/services/apexrest/msf/api/job/Apply?id={vacatureId}";
  const targetUrl = endpointTpl.replace(
    "{vacatureId}",
    encodeURIComponent(vacatureId)
  );

  // ---- DEBUG: echo URL + payload, geen upstream call ----
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
    // 1) OAuth token ophalen (of cache gebruiken)
    const { access_token, instance_url } = await getSalesforceAccessToken();

    // Je kunt targetUrl (met jullie domein) gebruiken,
    // of het via instance_url robuust opbouwen:
    const apexUrl = targetUrl.includes(".my.salesforce.com")
      ? targetUrl
      : `${instance_url}/services/apexrest/msf/api/job/Apply?id=${encodeURIComponent(
          vacatureId
        )}`;

    // 2) Call Apex REST
    let upstream = await fetch(apexUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify(msBody),
    });

    // 3) Eén retry bij 401 (token vervallen)
    if (upstream.status === 401) {
      invalidateTokenCache();
      const fresh = await getSalesforceAccessToken();
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
      statusCode: upstream.status, // geeft Salesforce status door (200/201 verwacht)
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

// ===== Helpers =====

function invalidateTokenCache() {
  _cachedToken = null;
}

async function getSalesforceAccessToken() {
  // Gebruik cache als token nog ~>1min geldig is
  const now = Date.now() / 1000;
  if (_cachedToken && _cachedToken.exp && _cachedToken.exp > now + 60) {
    return _cachedToken;
  }

  const loginUrl = process.env.SF_LOGIN_URL; // https://login.salesforce.com of https://test.salesforce.com
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const username = process.env.SF_USERNAME;
  const password = process.env.SF_PASSWORD; // wachtwoord + security token (aaneen)

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
    throw new Error(
      `Failed to fetch Salesforce token (${res.status}): ${txt.slice(0, 800)}`
    );
  }

  const json = await res.json();
  // json bevat: access_token, instance_url, id, issued_at, signature, token_type
  const exp = Math.floor(Date.now() / 1000) + 7200; // ~2 uur geldig
  _cachedToken = {
    access_token: json.access_token,
    instance_url: json.instance_url,
    exp,
  };
  return _cachedToken;
}
