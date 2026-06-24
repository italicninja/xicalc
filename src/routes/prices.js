import express from 'express';
import { getDb } from '../db.js';

export const pricesRouter = express.Router();

const PSXI = 'psxi';

// GET /api/prices?items=1,2,3 -> latest AH prices keyed by item id
pricesRouter.get('/prices', (req, res) => {
  const db = getDb();
  const ids = String(req.query.items || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter(Number.isFinite);
  if (ids.length === 0) return res.json({ prices: {} });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT item_id, median_price, last_price, stock, sales_24h, fetched_at
       FROM ah_prices WHERE source = ? AND item_id IN (${placeholders})`
    )
    .all(PSXI, ...ids);

  const prices = {};
  for (const r of rows) {
    prices[r.item_id] = {
      median: r.median_price,
      last: r.last_price,
      stock: r.stock,
      sales24h: r.sales_24h,
      fetchedAt: r.fetched_at,
    };
  }
  res.json({ prices });
});

// GET /api/items/:id/prices/history?limit=100
pricesRouter.get('/items/:id/prices/history', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = db
    .prepare(
      `SELECT price, stock, fetched_at
       FROM ah_price_history
       WHERE item_id = ? AND source = ?
       ORDER BY fetched_at DESC
       LIMIT ?`
    )
    .all(id, PSXI, limit);
  res.json({ itemId: id, history: rows });
});
