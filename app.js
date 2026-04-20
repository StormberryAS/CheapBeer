/* ================================================================
   CHEAPBEER — App logic
   - Fetches data from a published Google Sheets CSV
   - Renders a sortable, filterable table
   - Handles the submit form with Cloudflare Turnstile verification
================================================================ */

// ── Configuration ──────────────────────────────────────────────
// Replace these placeholders before deploying.
const CONFIG = {
  // Published Google Sheets CSV URL.
  // File > Share > Publish to web > CSV > Sheet "bars"
  sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTXeJMwLt9czfQ4eRuRIJfDMCcptRpiLG30tP_kp0ReZoWNoXuINFxJOzxu01T_LJGJintdLl9IuakL/pub?gid=0&single=true&output=csv',

  // Cloudflare Worker URL for form submission + Turnstile verification
  workerUrl: 'https://cheapbeer-worker.marcos-495.workers.dev/submit',
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
    const resp = await fetch(CONFIG.sheetCsvUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csv = await resp.text();
    allRows = parseCsv(csv);
    populateCityFilter();
    populateBarNameList();
    applyFiltersAndRender();
    showTableState('data');
  } catch (err) {
    showTableState('error', 'Could not load data. Please try again later.');
    console.error('CheapBeer: data load failed', err);
  }
}

// ── CSV parser ─────────────────────────────────────────────────
// Expected columns (first row = header):
//   bar_name, website, address, maps_url, city, size_l, price_nok, approved, last_verified
function parseCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length < headers.length) continue;

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim();
    });

    // Only show approved rows
    if (row.approved && row.approved.toUpperCase() !== 'TRUE') continue;

    const price = parseFloat(row.price_nok);
    const size = parseFloat(row.size_l);
    if (isNaN(price) || isNaN(size) || size === 0) continue;

    row.price_nok_num = price;
    row.size_l_num    = size;
    row.price_per_litre = Math.round((price / size) * 10) / 10;

    rows.push(row);
  }

  return rows;
}

// Handles quoted fields in CSV
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
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
function bindSubmitForm() {
  const form = document.getElementById('submit-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await handleSubmit();
  });
}

async function handleSubmit() {
  const btn = document.getElementById('submit-btn');
  const msgEl = document.getElementById('submit-msg');

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

  // Get Turnstile token
  const turnstileToken = getTurnstileToken();
  if (!turnstileToken) {
    showSubmitMsg(msgEl, 'error', 'Please complete the human verification above.');
    return;
  }

  btn.disabled = true;
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
    }
  } catch (err) {
    showSubmitMsg(msgEl, 'error', 'Could not reach the server. Please try again later.');
    console.error('CheapBeer: submit failed', err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="18" height="18">
        <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
      </svg>
      Submit price`;
  }
}

function showSubmitMsg(el, type, text) {
  el.textContent = text;
  el.className = 'submit-msg ' + type;
  el.hidden = false;
}

// ── Turnstile helpers ──────────────────────────────────────────
function getTurnstileToken() {
  // Turnstile sets a hidden input named "cf-turnstile-response" inside the widget
  const input = document.querySelector('[name="cf-turnstile-response"]');
  return input ? input.value : null;
}

function resetTurnstile() {
  if (window.turnstile) {
    window.turnstile.reset();
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
