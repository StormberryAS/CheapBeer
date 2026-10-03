// Offline tests for the CheapBeer submission Worker.  Run:  node test.mjs
//
// Same approach as the contact-form Worker's test.mjs: index.js is loaded
// through a data: URL, so this folder needs no package.json and nothing here
// affects how wrangler builds or deploys. fetch is mocked; any request other
// than Turnstile siteverify fails the test, which is how "never writes to
// GitHub" is checked.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, 'index.js'), 'utf8');
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const BASE = 'https://cheapbeer-worker.marcos-495.workers.dev';
const ORIGIN = 'https://beer.stormberry.as';
const IP = '203.0.113.7';

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push(['PASS', label]);
  } catch (err) {
    results.push(['FAIL', `${label} :: ${err.message}`]);
  }
}
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const good = {
  bar_name: 'Bar Bados',
  city: 'Oslo',
  address: 'Thorvald Meyers gate 30, 0555 Oslo',
  website: 'https://example.no/',
  size_l: 0.4,
  price_nok: 89,
  turnstile_token: 'tok',
};

function submit(over = {}, { origin = ORIGIN, raw, method = 'POST', path = '/submit' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP };
  if (origin) headers.Origin = origin;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: method === 'POST' ? (raw ?? JSON.stringify({ ...good, ...over })) : undefined,
  });
}

function fakeKv({ fail = false } = {}) {
  const puts = [];
  return {
    puts,
    async put(key, value, options) {
      if (fail) throw new Error(`kv down ${value}`);
      puts.push({ key, value, options });
    },
  };
}

const limiter = (success) => ({ calls: 0, async limit() { this.calls++; return { success }; } });

// Runs fn with fetch mocked. Returns every outbound URL. Siteverify answers
// `verified`; anything else is recorded and answered with a 599.
async function withFetch(fn, { verified = true } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    calls.push({ target, body: init && init.body });
    if (target === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return new Response(JSON.stringify({ success: verified }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 599 });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

async function captureLogs(fn) {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'warn', 'error', 'info']) {
    saved[k] = console[k];
    console[k] = (...a) => lines.push(a.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

function env(over = {}) {
  return {
    SUBMISSIONS: fakeKv(),
    TURNSTILE_SECRET_KEY: 'ts_test',
    CHEAPBEER_RATE_LIMIT_IP: limiter(true),
    CHEAPBEER_RATE_LIMIT_ALL: limiter(true),
    ...over,
  };
}

// ── Storage: private, never the public repository ───────────────

await check('a valid submission is stored in KV with an expiry, and nothing else is called', async () => {
  const e = env();
  let res;
  const calls = await withFetch(async () => {
    res = await worker.fetch(submit(), e);
  });
  eq(res.status, 200, 'status');
  eq((await res.json()).success, true, 'success');
  eq(e.SUBMISSIONS.puts.length, 1, 'KV puts');
  const { key, value, options } = e.SUBMISSIONS.puts[0];
  ok(/^sub-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(key), `key shape: ${key}`);
  eq(options.expirationTtl, 90 * 24 * 60 * 60, 'expirationTtl');
  const stored = JSON.parse(value);
  eq(stored.bar_name, 'Bar Bados', 'bar_name');
  eq(stored.price_nok, 89, 'price_nok');
  eq(stored.size_l, 0.4, 'size_l');
  eq(stored.website, 'https://example.no/', 'website');
  ok(!('approved' in stored), 'no approved flag is stored');
  ok(!('turnstile_token' in stored), 'token is not stored');
  ok(!value.includes(IP), 'IP address is not stored');
  ok(!Number.isNaN(Date.parse(stored.submitted_at)), 'submitted_at is a date');
  eq(calls.length, 1, 'outbound calls');
  eq(calls[0].target, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'only siteverify');
});

await check('index.js code (comments aside) has no GitHub path at all', async () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/github/i.test(code), 'GitHub is referenced in code');
});

await check('the old GitHub configuration cannot bring the old behaviour back', async () => {
  const e = env({
    SUBMISSIONS: undefined,
    GITHUB_TOKEN: 'ghp_old',
    GH_OWNER: 'StormberryAS',
    GH_REPO: 'CheapBeer',
    GH_PATH: 'prices.json',
    GH_BRANCH: 'main',
  });
  let res;
  const calls = await withFetch(async () => {
    await captureLogs(async () => {
      res = await worker.fetch(submit(), e);
    });
  });
  eq(res.status, 503, 'status');
  eq(calls.length, 0, 'outbound calls (not even siteverify)');
});

await check('a failing store answers 500 and logs neither the text nor the IP', async () => {
  const e = env({ SUBMISSIONS: fakeKv({ fail: true }) });
  let res;
  const logs = await captureLogs(async () => {
    await withFetch(async () => {
      res = await worker.fetch(submit({ bar_name: 'LOGMARKER Bar' }), e);
    });
  });
  eq(res.status, 500, 'status');
  ok(!logs.includes('LOGMARKER'), 'submission text reached the log');
  ok(!logs.includes(IP), 'IP reached the log');
});

// ── CORS and origin ────────────────────────────────────────────

await check('preflight from beer.stormberry.as is allowed for that origin only', async () => {
  const res = await worker.fetch(submit({}, { method: 'OPTIONS' }), env());
  eq(res.status, 204, 'status');
  eq(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
  eq(res.headers.get('Vary'), 'Origin', 'Vary');
});

await check('a POST answer carries the CheapBeer origin, never *', async () => {
  let res;
  await withFetch(async () => {
    res = await worker.fetch(submit(), env());
  });
  eq(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await check('another site is refused and gets no CORS header', async () => {
  for (const method of ['OPTIONS', 'POST']) {
    const e = env();
    let res;
    const calls = await withFetch(async () => {
      res = await worker.fetch(submit({}, { method, origin: 'https://evil.example' }), e);
    });
    eq(res.status, 403, `${method} status`);
    eq(res.headers.get('Access-Control-Allow-Origin'), null, `${method} ACAO`);
    eq(calls.length, 0, `${method} outbound calls`);
    eq(e.SUBMISSIONS.puts.length, 0, `${method} KV puts`);
  }
});

await check('a request with no Origin still has to pass Turnstile', async () => {
  const e = env();
  let res;
  await withFetch(async () => {
    res = await worker.fetch(submit({}, { origin: null }), e);
  }, { verified: false });
  eq(res.status, 403, 'status');
  eq(e.SUBMISSIONS.puts.length, 0, 'KV puts');
});

await check('wrong path is 404, wrong method is 405', async () => {
  eq((await worker.fetch(submit({}, { path: '/' }), env())).status, 404, 'path');
  eq((await worker.fetch(submit({}, { method: 'GET' }), env())).status, 405, 'GET');
});

// ── Personal data in free-text fields ───────────────────────────

const refused = [
  ['bar_name', 'Ola ola@example.com', /@ or an email address/],
  ['bar_name', 'Bar ＠ home', /@ or an email address/],
  ['address', 'see https://example.org/x', /web address/],
  ['address', 'www.example.com', /web address/],
  ['bar_name', 'Kroa.no', /web address/],
  ['city', 'Oslo, ring 95043789', /phone number/],
  ['address', 'Storgata 1, call +47 950 43 789', /phone number/],
  ['address', 'Storgata 1, 95 04 37 89', /phone number/],
  ['bar_name', 'Bar 950.43.789', /phone number/],
];
for (const [field, value, message] of refused) {
  await check(`refuses ${field} = ${JSON.stringify(value)} before Turnstile`, async () => {
    const e = env();
    let res;
    const calls = await withFetch(async () => {
      res = await worker.fetch(submit({ [field]: value }), e);
    });
    eq(res.status, 400, 'status');
    const body = await res.json();
    ok(message.test(body.message), `message: ${body.message}`);
    eq(calls.length, 0, 'outbound calls (token must not be spent)');
    eq(e.SUBMISSIONS.puts.length, 0, 'KV puts');
  });
}

const accepted = [
  ['address', 'Storgata 39, 0182 Oslo'],
  ['address', 'Strandgaten 15-17, 5013 Bergen'],
  ['address', 'Torggata 16 0183 Oslo'],
  ['address', 'Øvre Ole Bulls plass 3, 5012 Bergen'],
  ['address', 'St. Olavs gate 2, 7012 Trondheim'],
  ['bar_name', 'Ølhallen'],
  ['bar_name', 'St. Hanshaugen Pub'],
  ['bar_name', 'Bar & Co.'],
  ['city', 'Tromsø'],
  ['website', 'https://www.facebook.com/profile.php?id=100063612345678'],
  ['website', 'https://www.tiktok.com/@somebar'],
];
for (const [field, value] of accepted) {
  await check(`accepts ${field} = ${JSON.stringify(value)}`, async () => {
    const e = env();
    let res;
    await withFetch(async () => {
      res = await worker.fetch(submit({ [field]: value }), e);
    });
    eq(res.status, 200, `status (${(await res.clone().json()).message})`);
    eq(e.SUBMISSIONS.puts.length, 1, 'KV puts');
  });
}

// ── Other validation ────────────────────────────────────────────

const invalid = [
  ['website with a user name', { website: 'https://user:pw@example.no/' }],
  ['javascript: website', { website: 'javascript:alert(1)' }],
  ['website over 200 characters', { website: `https://example.no/${'a'.repeat(200)}` }],
  ['price 0', { price_nok: 0 }],
  ['price 1000', { price_nok: 1000 }],
  ['price 89.5', { price_nok: 89.5 }],
  ['price "89abc"', { price_nok: '89abc' }],
  ['size 0', { size_l: 0 }],
  ['size -0.5', { size_l: -0.5 }],
  ['size 12', { size_l: 12 }],
  ['missing city', { city: '' }],
  ['bar name as an object', { bar_name: { length: 3 } }],
  ['bar name over 100 characters', { bar_name: 'x'.repeat(101) }],
  ['missing token', { turnstile_token: '' }],
];
for (const [label, over] of invalid) {
  await check(`refuses ${label}`, async () => {
    const e = env();
    let res;
    const calls = await withFetch(async () => {
      res = await worker.fetch(submit(over), e);
    });
    eq(res.status, 400, 'status');
    eq(calls.length, 0, 'outbound calls');
    eq(e.SUBMISSIONS.puts.length, 0, 'KV puts');
  });
}

await check('malformed and oversized bodies are refused', async () => {
  for (const [raw, status] of [['{', 400], ['null', 400], ['[]', 400], ['"x"', 400], [`{"a":"${'x'.repeat(5000)}"}`, 413]]) {
    const res = await worker.fetch(submit({}, { raw }), env());
    eq(res.status, status, `status for ${raw.slice(0, 10)}`);
  }
});

await check('text is tidied: angle brackets removed, spaces collapsed', async () => {
  const e = env();
  await withFetch(async () => {
    await worker.fetch(submit({ bar_name: '  Bar   <b>Bados</b> ' }), e);
  });
  eq(JSON.parse(e.SUBMISSIONS.puts[0].value).bar_name, 'Bar bBados/b', 'bar_name');
});

// ── Rate limits and Turnstile ───────────────────────────────────

await check('per-IP limit answers 429 before Turnstile, keyed on the IP', async () => {
  const e = env({ CHEAPBEER_RATE_LIMIT_IP: limiter(false) });
  let res;
  const calls = await withFetch(async () => {
    await captureLogs(async () => {
      res = await worker.fetch(submit(), e);
    });
  });
  eq(res.status, 429, 'status');
  eq(calls.length, 0, 'outbound calls');
  eq(e.SUBMISSIONS.puts.length, 0, 'KV puts');
});

await check('overall limit answers 429 too', async () => {
  const e = env({ CHEAPBEER_RATE_LIMIT_ALL: limiter(false) });
  let res;
  await withFetch(async () => {
    await captureLogs(async () => {
      res = await worker.fetch(submit(), e);
    });
  });
  eq(res.status, 429, 'status');
});

await check('the limiter is asked with the IP and with "all"', async () => {
  const keys = [];
  const spy = { async limit({ key }) { keys.push(key); return { success: true }; } };
  await withFetch(async () => {
    await worker.fetch(submit(), env({ CHEAPBEER_RATE_LIMIT_IP: spy, CHEAPBEER_RATE_LIMIT_ALL: spy }));
  });
  eq(keys.join(','), `${IP},all`, 'keys');
});

await check('a broken limiter does not take submissions down, and the log has no IP', async () => {
  const broken = { async limit() { throw new Error('limiter fault'); } };
  const e = env({ CHEAPBEER_RATE_LIMIT_IP: broken });
  let res;
  const logs = await captureLogs(async () => {
    await withFetch(async () => {
      res = await worker.fetch(submit(), e);
    });
  });
  eq(res.status, 200, 'status');
  ok(!logs.includes(IP), 'IP reached the log');
});

await check('failed Turnstile answers 403 and stores nothing', async () => {
  const e = env();
  let res;
  await withFetch(async () => {
    res = await worker.fetch(submit(), e);
  }, { verified: false });
  eq(res.status, 403, 'status');
  eq(e.SUBMISSIONS.puts.length, 0, 'KV puts');
});

await check('siteverify is sent the secret, the token and the IP', async () => {
  const calls = await withFetch(async () => {
    await worker.fetch(submit(), env());
  });
  const sent = JSON.parse(calls[0].body);
  eq(sent.secret, 'ts_test', 'secret');
  eq(sent.response, 'tok', 'response');
  eq(sent.remoteip, IP, 'remoteip');
});

for (const [state, label] of results) console.log(`${state}  ${label}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
