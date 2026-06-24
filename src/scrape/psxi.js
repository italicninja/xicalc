import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDb, getMeta, setMeta } from '../db.js';

/*
 * PSXI (psxi.gg) HorizonXI auction-house sync.
 *
 * PSXI is a React SPA backed by same-origin JSON endpoints (discovered by
 * inspecting its bundles). Two are used here, both keyed by the canonical FFXI
 * item id — which matches our `items.id` exactly:
 *
 *   GET /s/{server}/ah/search?q={name}
 *       -> { results: [{ id, name, stock, price, ... }] }   (current listing)
 *   GET /s/{server}/ah/recent-transactions[?after={id}]
 *       -> { transactions: [{ id, itemId, price, isStack, sellDate, ... }] }
 *
 * There is no official API; this is best-effort and gated by PSXI_SCRAPE_ENABLED.
 */

const SOURCE = 'psxi';

function ahBase() {
  return `${config.psxi.baseUrl}/s/${config.psxi.server}/ah`;
}

async function fetchJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.psxi.requestTimeoutMs);
  try {
    const res = await fetch(`${ahBase()}${path}`, {
      headers: { 'User-Agent': config.psxi.userAgent, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unitPrice(price, isStack, stackSize) {
  if (!price) return null;
  if (isStack && stackSize > 1) return Math.round(price / stackSize);
  return price;
}

// ── current listings via search (resumable, stalest-first) ───────
function refreshListings(db, log) {
  // Items used by recipes, ordered so the least-recently-priced come first.
  const items = db
    .prepare(
      `SELECT i.id, i.display_name, i.stack_size, ap.fetched_at
       FROM items i
       JOIN (
         SELECT item_id AS id FROM recipe_ingredients
         UNION SELECT result_item_id FROM recipes
       ) used ON used.id = i.id
       LEFT JOIN ah_prices ap ON ap.item_id = i.id AND ap.source = ?
       WHERE i.auctionable = 1
       ORDER BY (ap.fetched_at IS NOT NULL), ap.fetched_at ASC
       LIMIT ?`
    )
    .all(SOURCE, config.psxi.maxItemsPerRun);

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO ah_prices (item_id, source, last_price, stock, fetched_at)
    VALUES (@item_id, @source, @last_price, @stock, @fetched_at)
    ON CONFLICT(item_id, source) DO UPDATE SET
      last_price = excluded.last_price,
      stock = excluded.stock,
      fetched_at = excluded.fetched_at
  `);
  const histInsert = db.prepare(`
    INSERT INTO ah_price_history (item_id, source, price, stock, kind, fetched_at)
    VALUES (?, ?, ?, ?, 'listing', ?)
  `);

  const touched = new Set();
  let priced = 0;
  let errors = 0;

  return (async () => {
    for (const it of items) {
      try {
        const j = await fetchJson(`/search?q=${encodeURIComponent(it.display_name)}`);
        const match = (j.results || []).find((r) => r.id === it.id);
        const price = match ? match.price ?? null : null;
        const stock = match ? match.stock ?? 0 : 0;
        upsert.run({
          item_id: it.id,
          source: SOURCE,
          last_price: price,
          stock,
          fetched_at: now,
        });
        if (price != null) {
          histInsert.run(it.id, SOURCE, price, stock, now);
          priced++;
        }
        touched.add(it.id);
      } catch (err) {
        errors++;
        log(`  ! search failed for ${it.display_name}: ${err.message}`);
      }
      await sleep(config.psxi.requestDelayMs);
    }
    return { checked: items.length, priced, errors, touched };
  })();
}

// ── recent real sales via transactions feed ──────────────────────
async function sweepTransactions(db, log) {
  const watermark = Number(getMeta('psxi_last_txn_id')) || 0;
  let data;
  try {
    data = await fetchJson(
      `/recent-transactions${watermark ? `?after=${watermark}` : ''}`
    );
  } catch (err) {
    log(`  ! transactions fetch failed: ${err.message}`);
    return { inserted: 0, touched: new Set() };
  }

  const txns = data.transactions || [];
  const stackSize = db.prepare('SELECT stack_size FROM items WHERE id = ?');
  const histInsert = db.prepare(`
    INSERT INTO ah_price_history (item_id, source, price, stock, kind, fetched_at)
    VALUES (?, ?, ?, NULL, 'sale', ?)
  `);

  const touched = new Set();
  let inserted = 0;
  let maxId = watermark;
  const seen = new Set();

  const tx = db.transaction(() => {
    for (const t of txns) {
      if (!t.itemId || t.id <= watermark || seen.has(t.id)) continue;
      seen.add(t.id);
      const ss = stackSize.get(t.itemId)?.stack_size || 1;
      const unit = unitPrice(t.price, t.isStack, ss);
      if (unit == null) continue;
      histInsert.run(t.itemId, SOURCE, unit, t.sellDate || new Date().toISOString());
      touched.add(t.itemId);
      inserted++;
      if (t.id > maxId) maxId = t.id;
    }
  });
  tx();

  if (maxId > watermark) setMeta('psxi_last_txn_id', maxId);
  return { inserted, touched };
}

// ── median recompute for touched items ───────────────────────────
function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function recomputeMedians(db, itemIds) {
  if (itemIds.size === 0) return;
  const since = new Date(
    Date.now() - config.psxi.medianWindowDays * 86400000
  ).toISOString();
  const prices = db.prepare(
    `SELECT price FROM ah_price_history
     WHERE item_id = ? AND source = ? AND price IS NOT NULL AND fetched_at >= ?`
  );
  const sales24 = db.prepare(
    `SELECT COUNT(*) AS n FROM ah_price_history
     WHERE item_id = ? AND source = ? AND kind = 'sale' AND fetched_at >= ?`
  );
  const update = db.prepare(`
    INSERT INTO ah_prices (item_id, source, median_price, sales_24h, fetched_at)
    VALUES (@item_id, @source, @median_price, @sales_24h, @fetched_at)
    ON CONFLICT(item_id, source) DO UPDATE SET
      median_price = excluded.median_price,
      sales_24h = excluded.sales_24h
  `);
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const id of itemIds) {
      const med = median(prices.all(id, SOURCE, since).map((r) => r.price));
      const n = sales24.get(id, SOURCE, dayAgo).n;
      update.run({
        item_id: id,
        source: SOURCE,
        median_price: med,
        sales_24h: n,
        fetched_at: now,
      });
    }
  });
  tx();
}

/** Run one full PSXI sync: listings refresh + transactions sweep + medians. */
export async function runScrape({ log = console.log } = {}) {
  if (!config.psxi.enabled) {
    log('PSXI scrape disabled (PSXI_SCRAPE_ENABLED=false).');
    return { skipped: true };
  }
  const db = getDb();

  log('› Refreshing current listings…');
  const listings = await refreshListings(db, log);
  log(`  priced ${listings.priced}/${listings.checked} items (${listings.errors} errors)`);

  log('› Sweeping recent transactions…');
  const sales = await sweepTransactions(db, log);
  log(`  recorded ${sales.inserted} new sales`);

  const touched = new Set([...listings.touched, ...sales.touched]);
  recomputeMedians(db, touched);

  setMeta('psxi_last_scrape_at', new Date().toISOString());
  log(`✓ Scrape complete: ${touched.size} items updated.`);
  return {
    listingsPriced: listings.priced,
    listingsChecked: listings.checked,
    sales: sales.inserted,
    itemsUpdated: touched.size,
  };
}

// Allow `npm run scrape` / `node src/scrape/psxi.js`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScrape()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Scrape failed:', err);
      process.exit(1);
    });
}
