/**
 * CheapBeer — Cloudflare Worker
 *
 * Handles POST /submit:
 *  1. Verifies Cloudflare Turnstile token
 *  2. Appends the submission to a Google Sheet via Sheets API
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   TURNSTILE_SECRET_KEY  — from Cloudflare Turnstile dashboard
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — JSON key for a Google Service Account
 *                                  that has Editor access to the Sheet
 *   SHEET_ID  — Google Spreadsheet ID (from its URL)
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler deploy
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/submit') {
      return handleSubmit(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Submit handler ─────────────────────────────────────────────
async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, message: 'Invalid JSON.' }, 400);
  }

  const { bar_name, city, address, website, size_l, price_nok, turnstile_token } = body;

  // Validate required fields
  if (!bar_name || !city || !address || !size_l || !price_nok) {
    return jsonResponse({ success: false, message: 'Missing required fields.' }, 400);
  }

  // Sanitise numbers
  const price = parseInt(price_nok, 10);
  const size  = parseFloat(size_l);
  if (isNaN(price) || price < 1 || price > 999 || isNaN(size)) {
    return jsonResponse({ success: false, message: 'Invalid price or size.' }, 400);
  }

  // Length limits
  if (bar_name.length > 100 || city.length > 60 || address.length > 200) {
    return jsonResponse({ success: false, message: 'Input too long.' }, 400);
  }

  // Optional website — must be http/https if provided
  if (website && !isValidUrl(website)) {
    return jsonResponse({ success: false, message: 'Invalid website URL.' }, 400);
  }

  // Verify Turnstile token
  if (!turnstile_token) {
    return jsonResponse({ success: false, message: 'Missing verification token.' }, 400);
  }

  const verified = await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET_KEY, request);
  if (!verified) {
    return jsonResponse({ success: false, message: 'Verification failed. Please try again.' }, 403);
  }

  // Append to Google Sheet
  try {
    await appendToSheet(env, {
      bar_name: sanitizeText(bar_name),
      city: sanitizeText(city),
      address: sanitizeText(address),
      website: website || '',
      size_l: size,
      price_nok: price,
      price_per_litre: Math.round((price / size) * 10) / 10,
      approved: 'FALSE',
      last_verified: new Date().toISOString().slice(0, 10),
      submitted_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Sheet append failed:', err);
    return jsonResponse({ success: false, message: 'Could not save submission. Please try again later.' }, 500);
  }

  return jsonResponse({ success: true, message: 'Submission received. Thank you!' });
}

// ── Cloudflare Turnstile verification ─────────────────────────
async function verifyTurnstile(token, secret, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token, remoteip: ip }),
  });
  const data = await resp.json();
  return data.success === true;
}

// ── Google Sheets append ───────────────────────────────────────
async function appendToSheet(env, row) {
  const sheetId  = env.SHEET_ID;
  const keyJson  = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const token    = await getGoogleAccessToken(keyJson);
  const range    = 'submissions!A:K'; // adjust to match your sheet tab name

  const values = [[
    row.bar_name,
    row.website,
    row.address,
    '',             // maps_url (to be filled manually during review)
    row.city,
    row.size_l,
    row.price_nok,
    row.approved,
    row.last_verified,
    row.price_per_litre,
    row.submitted_at,
  ]];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Sheets API error ${resp.status}: ${err}`);
  }
}

// ── Google OAuth2 service account token ───────────────────────
async function getGoogleAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim  = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encoder = new TextEncoder();
  const headerB64  = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const claimB64   = btoa(JSON.stringify(claim)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const sigInput   = `${headerB64}.${claimB64}`;

  // Import the RSA private key
  const pemBody = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const derBuf  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0)).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', derBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${sigInput}.${sigB64}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Failed to obtain Google access token');
  return tokenData.access_token;
}

// ── Helpers ────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function sanitizeText(str) {
  return str.replace(/[<>]/g, '').trim();
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
