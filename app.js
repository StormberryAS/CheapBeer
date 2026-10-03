/* ================================================================
   CHEAPBEER — App logic
   - Reads the price list from a first-party prices.json (same origin,
     committed in this repo; no Google, nothing third-party)
   - Renders a sortable, filterable table
   - Handles the submit form with Cloudflare Turnstile verification.
     Turnstile is loaded only when the visitor starts using the form,
     never with the page.
================================================================ */

// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
  // First-party price list, served from this app's own origin. Submissions
  // are held privately and reach this file only after review (README.md).
  dataUrl: 'prices.json',

  // Cloudflare Worker URL for form submission + Turnstile verification
  workerUrl: 'https://cheapbeer-worker.marcos-495.workers.dev/submit',

  // Turnstile script, explicit rendering. Loaded on first use of the form.
  turnstileScript: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=cheapbeerTurnstileLoaded',

  // How long a submit waits for the spam check before giving up.
  turnstileWaitMs: 30000,
};

// ── Data & state ───────────────────────────────────────────────
let allRows = [];        // Parsed, approved rows from the sheet
let filteredRows = [];   // After city/size filter
let sortKey = 'price_per_litre';
let sortAsc = true;

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setDefaultSort();
  bindTableHeaders();
  bindFilters();
  bindSubmitForm();
  loadData();
});

// ── Data loading ───────────────────────────────────────────────
async function loadData() {
  showTableState('loading');

  try {
    const resp = await fetch(CONFIG.dataUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    allRows = parseRows(data);
    populateCityFilter();
    populateBarNameList();
    applyFiltersAndRender();
    showTableState('data');
  } catch (err) {
    showTableState('error', 'Could not load data. Please try again later.');
    console.error('CheapBeer: data load failed', err);
  }
}

// ── Price-list parser ──────────────────────────────────────────
// prices.json is an array of objects:
//   { bar_name, website, address, maps_url, city, size_l, price_nok, approved, last_verified }
// approved is a boolean (legacy "TRUE"/"FALSE" strings are also accepted).
function parseRows(data) {
  if (!Array.isArray(data)) return [];

  const rows = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;

    // Only show approved rows
    const approved = entry.approved === true || String(entry.approved).toUpperCase() === 'TRUE';
    if (!approved) continue;

    const price = parseFloat(entry.price_nok);
    const size = parseFloat(entry.size_l);
    if (isNaN(price) || isNaN(size) || size === 0) continue;

    const row = {
      bar_name: entry.bar_name || '',
      website: entry.website || '',
      address: entry.address || '',
      maps_url: entry.maps_url || '',
      city: entry.city || '',
      last_verified: entry.last_verified || '',
      price_nok_num: price,
      size_l_num: size,
      price_per_litre: Math.round((price / size) * 10) / 10,
    };

    rows.push(row);
  }

  return rows;
}

// ── Filter & sort ──────────────────────────────────────────────
function applyFiltersAndRender() {
  const cityVal = document.getElementById('city-filter').value.toLowerCase();

  filteredRows = allRows.filter(row => {
    if (cityVal && row.city.toLowerCase() !== cityVal) return false;
    return true;
  });

  sortRows();
  renderTable();
  updateStats();
}

function sortRows() {
  filteredRows.sort((a, b) => {
    let av, bv;
    switch (sortKey) {
      case 'price':
        av = a.price_nok_num; bv = b.price_nok_num; break;
      case 'price_per_litre':
        av = a.price_per_litre; bv = b.price_per_litre; break;
      case 'size_l':
        av = a.size_l_num; bv = b.size_l_num; break;
      case 'bar_name':
        av = a.bar_name.toLowerCase(); bv = b.bar_name.toLowerCase(); break;
      default:
        return 0;
    }
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    return 0;
  });
}

// ── Table rendering ────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('beer-tbody');
  tbody.innerHTML = '';

  if (filteredRows.length === 0) {
    showTableState('error', 'No bars found matching your filters.');
    return;
  }

  filteredRows.forEach(row => {
    const tr = document.createElement('tr');

    // Bar name + optional "Best value" badge
    const tdBar = document.createElement('td');
    tdBar.className = 'td-bar col-bar';
    if (row.website) {
      const a = document.createElement('a');
      a.href = sanitizeUrl(row.website);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = row.bar_name;
      tdBar.appendChild(a);
    } else {
      tdBar.textContent = row.bar_name;
    }
    tr.appendChild(tdBar);

    // City + address (address on second line, small)
    const tdCity = document.createElement('td');
    tdCity.className = 'col-city';
    tdCity.textContent = row.city;
    if (row.address) {
      const addr = document.createElement('div');
      addr.className = 'td-address';
      if (row.maps_url) {
        const a = document.createElement('a');
        a.href = sanitizeUrl(row.maps_url);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = row.address;
        addr.appendChild(a);
      } else {
        addr.textContent = row.address;
      }
      tdCity.appendChild(addr);
    }
    tr.appendChild(tdCity);

    // Size
    const tdSize = document.createElement('td');
    tdSize.className = 'td-size col-size';
    tdSize.textContent = row.size_l_num + ' L';
    tr.appendChild(tdSize);

    // Price
    const tdPrice = document.createElement('td');
    tdPrice.className = 'td-price col-price';
    tdPrice.textContent = row.price_nok_num + ' kr';
    tr.appendChild(tdPrice);

    // Price per litre
    const tdPpl = document.createElement('td');
    tdPpl.className = 'td-ppl col-ppl';
    tdPpl.textContent = row.price_per_litre.toFixed(1) + ' kr';
    tr.appendChild(tdPpl);

    // Last verified
    const tdUpd = document.createElement('td');
    tdUpd.className = 'td-updated col-updated';
    tdUpd.textContent = formatDate(row.last_verified);
    tr.appendChild(tdUpd);

    tbody.appendChild(tr);
  });
}

// ── Stats bar ──────────────────────────────────────────────────
function updateStats() {
  const statsBar = document.getElementById('stats-bar');
  const statsCount = document.getElementById('stats-count');
  const statsUpdated = document.getElementById('stats-updated');

  if (filteredRows.length === 0) {
    statsBar.hidden = true;
    return;
  }

  statsCount.textContent = filteredRows.length + (filteredRows.length === 1 ? ' bar' : ' bars');

  // Find most recent last_verified
  const dates = filteredRows
    .map(r => r.last_verified)
    .filter(Boolean)
    .sort()
    .reverse();
  if (dates.length) {
    statsUpdated.textContent = 'Last updated: ' + formatDate(dates[0]);
  }

  statsBar.hidden = false;
}

// ── Bar name datalist population ──────────────────────────────
function populateBarNameList() {
  const dl = document.getElementById('bar-names-list');
  const names = [...new Set(allRows.map(r => r.bar_name).filter(Boolean))].sort();
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  });
}

// ── City filter population ─────────────────────────────────────
function populateCityFilter() {
  const select = document.getElementById('city-filter');
  const cities = [...new Set(allRows.map(r => r.city).filter(Boolean))].sort();

  cities.forEach(city => {
    const opt = document.createElement('option');
    opt.value = city.toLowerCase();
    opt.textContent = city;
    select.appendChild(opt);
  });
}

// ── Table state toggling ───────────────────────────────────────
function showTableState(state, message = '') {
  const loading = document.getElementById('table-loading');
  const error   = document.getElementById('table-error');
  const wrapper = document.getElementById('table-wrapper');

  loading.hidden = state !== 'loading';
  error.hidden   = state !== 'error';
  wrapper.hidden = state !== 'data';

  if (state === 'error') error.textContent = message;
}

// ── Bind UI interactions ───────────────────────────────────────
function setDefaultSort() {
  const th = document.querySelector('[data-sort="price_per_litre"]');
  if (th) {
    th.classList.add('active-sort');
    th.setAttribute('aria-sort', 'ascending');
  }
}

function bindTableHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = true;
      }

      // Update aria + active class on headers
      document.querySelectorAll('th.sortable').forEach(el => {
        el.classList.remove('active-sort');
        el.removeAttribute('aria-sort');
      });
      th.classList.add('active-sort');
      th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');

      // Sync dropdown
      const dd = document.getElementById('sort-select');
      if (dd) dd.value = sortKey;

      sortRows();
      renderTable();
    });
  });
}

function bindFilters() {
  document.getElementById('city-filter').addEventListener('change', applyFiltersAndRender);
  document.getElementById('sort-select').addEventListener('change', e => {
    sortKey = e.target.value;
    sortAsc = true;
    sortRows();
    renderTable();
  });
}

// ── Submit form ────────────────────────────────────────────────
let submitBtnHtml = '';
let submitting = false;

function bindSubmitForm() {
  const form = document.getElementById('submit-form');
  submitBtnHtml = document.getElementById('submit-btn').innerHTML;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    try {
      await handleSubmit();
    } finally {
      submitting = false;
    }
  });

  // Nothing is fetched from Cloudflare until the visitor starts using the
  // form: the first focus on any of its fields, or the first input.
  const start = () => {
    form.removeEventListener('focusin', start);
    form.removeEventListener('input', start);
    loadTurnstile();
  };
  form.addEventListener('focusin', start);
  form.addEventListener('input', start);
}

async function handleSubmit() {
  const btn = document.getElementById('submit-btn');
  const msgEl = document.getElementById('submit-msg');

  // Covers a browser that submits without focusing anything in the form.
  loadTurnstile();

  // Basic client-side validation
  const barName  = document.getElementById('f-bar').value.trim();
  const city     = document.getElementById('f-city').value.trim();
  const address  = document.getElementById('f-address').value.trim();
  const website  = document.getElementById('f-website').value.trim();
  const size = parseFloat(document.getElementById('f-size').value);
  const priceRaw = document.getElementById('f-price').value.trim();

  if (!barName || !city || !address || !size || !priceRaw) {
    showSubmitMsg(msgEl, 'error', 'Please fill in all required fields.');
    return;
  }

  const price = parseInt(priceRaw, 10);
  if (isNaN(size) || size <= 0) {
    showSubmitMsg(msgEl, 'error', 'Please enter a valid glass size (e.g. type 4 for 0.4 L).');
    return;
  }
  if (isNaN(price) || price < 1 || price > 999) {
    showSubmitMsg(msgEl, 'error', 'Price must be a whole number between 1 and 999 NOK.');
    return;
  }

  if (website && !isValidUrl(website)) {
    showSubmitMsg(msgEl, 'error', 'Website URL is not valid.');
    return;
  }

  btn.disabled = true;

  // The spam check starts when the form is first used, so a quick visitor can
  // get here before it has finished. Wait for it rather than refusing.
  let turnstileToken = turnstileState.token;
  if (!turnstileToken) {
    btn.textContent = 'Checking…';
    showSubmitMsg(msgEl, 'info', 'One moment: the spam check is still running. If a checkbox appears above the button, tick it.');
    turnstileToken = await waitForTurnstileToken(CONFIG.turnstileWaitMs);
    if (!turnstileToken) {
      showSubmitMsg(msgEl, 'error', turnstileState.loadFailed
        ? 'The spam check could not load. Check your connection and try again.'
        : 'The spam check did not finish. Please try again.');
      btn.disabled = false;
      btn.innerHTML = submitBtnHtml;
      return;
    }
  }

  btn.textContent = 'Sending…';
  msgEl.hidden = true;

  try {
    const payload = {
      bar_name: barName,
      city,
      address,
      website,
      size_l: parseFloat(size),
      price_nok: price,
      turnstile_token: turnstileToken,
    };

    const resp = await fetch(CONFIG.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (resp.ok && data.success) {
      showSubmitMsg(msgEl, 'success', 'Thank you! Your submission is pending review.');
      document.getElementById('submit-form').reset();
      resetTurnstile();
    } else {
      const msg = data.message || `Server error (${resp.status}). Please try again.`;
      showSubmitMsg(msgEl, 'error', msg);
      // A 400 is refused before the Worker checks the token, so the token is
      // still good. Anything else may have spent it: get a fresh one.
      if (resp.status !== 400) resetTurnstile();
    }
  } catch (err) {
    showSubmitMsg(msgEl, 'error', 'Could not reach the server. Please try again later.');
    console.error('CheapBeer: submit failed', err);
    resetTurnstile();
  } finally {
    btn.disabled = false;
    btn.innerHTML = submitBtnHtml;
  }
}

function showSubmitMsg(el, type, text) {
  el.textContent = text;
  el.className = 'submit-msg ' + type;
  el.hidden = false;
}

// ── Turnstile, loaded on first use of the form ─────────────────
// Someone who only reads the price list never contacts
// challenges.cloudflare.com: the script is added to the page, and the widget
// rendered, the first time the visitor focuses or types in the form.
const turnstileState = {
  started: false,     // script tag added
  loadFailed: false,  // script could not be fetched, or the widget not rendered
  widgetId: null,
  token: null,        // current unspent token, from the widget's callback
  waiters: [],        // submits waiting for a token
};

function loadTurnstile() {
  if (turnstileState.started) return;
  turnstileState.started = true;
  turnstileState.loadFailed = false;
  window.cheapbeerTurnstileLoaded = renderTurnstile;
  const script = document.createElement('script');
  script.src = CONFIG.turnstileScript;
  script.async = true;
  script.onerror = () => {
    // Allow the next submit to try again, for example after a dropped connection.
    script.remove();
    turnstileState.started = false;
    turnstileState.loadFailed = true;
    settleTurnstile(null);
  };
  document.head.appendChild(script);
}

function renderTurnstile() {
  const box = document.getElementById('turnstile-box');
  try {
    turnstileState.widgetId = window.turnstile.render(box, {
      sitekey: box.dataset.sitekey,
      theme: 'dark',
      callback: token => {
        turnstileState.token = token;
        settleTurnstile(token);
      },
      'expired-callback': () => { turnstileState.token = null; },
      // Turnstile retries on its own; a waiting submit gives up on its timer.
      'error-callback': () => { turnstileState.token = null; },
    });
  } catch (err) {
    turnstileState.loadFailed = true;
    settleTurnstile(null);
    console.error('CheapBeer: Turnstile render failed', err);
  }
}

function settleTurnstile(token) {
  const waiting = turnstileState.waiters;
  turnstileState.waiters = [];
  waiting.forEach(done => done(token));
}

function waitForTurnstileToken(ms) {
  if (turnstileState.token) return Promise.resolve(turnstileState.token);
  if (turnstileState.loadFailed) return Promise.resolve(null);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      turnstileState.waiters = turnstileState.waiters.filter(w => w !== done);
      resolve(null);
    }, ms);
    function done(token) {
      clearTimeout(timer);
      resolve(token);
    }
    turnstileState.waiters.push(done);
  });
}

function resetTurnstile() {
  turnstileState.token = null;
  if (window.turnstile && turnstileState.widgetId !== null) {
    window.turnstile.reset(turnstileState.widgetId);
  }
}

// ── Utility helpers ────────────────────────────────────────────
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  if (isNaN(d)) return str;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function sanitizeUrl(url) {
  if (!url) return '#';
  try {
    const u = new URL(url);
    // Only allow http and https
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '#';
    return u.toString();
  } catch {
    return '#';
  }
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
