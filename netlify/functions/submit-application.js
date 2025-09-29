const ALLOWED_ORIGIN = "*";
const baseHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ ok: true, function: "submit-application" }),
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Parse JSON body
  let fields = {};
  try {
    fields = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  // Verplichte velden
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

  // Split name naar voornaam + achternaam
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");

  // Simpele payload naar MySolution
  const msBody = {
    vacancyId: vacatureId,
    candidate: {
      firstName,
      lastName,
      email,
    },
  };

  // Config uit Netlify environment variables
  const endpointTpl = process.env.MYSOLUTION_ENDPOINT;
  const apiKey = process.env.MYSOLUTION_API_KEY;

  if (!endpointTpl || !apiKey) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Server not configured" }) };
  }

  const url = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // DEBUG MODE: stuur ?debug=1 mee of {"debug":"1"} in body
  const isDebug =
    (event.queryStringParameters && event.queryStringParameters.debug === "1") || fields.debug === "1";
  if (isDebug) {
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({ debug: true, url, msBody }, null, 2),
    };
  }

  // Stuur door naar MySolution
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(msBody),
    });

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
      body: JSON.stringify({ error: "Upstream failure", detail: err.message }),
    };
  }
};
