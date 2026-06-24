import express from 'express';
import { getDb } from '../db.js';

export const recipesRouter = express.Router();

const PSXI = 'psxi';

/** Latest AH price rows for a set of item ids, keyed by item_id. */
function ahPricesFor(db, itemIds) {
  if (itemIds.length === 0) return {};
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT item_id, median_price, last_price, stock, sales_24h, fetched_at
       FROM ah_prices WHERE source = ? AND item_id IN (${placeholders})`
    )
    .all(PSXI, ...itemIds);
  const out = {};
  for (const r of rows) {
    out[r.item_id] = {
      median: r.median_price,
      last: r.last_price,
      stock: r.stock,
      sales24h: r.sales_24h,
      fetchedAt: r.fetched_at,
    };
  }
  return out;
}

function parseSubcrafts(str) {
  if (!str) return [];
  return str.split('|').map((pair) => {
    const [craft, cap] = pair.split(':');
    return { craft, cap: Number(cap) };
  });
}

// GET /api/crafts -> { craftName: recipeCount }
recipesRouter.get('/crafts', (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT craft, COUNT(*) AS n FROM recipes GROUP BY craft')
    .all();
  const counts = {};
  for (const r of rows) counts[r.craft] = r.n;
  res.json({ crafts: counts });
});

// GET /api/recipes?craft=&search=&limit=&offset=
recipesRouter.get('/recipes', (req, res) => {
  const db = getDb();
  const { craft, search } = req.query;
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  const offset = Number(req.query.offset) || 0;

  const where = [];
  const params = [];
  if (craft) {
    where.push('r.craft = ?');
    params.push(craft);
  }
  if (search) {
    where.push('r.result_name LIKE ?');
    params.push(`%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT r.id, r.result_name AS name, r.craft, r.cap, r.crystal,
              r.yield, r.hq1_yield, r.hq2_yield, r.hq3_yield,
              i.base_sell AS npc_sell,
              (SELECT group_concat(rs.craft || ':' || rs.cap, '|')
               FROM recipe_skills rs
               WHERE rs.recipe_id = r.id AND rs.craft != r.craft) AS subcrafts
       FROM recipes r
       LEFT JOIN items i ON i.id = r.result_item_id
       ${whereSql}
       ORDER BY r.cap ASC, r.result_name ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const recipes = rows.map((r) => ({
    id: r.id,
    name: r.name,
    craft: r.craft,
    cap: r.cap,
    crystal: r.crystal,
    yield: r.yield,
    hqYield: r.hq1_yield,
    hq2Yield: r.hq2_yield,
    hq3Yield: r.hq3_yield,
    npcSell: r.npc_sell || null,
    subcrafts: parseSubcrafts(r.subcrafts),
  }));
  res.json({ recipes });
});

// GET /api/recipes/:id -> full detail for the calculator
recipesRouter.get('/recipes/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const r = db
    .prepare(
      `SELECT r.*, i.base_sell AS result_npc_sell, i.display_name AS result_display
       FROM recipes r LEFT JOIN items i ON i.id = r.result_item_id
       WHERE r.id = ?`
    )
    .get(id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });

  const ingredients = db
    .prepare(
      `SELECT ri.item_id, ri.qty, ri.slot,
              i.display_name AS name, i.base_sell AS npc_sell, i.stack_size
       FROM recipe_ingredients ri
       LEFT JOIN items i ON i.id = ri.item_id
       WHERE ri.recipe_id = ?
       ORDER BY ri.slot`
    )
    .all(id);

  const skills = db
    .prepare(
      'SELECT craft, cap FROM recipe_skills WHERE recipe_id = ? ORDER BY cap DESC'
    )
    .all(id);

  const ah = ahPricesFor(db, [
    r.result_item_id,
    r.crystal_item_id,
    ...ingredients.map((x) => x.item_id),
  ]);

  res.json({
    id: r.id,
    name: r.result_name,
    craft: r.craft,
    cap: r.cap,
    crystal: r.crystal,
    crystalItemId: r.crystal_item_id,
    yield: r.yield,
    hqYield: r.hq1_yield,
    hq2Yield: r.hq2_yield,
    hq3Yield: r.hq3_yield,
    contentTag: r.content_tag,
    resultItemId: r.result_item_id,
    npcSell: r.result_npc_sell || null,
    resultAh: ah[r.result_item_id] || null,
    crystalAh: ah[r.crystal_item_id] || null,
    subcrafts: skills.filter((s) => s.craft !== r.craft),
    skills,
    ingredients: ingredients.map((ing) => ({
      itemId: ing.item_id,
      name: ing.name || `Item #${ing.item_id}`,
      qty: ing.qty,
      stackSize: ing.stack_size,
      npcSell: ing.npc_sell || null,
      ah: ah[ing.item_id] || null,
    })),
  });
});
