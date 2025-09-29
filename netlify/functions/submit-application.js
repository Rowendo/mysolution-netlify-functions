const multipart = require("parse-multipart");

const ALLOWED_ORIGIN = "*"; // production: vervang door je Framer domein
const baseHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  // Healthcheck / CORS preflight
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

  const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
  let fields = {};
  let cvBase64;
  let cvFilename;

  try {
    if (contentType.includes("multipart/form-data")) {
      const boundary = multipart.getBoundary(contentType);
      const bodyBuffer = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");
      const parts = multipart.Parse(bodyBuffer, boundary);

      for (const part of parts) {
        if (part.filename) {
          if (!cvBase64) {
            cvBase64 = part.data.toString("base64");
            cvFilename = part.filename;
          }
        } else if (part.name) {
          fields[part.name] = part.data.toString("utf8");
        }
      }
    } else {
      fields = JSON.parse(event.body || "{}");
      cvBase64 = fields.cvBase64;
      cvFilename = fields.cvFilename;
    }
  } catch (e) {
    return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  // --- minimale validatie
  const vacatureId = (fields.vacatureID || "").toString().trim();
  const email = (fields.email || "").toString().trim();
  const name = (fields.name || "").toString().trim();

  if (!vacatureId || !email || !name) {
    return {
      statusCode: 422,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Missing required fields", needed: { vacatureID: !!vacatureId, email: !!email, name: !!name } })
    };
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");

  // UTM verzamelen (uit hidden fields van je form)
  const utm = {
    source: fields.utm_source || "",
    medium: fields.utm_medium || "",
    campaign: fields.utm_campaign || "",
    term: fields.utm_term || "",
    content: fields.utm_content || "",
  };

  // --- payload richting MySolution (pas veldnamen aan indien nodig)
  const msBody = {
    vacancyId: vacatureId,
    candidate: {
      firstName: fields.firstName || firstName,
      lastName: fields.lastName || lastName,
      email,
      phone: fields.phone || "",
      linkedin: fields.linkedin || "",
      notes: fields.message || "",
      language: (fields.language || "nl").toLowerCase()
    },
    meta: {
      pageTitle: fields.page_title || "",
      pageUrl: fields.page_url || ""
    },
    utm, // <-- toegevoegd
  };

  if (cvBase64 && cvFilename) {
    msBody.cv = { filename: cvFilename, contentBase64: cvBase64 };
  }

  // --- config uit env vars
  const endpointTpl = process.env.MYSOLUTION_ENDPOINT; // bv: https://api.mysolution.nl/v1/applications/{vacatureId}
  const apiKey = process.env.MYSOLUTION_API_KEY;

  if (!endpointTpl || !apiKey) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: "Server not configured" }) };
  }

  const url = endpointTpl.replace("{vacatureId}", encodeURIComponent(vacatureId));

  // Kleine, veilige log voor troubleshooting (zie Netlify → Functions → Logs)
  console.log("[submit-application] POST", {
    vacancyId: vacatureId,
    email,
    hasCV: Boolean(cvBase64),
    utm,
  });

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(msBody)
    });

    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: baseHeaders,
      body: text || JSON.stringify({ ok: upstream.ok })
    };
  } catch (err) {
    console.error("[submit-application] Upstream failure:", err?.message);
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Upstream failure", detail: err.message })
    };
  }
};
