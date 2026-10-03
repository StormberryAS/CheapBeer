/**
 * CheapBeer submission Worker (Cloudflare)
 *
 * POST /submit, in this order:
 *  1. A browser request from any origin other than https://beer.stormberry.as
 *     is refused, and only that origin gets CORS headers.
 *  2. Field checks. The free-text fields (bar name, city, address) are refused
 *     if they contain an @, a web address or a long run of digits, because
 *     those are most likely an email address, a link or a phone number.
 *  3. Rate limits (Worker-native ratelimit bindings, per IP and overall).
 *  4. Cloudflare Turnstile verification.
 *  5. The submission is stored PRIVATELY in Workers KV, pending review, and
 *     expires on its own after PENDING_TTL_DAYS if nobody reviews it.
 *
 * Nothing is published by this Worker. Until 2026-10-02 it committed every
 * submission, unreviewed, to the PUBLIC repository StormberryAS/CheapBeer,
 * where git history kept it for good. That code path is deleted, the Worker
 * holds no GitHub credential, and if the KV binding is missing it refuses the
 * submission (503) rather than falling back to anything. Approved entries reach
 * the public price list only when Marcos copies them into prices.json with
 * tools/review_submissions.py and commits that file himself (see README.md).
 *
 * Bindings (wrangler.toml):
 *   SUBMISSIONS                kv     private store for pending submissions
 *   CHEAPBEER_RATE_LIMIT_IP    ratelimit  per source IP
 *   CHEAPBEER_RATE_LIMIT_ALL   ratelimit  all sources together
 *   TURNSTILE_SECRET_KEY       secret (wrangler secret put TURNSTILE_SECRET_KEY)
 *
 * No IP address, User-Agent or other request detail is stored, and log lines
 * never carry the submitted text or the IP.
 *
 * Tests: node test.mjs (from this folder; no dependencies).
 */

const ALLOWED_ORIGIN = 'https://beer.stormberry.as';

// Unreviewed submissions delete themselves after this long.
const PENDING_TTL_DAYS = 90;

// A real submission is a few hundred bytes.
const MAX_BODY_BYTES = 4096;

const LIMITS = { bar_name: 100, city: 60, address: 200, website: 200 };

// The free-text fields, with the label used in error messages.
const FREE_TEXT = [
  ['bar_name', 'bar name'],
  ['city', 'city'],
  ['address', 'address'],
];

// Likely personal data in a free-text field.
//   AT_RE      an @, including the full-width form, so any email address.
//   LINK_RE    a scheme (https://, ftp://), "www.", or a host name ending in a
//              common top-level domain (example.no, bar-name.com).
//   DIGITS_RE  eight or more digits, single spaces or dots allowed between them:
//              "95043789", "950 43 789", "+47 95 04 37 89". A house number and a
//              postcode ("Storgata 39, 0182 Oslo", "Gate 12 5003") stay well
//              under eight.
const AT_RE = /[@＠]/;
const LINK_RE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:no|com|net|org|io|info|biz|eu|me|co|app|dev|se|dk|fi|uk|de|nu|xyz|online|site|link|ly)\b)/i;
const DIGITS_RE = /\d(?:[ . ]?\d){7,}/;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    // A browser on another site gets no CORS headers, so it cannot read the
    // response; refusing the POST as well stops a "simple" cross-site request
    // from being processed at all. Requests with no Origin (curl, scripts) are
    // still gated by Turnstile and the rate limits.
    const origin = request.headers.get('Origin');
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ success: false, message: 'Forbidden.' }, 403, cors);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/submit') {
      return new Response('Not found', { status: 404, headers: cors });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    return handleSubmit(request, env, cors);
  },
};

// ── Submit handler ─────────────────────────────────────────────
async function handleSubmit(request, env, cors) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse({ success: false, message: 'Submission too large.' }, 413, cors);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ success: false, message: 'Invalid JSON.' }, 400, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ success: false, message: 'Invalid JSON.' }, 400, cors);
  }

  const checked = validate(body);
  if (checked.error) {
    return jsonResponse({ success: false, message: checked.error }, 400, cors);
  }

  const token = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
  if (!token) {
    return jsonResponse({ success: false, message: 'Missing verification token.' }, 400, cors);
  }

  // Refuse before any work is done if there is nowhere private to put it.
  // There is deliberately no fallback.
  if (!env.SUBMISSIONS || typeof env.SUBMISSIONS.put !== 'function') {
    console.error('SUBMISSIONS KV binding is missing; submission refused');
    return jsonResponse({ success: false, message: 'Submissions are paused. Please try again later.' }, 503, cors);
  }

  // Before the Turnstile round trip, so a flood costs nothing outbound.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overRateLimit(env.CHEAPBEER_RATE_LIMIT_IP, ip, 'per-IP') ||
      await overRateLimit(env.CHEAPBEER_RATE_LIMIT_ALL, 'all', 'overall')) {
    return jsonResponse({ success: false, message: 'Too many submissions. Please wait a minute and try again.' }, 429, cors);
  }

  if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, ip))) {
    return jsonResponse({ success: false, message: 'Verification failed. Please try again.' }, 403, cors);
  }

  const now = new Date();
  const entry = { ...checked.entry, submitted_at: now.toISOString() };
  const key = `sub-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomHex(4)}`;
  try {
    await env.SUBMISSIONS.put(key, JSON.stringify(entry), {
      expirationTtl: PENDING_TTL_DAYS * 24 * 60 * 60,
    });
  } catch (err) {
    // The error text could quote the value, so only its type is logged.
    console.error('Storing a submission failed:', err && err.name ? err.name : 'error');
    return jsonResponse({ success: false, message: 'Could not save submission. Please try again later.' }, 500, cors);
  }

  return jsonResponse({ success: true, message: 'Submission received. Thank you!' }, 200, cors);
}

// Returns { entry } or { error } with a message fit to show the visitor.
function validate(body) {
  const entry = {};

  for (const [field] of FREE_TEXT) {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) {
      return { error: 'Missing required fields.' };
    }
  }
  if (body.size_l === undefined || body.size_l === null || body.size_l === '' ||
      body.price_nok === undefined || body.price_nok === null || body.price_nok === '') {
    return { error: 'Missing required fields.' };
  }

  for (const [field, label] of FREE_TEXT) {
    const value = body[field].trim();
    if (value.length > LIMITS[field]) return { error: 'Input too long.' };
    const problem = personalDataProblem(value, label);
    if (problem) return { error: problem };
    entry[field] = sanitizeText(value);
  }

  const price = Number(body.price_nok);
  const size = Number(body.size_l);
  if (!Number.isInteger(price) || price < 1 || price > 999 ||
      !Number.isFinite(size) || size < 0.1 || size > 9.9) {
    return { error: 'Invalid price or size.' };
  }
  entry.size_l = Math.round(size * 100) / 100;
  entry.price_nok = price;

  let website = '';
  if (body.website !== undefined && body.website !== null && body.website !== '') {
    if (typeof body.website !== 'string' || body.website.trim().length > LIMITS.website) {
      return { error: 'Invalid website URL.' };
    }
    website = body.website.trim();
    if (website && !isValidWebsite(website)) {
      return { error: 'Invalid website URL.' };
    }
  }
  entry.website = website;

  return { entry };
}

function personalDataProblem(value, label) {
  if (AT_RE.test(value)) {
    return `The ${label} cannot contain an @ or an email address.`;
  }
  if (LINK_RE.test(value)) {
    return `The ${label} cannot contain a web address. Put the bar's website in the website field.`;
  }
  if (DIGITS_RE.test(value)) {
    return `The ${label} cannot contain a phone number or another long number.`;
  }
  return '';
}

// ── Rate limiting ──────────────────────────────────────────────
// Same pattern as the contact-form Worker: a missing or failing limiter is
// logged, not fatal. Log lines carry the label only, never the key (an IP).
async function overRateLimit(limiter, key, label) {
  if (!limiter || typeof limiter.limit !== 'function') {
    console.warn(`Rate limiter ${label} is not bound; request not limited`);
    return false;
  }
  try {
    const { success } = await limiter.limit({ key });
    if (!success) console.warn(`Rate limit ${label} exceeded`);
    return !success;
  } catch (err) {
    console.error(`Rate limiter ${label} failed:`, String(err));
    return false;
  }
}

// ── Cloudflare Turnstile verification ─────────────────────────
async function verifyTurnstile(token, secret, ip) {
  if (!secret) {
    console.error('TURNSTILE_SECRET_KEY is not set');
    return false;
  }
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip === 'unknown' ? undefined : ip }),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification request failed');
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────
function corsHeaders(request) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Responses differ by Origin, so caches must not share them.
    'Vary': 'Origin',
  };
  if (request.headers.get('Origin') === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return headers;
}

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function sanitizeText(str) {
  return str.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

// The website field is a link by design, so the link and digit rules do not
// apply (a Facebook page id is a long number, a TikTok handle has an @). It
// must be http(s) and must not carry a user name or password.
function isValidWebsite(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
