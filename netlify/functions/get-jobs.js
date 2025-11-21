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
   GENERIC HELPERS
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
   TEXT / HTML HELPERS
============================ */
function stripHtml(str) {
  if (!str) return "";
  return String(str)
    // bewaar simpele regelafbrekingen
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    // overige tags weg
    .replace(/<[^>]+>/g, "")
    // html entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function cleanText(val) {
  return stripHtml(val);
}

function formatCurrencyEUR(val) {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val).trim();

  // Als Salesforce al "€" meestuurt, niets veranderen
  if (str.includes("€")) return str;

  // Proberen te parsen als getal
  const numeric = Number(str.replace(/\./g, "").replace(/,/g, "."));
  if (!isNaN(numeric)) {
    return `€ ${numeric}`;
  }

  // Fallback: gewoon "€ " ervoor zetten
  return `€ ${str}`;
}

function formatUrenRange(val) {
  if (val === null || val === undefined || val === "") return "";
  let txt = cleanText(val);
  // verwijder euroteken + eventuele spatie
  txt = txt.replace(/€\s*/g, "");
  return txt.trim();
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
    throw new Error("JWT env vars missing: SF_CLIENT_ID / SF_JWT_SUBJECT / SF_JWT_PRIVATE_KEY(_B64)");
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
    const txt = await res.text().catch(() => "");
    console.error("Failed to fetch Salesforce JWT token:", res.status, txt.slice(0, 800));
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
   MAIN NETLIFY HANDLER
============================ */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: baseHeaders, body: "" };
  }

  try {
    // 1) JWT token ophalen
    const { access_token, instance_url } = await getSalesforceAccessTokenJWT();

    // 2) Jobs endpoint bepalen
    const endpointTpl =
      process.env.MYSOLUTION_JOBS_ENDPOINT || "/services/apexrest/msf/api/job/Get";

    const targetUrl = /:\/\/[^/]*\.salesforce\.com/i.test(endpointTpl)
      ? endpointTpl
      : `${instance_url.replace(/\/+$/, "")}/${endpointTpl.replace(/^\/+/, "")}`;

    // 3) Vacatures ophalen
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("MySolution job GET failed:", res.status, txt.slice(0, 800));
      return {
        statusCode: 502,
        headers: baseHeaders,
        body: JSON.stringify({
          error: "Failed to fetch jobs from MySolution",
          status: res.status,
        }),
      };
    }

    const data = await res.json();
    const vacatures = Array.isArray(data) ? data : data.records || data;

    /* ============================
       RECRUITERS OPHALEN (User)
       op basis van msf__Recruiter__c
    ============================ */
    const recruiterIdSet = new Set();

    for (const v of vacatures) {
      const rid = v.msf__Recruiter__c;
      if (rid) recruiterIdSet.add(rid);
    }

    let recruiterById = {};

    if (recruiterIdSet.size > 0) {
      const recruiterIds = Array.from(recruiterIdSet);

      const soql = `
        SELECT Id, Name, Email, Phone, MobilePhone, SmallPhotoUrl, foto_website__c
        FROM User
        WHERE Id IN (${recruiterIds.map((id) => `'${id}'`).join(",")})
      `;

      const queryUrl = `${instance_url.replace(
        /\/+$/,
        ""
      )}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;

      const userRes = await fetch(queryUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${access_token}`,
        },
      });

      if (!userRes.ok) {
        const txt = await userRes.text().catch(() => "");
        console.error("User query failed:", userRes.status, txt.slice(0, 800));
      } else {
        const userJson = await userRes.json();
        const users = userJson.records || [];

        recruiterById = users.reduce((acc, u) => {
          acc[u.Id] = {
            name: u.Name || "",
            email: u.Email || "",
            phone: u.MobilePhone || u.Phone || "",
            // 🔹 gebruik foto_website__c, anders fallback naar SmallPhotoUrl
            photoUrl: u.foto_website__c || u.SmallPhotoUrl || "",
          };
          return acc;
        }, {});
      }
    }

    /* ============================
       VACATURES FILTEREN & MAPPEN
    ============================ */
    const jobs = vacatures
      // FILTER FASE
      .filter((v) => {
        // 1) Vervulde vacatures nooit tonen
        const status = (v.FU_Vacature_vervuld__c || "").toString().toLowerCase();
        if (status === "vervuld") return false;

        // 2) Show_On_Website check
        const show = v.msf__Show_On_Website__c;
        if (show === undefined || show === null) return true;

        return ["true", true, 1, "1", "ja", "Ja"].includes(show);
      })

      // MAPPING FASE
      .map((v) => {
        const vacatureId = v.msf__Job__c || v.Id || "";
        // ✅ juiste veld voor vacaturetitel
        const vacatureTitelRaw = v.FU_vacaturetitel__c || "";
        const vacatureTitel = cleanText(vacatureTitelRaw);

        const slug = slugify(vacatureTitel || "vacature");

        // Recruiter uit map halen
        const recruiterId = v.msf__Recruiter__c;
        const recruiter = recruiterId ? recruiterById[recruiterId] || {} : {};

        return {
          id: vacatureId,
          slug,
          vacatureTitel,

          statusVacature: cleanText(v.FU_Vacature_vervuld__c),

          opWebsiteTonen: v.msf__Show_On_Website__c,
          vacatureID: v.msf__Job__c,

          // ✅ bedrijf vanuit msf__Account__c
          bedrijf: cleanText(v.msf__Account__c),

          locatie: cleanText(v.msf__Work_Address_City__c),
          urenrange: formatUrenRange(v.FU_Urenrange_per_week__c),

          salarisMinimum: formatCurrencyEUR(v.msf__Salary_from__c),
          salarisMaximum: formatCurrencyEUR(v.msf__Salary_to__c),

          headerAfbeelding: v.FU_Header_afbeelding__c,
          introductie: cleanText(v.FU_Korte_introductie_Tekst__c),

          jobHighlightTitel1: cleanText(v.FU_Titel_Job_highlight_1__c),
          jobHighlightText1: cleanText(v.FU_Tekst_job_highlight_1__c),
          jobHighlightTitel2: cleanText(v.FU_Titel_Job_highlight_2__c),
          jobHighlightText2: cleanText(v.FU_Tekst_job_highlight_2__c),
          jobHighlightTitel3: cleanText(v.FU_Titel_Job_highlight_3__c),
          jobHighlightText3: cleanText(v.FU_Tekst_Job_highlight_3__c),

          youGet1: cleanText(v.FU_you_get_1__c),
          youGet2: cleanText(v.FU_you_get_2__c),
          youGet3: cleanText(v.FU_you_get_3__c),
          youGet4: cleanText(v.FU_you_get_4__c),
          youGet5: cleanText(v.FU_you_get_5__c),

          youAre1: cleanText(v.FU_you_are_1__c),
          youAre2: cleanText(v.FU_you_are_2__c),
          youAre3: cleanText(v.FU_you_are_3__c),
          youAre4: cleanText(v.FU_you_are_4__c),
          youAre5: cleanText(v.FU_you_are_5__c),

          logoOpdrachtgever: v.FU_Afbeelding_logo_opdrachtgever__c,
          overOpdrachtgever: cleanText(v.FU_Over_de_opdrachtgever__c),

          // 🔹 Contactpersoon vanuit User (met foto_website__c)
          contactNaam: recruiter.name || "",
          contactEmail: recruiter.email || "",
          contactTelefoon: recruiter.phone || "",
          contactAfbeelding: recruiter.photoUrl || "",
        };
      });

    // 5) JSON response
    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify(jobs),
    };
  } catch (err) {
    console.error("get-jobs error:", err);
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
