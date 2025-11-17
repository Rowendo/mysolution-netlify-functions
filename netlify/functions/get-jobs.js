// netlify/functions/get-jobs.js

/* ============================
   GLOBAL HEADERS (CORS)
============================ */
const baseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
  "Content-Type": "application/json",
};

let _cachedToken = null;

/* ============================
   HELPERS
============================ */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readPrivateKeyPemFromEnv() {
  if (process.env.SF_JWT_PRIVATE_KEY) return process.env.SF_JWT_PRIVATE_KEY;

  if (process.env.SF_JWT_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.SF_JWT_PRIVATE_KEY_B64, "base64").toString("utf8");
  }

  return null;
}

function signJWT({ header, claims, privateKeyPem }) {
  const crypto = require("crypto");
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const data = `${encodedHeader}.${encodedClaims}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  const signature = sign.sign(privateKeyPem);
  const encodedSig = base64UrlEncode(signature);

  return `${data}.${encodedSig}`;
}

/* ============================
   FETCH SALESFORCE TOKEN (JWT)
============================ */
async function getSalesforceAccessTokenJWT() {
  if (_cachedToken && _cachedToken.exp > nowSeconds() + 30) {
    return _cachedToken;
  }

  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com")
    .replace(/\/services.*$/i, "")
    .replace(/\/+$/, "");

  const clientId = process.env.SF_CLIENT_ID;
  const subject = process.env.SF_JWT_SUBJECT;
  const privateKeyPem = readPrivateKeyPemFromEnv();

  if (!clientId || !subject || !privateKeyPem) {
    throw new Error("JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY");
  }

  const header = { alg: "RS256" };
  const claims = {
    iss: clientId,
    sub: subject,
    aud: loginUrl,
    exp: nowSeconds() + 120,
  };

  const assertion = signJWT({ header, claims, privateKeyPem });

  const tokenUrl = `${loginUrl}/services/oauth2/token`;

  const form = new URLSearchParams();
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.set("assertion", assertion);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("Failed to fetch Salesforce JWT token:", txt);
    throw new Error("JWT token fetch failed");
  }

  const json = await res.json();

  _cachedToken = {
    access_token: json.access_token,
    instance_url: json.instance_url,
    exp: nowSeconds() + 600,
  };

  return _cachedToken;
}

/* ============================
   SLUGIFY
============================ */
function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);
}

/* ============================
   MAIN NETLIFY HANDLER
============================ */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: baseHeaders, body: "" };
  }

  try {
    /* 1) TOKEN OPHALEN */
    const { access_token, instance_url } = await getSalesforceAccessTokenJWT();

    /* 2) ENDPOINT */
    const endpointTpl = process.env.MYSOLUTION_JOBS_ENDPOINT || "/services/apexrest/msf/api/job/Get";

    const targetUrl = /:\/\/[^/]*\.salesforce\.com/i.test(endpointTpl)
      ? endpointTpl
      : `${instance_url.replace(/\/+$/, "")}/${endpointTpl.replace(/^\/+/, "")}`;

    /* 3) VACATURES OPHALEN */
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("MySolution error:", txt);
      return {
        statusCode: 502,
        headers: baseHeaders,
        body: JSON.stringify({ error: "Failed to fetch jobs", details: txt }),
      };
    }

    const data = await res.json();
    const vacatures = Array.isArray(data) ? data : data.records || data;

    /* 4) MAPPEN NAAR JOUW STRUCTUUR */
    const jobs = vacatures
      .filter((v) => {
        const show = v.msf__Show_On_Website__c;
        if (show === undefined || show === null) return true;
        return ["true", true, 1, "1", "ja", "Ja"].includes(show);
      })
      .map((v) => {
        const vacatureId = v.msf__Job__c || v.Id || "";
        const title = v.vacaturetitel__c || "";
        const slug = `${slugify(title || "vacature")}-${vacatureId}`;

        return {
          id: vacatureId,
          slug,
          vacatureTitel: title,

          /* ---- Velden uit jouw tabel ---- */
          opWebsiteTonen: v.msf__Show_On_Website__c,
          vacatureID: v.msf__Job__c,
          locatie: v.msf__Work_Address_City__c,
          urenrange: v.FU_Urenrange_per_week__c,
          salarisMinimum: v.msf__Salary_from__c,
          salarisMaximum: v.msf__Salary_to__c,
          headerAfbeelding: v.FU_Header_afbeelding__c,
          introductie: v.FU_Korte_introductie_Tekst__c,

          jobHighlightTitel1: v.FU_Titel_Job_highlight_1__c,
          jobHighlightText1: v.FU_Tekst_job_highlight_1__c,
          jobHighlightTitel2: v.FU_Titel_Job_highlight_2__c,
          jobHighlightText2: v.FU_Tekst_job_highlight_2__c,
          jobHighlightTitel3: v.FU_Titel_Job_highlight_3__c,
          jobHighlightText3: v.FU_Tekst_Job_highlight_3__c,

          youGet1: v.FU_you_get_1__c,
          youGet2: v.FU_you_get_2__c,
          youGet3: v.FU_you_get_3__c,
          youGet4: v.FU_you_get_4__c,
          youGet5: v.FU_you_get_5__c,

          youAre1: v.FU_you_are_1__c,
          youAre2: v.FU_you_are_2__c,
          youAre3: v.FU_you_are_3__c,
          youAre4: v.FU_you_are_4__c,
          youAre5: v.FU_you_are_5__c,

          logoOpdrachtgever: v.FU_Afbeelding_logo_opdrachtgever__c,
          overOpdrachtgever: v.FU_Over_de_opdrachtgever__c,
        };
      });

    /* 5) RETURN JSON */
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify(jobs),
    };
  } catch (err) {
    console.error("ERROR in get-jobs:", err);
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({
        error: "Internal error in get-jobs",
        message: err.message,
      }),
    };
  }
};
