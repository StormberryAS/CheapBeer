/**
 * CheapBeer — Cloudflare Worker
 *
 * Handles POST /submit:
 *  1. Verifies Cloudflare Turnstile token
 *  2. Commits the submission (approved: false) to the first-party price list
 *     prices.json in the GitHub repo via the Contents API. No Google.
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   TURNSTILE_SECRET_KEY  — from Cloudflare Turnstile dashboard
 *   GITHUB_TOKEN          — fine-grained PAT scoped to Contents:read+write on
 *                            the StormberryAS/CheapBeer repo only
 * Optional vars (wrangler.toml [vars]; defaults shown):
 *   GH_OWNER=StormberryAS  GH_REPO=CheapBeer  GH_PATH=prices.json  GH_BRANCH=main
 *
 * Deploy:
 *   wrangler secret put TURNSTILE_SECRET_KEY
 *   wrangler secret put GITHUB_TOKEN
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

  // Commit the submission to the first-party price list on GitHub.
  try {
    await appendToGitHub(env, {
      bar_name: sanitizeText(bar_name),
      website: website || '',
      address: sanitizeText(address),
      maps_url: '',            // filled during review
      city: sanitizeText(city),
      size_l: size,
      price_nok: price,
      approved: false,         // new submissions await review
      last_verified: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error('GitHub commit failed:', err);
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

// ── GitHub commit (first-party price list) ─────────────────────
async function appendToGitHub(env, entry) {
  const owner  = env.GH_OWNER  || 'StormberryAS';
  const repo   = env.GH_REPO   || 'CheapBeer';
  const path   = env.GH_PATH   || 'prices.json';
  const branch = env.GH_BRANCH || 'main';
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'cheapbeer-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Read-modify-write with a small retry, in case two submissions race on the
  // same file sha (the second PUT would 409 until it re-reads the new sha).
  for (let attempt = 0; attempt < 4; attempt++) {
    const getResp = await fetch(`${api}?ref=${branch}`, { headers });
    if (!getResp.ok) throw new Error(`GitHub GET ${getResp.status}: ${await getResp.text()}`);
    const file = await getResp.json();
    const list = JSON.parse(decodeB64(file.content));
    if (!Array.isArray(list)) throw new Error('prices.json is not an array');

    list.push(entry);
    const putResp = await fetch(api, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add price submission: ${entry.bar_name} (${entry.city})`,
        content: encodeB64(JSON.stringify(list, null, 2) + '\n'),
        sha: file.sha,
        branch,
      }),
    });
    if (putResp.ok) return;
    if (putResp.status === 409) continue; // sha moved under us; re-read and retry
    throw new Error(`GitHub PUT ${putResp.status}: ${await putResp.text()}`);
  }
  throw new Error('GitHub commit failed after retries (sha kept changing)');
}

// ── UTF-8 aware base64 (Workers expose btoa/atob over binary strings) ──────
function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeB64(b64) {
  // GitHub returns base64 wrapped at 60 columns; strip the newlines first.
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
