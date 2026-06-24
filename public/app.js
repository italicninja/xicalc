/* ═══════════════════════════════════════════════════════════
   FFXI Craft Calculator — client
   Recipes/items/prices come from the API (DB seeded from
   LandSandBoat + PSXI auction-house prices). The profit math is
   unchanged from the original single-file app; only the data
   source moved server-side. User-entered prices persist in
   localStorage.
═══════════════════════════════════════════════════════════ */

/* ── craft display metadata (icons/colours/order) ─────────── */
const CRAFTS = [
  { id: 'Clothcraft',   icon: '🧵' },
  { id: 'Goldsmithing', icon: '🔩' },
  { id: 'Smithing',     icon: '⚒'  },
  { id: 'Leathercraft', icon: '🟫' },
  { id: 'Alchemy',      icon: '⚗️' },
  { id: 'Cooking',      icon: '🍳' },
  { id: 'Woodworking',  icon: '🪵' },
  { id: 'Bonecraft',    icon: '🦴' },
];

/* ── state ────────────────────────────────────────────────── */
let craftCounts = {};
let currentCraft = null;
let currentRecipes = [];   // list for the selected craft
let selectedRecipe = null; // full detail object
let recipeFilter = '';
let prices = loadPrices();  // itemName/key → price (user + seeded)
let breakRate = 0;
let synthsPerHr = 120;
let hoursPerSess = 1;

/* ── persistence ──────────────────────────────────────────── */
function loadPrices() {
  try { return JSON.parse(localStorage.getItem('xicalc_prices') || '{}'); }
  catch { return {}; }
}
function savePrices() {
  try { localStorage.setItem('xicalc_prices', JSON.stringify(prices)); } catch {}
}

/* ── api ──────────────────────────────────────────────────── */
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/* ── escaping ─────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── init ─────────────────────────────────────────────────── */
async function init() {
  try {
    const { crafts } = await getJSON('/api/crafts');
    craftCounts = crafts;
  } catch (e) {
    document.getElementById('main').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠</div><div class="empty-title">Could not reach the server</div><div class="empty-sub">${esc(e.message)}</div></div>`;
    return;
  }

  const nav = document.getElementById('craft-nav');
  nav.innerHTML = '';
  CRAFTS.forEach((c) => {
    const count = craftCounts[c.id] || 0;
    const btn = document.createElement('button');
    btn.className = 'craft-btn';
    btn.dataset.craft = c.id;
    btn.innerHTML = `<span class="craft-icon">${c.icon}</span>${c.id}<span class="craft-count">${count}</span>`;
    btn.onclick = () => selectCraft(c.id);
    nav.appendChild(btn);
  });

  loadMeta();
}

async function loadMeta() {
  try {
    const h = await getJSON('/healthz');
    const seeded = h.lastSeedAt ? new Date(h.lastSeedAt).toLocaleDateString() : '—';
    const scraped = h.lastScrapeAt ? new Date(h.lastScrapeAt).toLocaleString() : 'never';
    document.getElementById('sidebar-meta').innerHTML =
      `${h.recipes.toLocaleString()} recipes<br>seeded ${esc(seeded)}<br>AH sync: ${esc(scraped)}`;
  } catch {}
}

async function selectCraft(craftId) {
  currentCraft = craftId;
  selectedRecipe = null;
  recipeFilter = '';
  document.querySelectorAll('.craft-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.craft === craftId));
  document.getElementById('main').innerHTML =
    `<div class="empty"><div class="empty-icon">⏳</div><div class="empty-title">Loading ${esc(craftId)}…</div></div>`;
  try {
    const { recipes } = await getJSON(`/api/recipes?craft=${encodeURIComponent(craftId)}`);
    currentRecipes = recipes;
  } catch (e) {
    currentRecipes = [];
  }
  renderMain();
}

async function selectRecipeByIndex(i) {
  const r = visibleRecipes()[i];
  if (!r) return;
  try {
    selectedRecipe = await getJSON(`/api/recipes/${r.id}`);
  } catch (e) {
    return;
  }
  prefillPrices(selectedRecipe);
  renderMain();
}

/* Seed prices from AH (preferred) without overwriting user-entered values. */
function ahValue(ah) {
  if (!ah) return null;
  return ah.median ?? ah.last ?? null;
}
function prefillPrices(r) {
  const crystalKey = `${r.crystal} Crystal`;
  if (prices[crystalKey] == null) {
    const v = ahValue(r.crystalAh);
    if (v != null) prices[crystalKey] = v;
  }
  r.ingredients.forEach((ing) => {
    if (prices[ing.name] == null) {
      const v = ahValue(ing.ah);
      if (v != null) prices[ing.name] = v;
    }
  });
  const sellKey = `__sell_${r.name}`;
  if (prices[sellKey] == null) {
    const v = ahValue(r.resultAh) ?? r.npcSell;
    if (v != null) prices[sellKey] = v;
  }
  savePrices();
}

/* ── recipe list helpers ──────────────────────────────────── */
function visibleRecipes() {
  if (!recipeFilter) return currentRecipes;
  const q = recipeFilter.toLowerCase();
  return currentRecipes.filter((r) => r.name.toLowerCase().includes(q));
}

/* ── render main ──────────────────────────────────────────── */
function renderMain() {
  const main = document.getElementById('main');
  if (!currentCraft) {
    main.innerHTML = `<div class="empty"><div class="empty-icon">⚒</div><div class="empty-title">Choose a craft to begin</div><div class="empty-sub">Select a guild from the sidebar</div></div>`;
    return;
  }
  const meta = CRAFTS.find((c) => c.id === currentCraft) || { icon: '⚒' };
  const list = visibleRecipes();

  let html = `<div class="page-head"><div class="page-title">${meta.icon} ${esc(currentCraft)}</div>`;
  html += `<div class="page-desc">${currentRecipes.length} recipes · prices prefill from HorizonXI AH, override freely</div></div>`;
  html += `<div class="recipe-search"><input type="text" id="recipe-filter" placeholder="Search recipes…" value="${esc(recipeFilter)}"></div>`;
  html += `<div class="recipe-list" id="recipe-list">`;
  list.forEach((r, i) => {
    const sel = selectedRecipe && selectedRecipe.id === r.id ? ' selected' : '';
    const subs = (r.subcrafts || []).map((s) => `<span class="tag sub">${esc(s.craft)} ${s.cap}</span>`).join('');
    html += `<div class="recipe-card${sel}" data-idx="${i}">
      <div class="rc-name">${esc(r.name)}</div>
      <div class="rc-meta"><span class="tag">${esc(r.crystal)} · ${r.cap}</span>${subs}</div>
      ${r.npcSell ? `<div class="rc-npc">NPC ${r.npcSell.toLocaleString()} gil</div>` : ''}
    </div>`;
  });
  html += `</div>`;
  html += `<div id="calc-area">${selectedRecipe ? buildCalc(selectedRecipe) : ''}</div>`;
  main.innerHTML = html;

  // wire list interactions
  const filter = document.getElementById('recipe-filter');
  filter.addEventListener('input', (e) => {
    recipeFilter = e.target.value;
    rerenderList();
  });
  wireList();
  wireCalc();
}

function rerenderList() {
  const listEl = document.getElementById('recipe-list');
  const list = visibleRecipes();
  let html = '';
  list.forEach((r, i) => {
    const sel = selectedRecipe && selectedRecipe.id === r.id ? ' selected' : '';
    const subs = (r.subcrafts || []).map((s) => `<span class="tag sub">${esc(s.craft)} ${s.cap}</span>`).join('');
    html += `<div class="recipe-card${sel}" data-idx="${i}">
      <div class="rc-name">${esc(r.name)}</div>
      <div class="rc-meta"><span class="tag">${esc(r.crystal)} · ${r.cap}</span>${subs}</div>
      ${r.npcSell ? `<div class="rc-npc">NPC ${r.npcSell.toLocaleString()} gil</div>` : ''}
    </div>`;
  });
  listEl.innerHTML = html;
  wireList();
}

function wireList() {
  document.querySelectorAll('#recipe-list .recipe-card').forEach((card) => {
    card.addEventListener('click', () => selectRecipeByIndex(Number(card.dataset.idx)));
  });
}

/* ── build calculator markup ──────────────────────────────── */
function priceRow(label, qtyTxt, key, ah, npcSell) {
  const val = prices[key] != null ? prices[key] : '';
  const ahv = ahValue(ah);
  const hint = ahv != null
    ? `<span class="ah-hint" data-applykey="${esc(key)}" data-applyval="${ahv}">AH ${ahv.toLocaleString()}${ah.stock != null ? ` · ${ah.stock} stk` : ''}</span>`
    : (npcSell ? `<span class="npc-hint">vendor ${npcSell.toLocaleString()}</span>` : '');
  return `<div class="ing-row">
    <div class="ing-label">${esc(label)} ${qtyTxt}${hint}</div>
    <div class="ing-input"><input type="number" min="0" value="${val}" data-pricekey="${esc(key)}" placeholder="price"><span class="ing-unit">ea</span></div>
  </div>`;
}

function buildCalc(r) {
  const subs = (r.subcrafts || []).map((s) => `<span class="tag sub">${esc(s.craft)} ${s.cap}</span>`).join(' ');
  let yieldStr = `NQ: ${r.yield}`;
  if (r.hqYield && r.hqYield !== r.yield) yieldStr += ` · HQ1: ${r.hqYield}`;
  if (r.hq2Yield && r.hq2Yield !== r.hqYield) yieldStr += ` · HQ2: ${r.hq2Yield}`;
  if (r.hq3Yield && r.hq3Yield !== r.hq2Yield) yieldStr += ` · HQ3: ${r.hq3Yield}`;

  let html = `<div class="calc-panel">
    <div class="calc-title">${esc(r.name)}</div>
    <div class="calc-subtitle">${esc(r.crystal)} Crystal · Cap ${r.cap} · ${yieldStr} ${subs}</div>
    <div class="ing-grid">`;

  // crystal
  html += priceRow(`${r.crystal} Crystal`, `<span class="ing-qty">×1</span>`, `${r.crystal} Crystal`, r.crystalAh, null);

  // ingredients
  r.ingredients.forEach((ing) => {
    html += priceRow(ing.name, `<span class="ing-qty">×${ing.qty}</span>`, ing.name, ing.ah, ing.npcSell);
  });
  html += `</div>`;

  // sell price + break rate
  const sellKey = `__sell_${r.name}`;
  const sellVal = prices[sellKey] != null ? prices[sellKey] : (ahValue(r.resultAh) ?? r.npcSell ?? 0);
  const sellHint = ahValue(r.resultAh) != null
    ? `AH ${ahValue(r.resultAh).toLocaleString()}`
    : (r.npcSell ? `NPC ${r.npcSell.toLocaleString()}` : 'enter price');
  html += `<div class="break-row">
    <span class="break-label">Sell price / unit <span style="font-size:11px;color:var(--gold-dim)">(${esc(sellHint)})</span></span>
    <div class="break-input"><input type="number" min="0" value="${sellVal}" data-sellkey="${esc(sellKey)}"> <span style="font-size:11px;color:var(--text-faint);font-family:var(--mono)">gil/unit</span></div>
  </div>
  <div class="break-row">
    <span class="break-label">Break rate</span>
    <div class="break-input"><input type="number" min="0" max="100" value="${breakRate}" data-field="break"> <span style="font-size:11px;color:var(--text-faint);font-family:var(--mono)">%</span></div>
  </div></div>`;

  html += buildResults(r);
  html += buildGPH(r);
  return html;
}

/* ── calculations (unchanged math) ────────────────────────── */
function calcCosts(r) {
  const crystalPrice = prices[`${r.crystal} Crystal`] || 0;
  let matCost = crystalPrice;
  r.ingredients.forEach((ing) => {
    const p = prices[ing.name] != null ? prices[ing.name] : 0;
    matCost += p * ing.qty;
  });
  return matCost;
}

function sellPrice(r) {
  const k = `__sell_${r.name}`;
  return prices[k] != null ? prices[k] : (ahValue(r.resultAh) ?? r.npcSell ?? 0);
}

function buildResults(r) {
  const matCost = calcCosts(r);
  const sellEa = sellPrice(r);
  const br = breakRate / 100;
  const expectedYield = r.yield * (1 - br);
  const costPerUnit = expectedYield > 0 ? matCost / expectedYield : Infinity;
  const profitPerSynth = sellEa * expectedYield - matCost;
  const breakeven = expectedYield > 0 ? matCost / expectedYield : 0;

  let rows = `<tr><td>${esc(r.crystal)} Crystal ×1</td><td>${fmt(prices[`${r.crystal} Crystal`] || 0)}</td></tr>`;
  r.ingredients.forEach((ing) => {
    const p = prices[ing.name] != null ? prices[ing.name] : 0;
    rows += `<tr><td>${esc(ing.name)} ×${ing.qty}</td><td>${fmt(p * ing.qty)}</td></tr>`;
  });
  rows += `<tr class="total-row"><td>Total per synth</td><td>${fmt(matCost)}</td></tr>`;

  const cls = profitPerSynth > 0 ? 'pos' : profitPerSynth < 0 ? 'neg' : 'dim';
  return `<div class="calc-panel">
    <div class="results-row">
      <div class="stat-card"><div class="stat-label">Mat cost / synth</div><div class="stat-value">${fmt(matCost)}</div></div>
      <div class="stat-card"><div class="stat-label">Cost / unit</div><div class="stat-value">${costPerUnit === Infinity ? '—' : fmt(costPerUnit)}</div></div>
      <div class="stat-card"><div class="stat-label">Profit / synth</div><div class="stat-value ${cls}">${profitPerSynth >= 0 ? '+' : ''}${fmt(profitPerSynth)}</div></div>
      <div class="stat-card"><div class="stat-label">Break-even price</div><div class="stat-value dim">${fmt(breakeven)}</div></div>
    </div>
    <table class="breakdown"><tbody>${rows}</tbody></table>
    ${r.npcSell ? `<div class="note">NPC resale: ${r.npcSell.toLocaleString()} gil · ${profitPerSynth > 0 ? 'Profitable at current prices' : `Need ${Math.ceil(breakeven).toLocaleString()} gil/unit to break even`}</div>` : ''}
  </div>`;
}

function buildGPH(r) {
  const matCost = calcCosts(r);
  const sellEa = sellPrice(r);
  const br = breakRate / 100;
  const expectedYield = r.yield * (1 - br);
  const profitPerSynth = sellEa * expectedYield - matCost;
  const profitPerHr = profitPerSynth * synthsPerHr;
  const sessionGil = profitPerHr * hoursPerSess;
  const cls = profitPerHr > 0 ? 'pos' : profitPerHr < 0 ? 'neg' : 'dim';

  return `<div class="calc-panel">
    <div class="calc-title" style="font-size:0.95rem;margin-bottom:0.75rem">Gil per hour</div>
    <div class="gph-row">
      <div class="gph-input"><label>Synths / hour</label><input type="number" min="1" value="${synthsPerHr}" data-field="sph"></div>
      <div class="gph-input"><label>Hours / session</label><input type="number" min="0.1" step="0.1" value="${hoursPerSess}" data-field="hours"></div>
    </div>
    <div class="results-row">
      <div class="stat-card"><div class="stat-label">Profit / synth</div><div class="stat-value ${cls}">${profitPerSynth >= 0 ? '+' : ''}${fmt(profitPerSynth)}</div></div>
      <div class="stat-card"><div class="stat-label">Gil / hour</div><div class="stat-value ${cls}">${fmt(profitPerHr)}</div></div>
      <div class="stat-card"><div class="stat-label">Session synths</div><div class="stat-value dim">${Math.round(synthsPerHr * hoursPerSess).toLocaleString()}</div></div>
      <div class="stat-card"><div class="stat-label">Session gil</div><div class="stat-value ${cls}">${sessionGil >= 0 ? '+' : ''}${fmt(sessionGil)}</div></div>
    </div>
    <div class="note">Synth rate varies by recipe complexity. Desynthing runs ~136/hr; high-level gear synths are slower (~80–100/hr) due to longer animations and menu time.</div>
  </div>`;
}

/* ── wire calc inputs (event delegation, no inline handlers) ─ */
function wireCalc() {
  const area = document.getElementById('calc-area');
  if (!area) return;

  area.querySelectorAll('input[data-pricekey]').forEach((inp) => {
    inp.addEventListener('change', () => {
      prices[inp.dataset.pricekey] = parseFloat(inp.value) || 0;
      savePrices();
      renderCalcArea();
    });
  });
  area.querySelectorAll('input[data-sellkey]').forEach((inp) => {
    inp.addEventListener('change', () => {
      prices[inp.dataset.sellkey] = parseFloat(inp.value) || 0;
      savePrices();
      renderCalcArea();
    });
  });
  area.querySelectorAll('input[data-field]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (inp.dataset.field === 'break') breakRate = v || 0;
      if (inp.dataset.field === 'sph') synthsPerHr = v || 120;
      if (inp.dataset.field === 'hours') hoursPerSess = v || 1;
      renderCalcArea();
    });
  });
  area.querySelectorAll('.ah-hint[data-applykey]').forEach((el) => {
    el.addEventListener('click', () => {
      prices[el.dataset.applykey] = Number(el.dataset.applyval);
      savePrices();
      renderCalcArea();
    });
  });
}

function renderCalcArea() {
  const area = document.getElementById('calc-area');
  if (!area || !selectedRecipe) return;
  area.innerHTML = buildCalc(selectedRecipe);
  wireCalc();
}

function fmt(n) {
  if (n === Infinity || isNaN(n)) return '—';
  return Math.round(n).toLocaleString() + ' gil';
}

init();
