// netlify/functions/submit-application.js
const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  // Always show which env vars are visible to the function (no secrets leaked)
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
};
