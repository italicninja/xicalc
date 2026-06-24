import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDb, setMeta } from '../db.js';
import { parseInserts } from './sqlInsert.js';
import { CRAFT_COLUMNS, CRYSTAL_ELEMENTS, humanizeName } from './maps.js';

// ── synth_recipes column indices (INSERT order) ──────────────
const R = {
  ID: 0,
  DESYNTH: 1,
  SKILL_START: 3, // Wood..Cook occupy indices 3..10
  CRYSTAL: 11,
  ING_START: 13, // Ingredient1..8 -> 13..20
  RESULT: 21,
  QTY: 25,
  HQ1_QTY: 26,
  HQ2_QTY: 27,
  HQ3_QTY: 28,
  RESULT_NAME: 29,
  CONTENT_TAG: 30,
};

// ── item_basic column indices ────────────────────────────────
// `name` is the singular log form ("spool_of_silk_thread"); `sortname` strips
// the unit prefix ("silk_thread") and matches both the old UI and AH listings.
const I = { ID: 0, NAME: 2, SORTNAME: 3, STACK: 6, FLAGS: 7, BASESELL: 9 };

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': config.psxi.userAgent } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function buildItems(itemSql) {
  const items = new Map();
  for (const row of parseInserts(itemSql, 'item_basic')) {
    const id = Number(row[I.ID]);
    if (!Number.isFinite(id)) continue;
    const name = String(row[I.NAME] ?? '');
    const sortname = String(row[I.SORTNAME] ?? '') || name;
    const flags = String(row[I.FLAGS] ?? '');
    items.set(id, {
      id,
      name,
      display_name: humanizeName(sortname),
      stack_size: Number(row[I.STACK]) || 1,
      auctionable: /NOAUCTION/i.test(flags) ? 0 : 1,
      base_sell: Number(row[I.BASESELL]) || 0,
    });
  }
  return items;
}

function inEra(contentTag) {
  const tag = (contentTag ?? '').toString().trim();
  return config.lsb.eraTags.includes(tag);
}

function buildRecipes(recipeSql, items) {
  const recipes = [];
  let skippedDesynth = 0;
  let skippedEra = 0;
  let skippedNoCraft = 0;

  for (const row of parseInserts(recipeSql, 'synth_recipes')) {
    if (Number(row[R.DESYNTH]) !== 0) {
      skippedDesynth++;
      continue;
    }
    if (!inEra(row[R.CONTENT_TAG])) {
      skippedEra++;
      continue;
    }

    // Determine crafts from the 8 skill columns.
    const skills = [];
    for (let k = 0; k < CRAFT_COLUMNS.length; k++) {
      const cap = Number(row[R.SKILL_START + k]) || 0;
      if (cap > 0) skills.push({ craft: CRAFT_COLUMNS[k], cap });
    }
    if (skills.length === 0) {
      skippedNoCraft++;
      continue;
    }
    skills.sort((a, b) => b.cap - a.cap);
    const primary = skills[0];

    // Crystal element.
    const crystalId = Number(row[R.CRYSTAL]) || 0;
    const crystal =
      CRYSTAL_ELEMENTS[crystalId] ||
      (items.get(crystalId)?.display_name.replace(/ Crystal$/i, '') ?? 'Unknown');

    // Ingredients: aggregate qty across the 8 slots.
    const ingMap = new Map(); // itemId -> { item_id, qty, slot }
    for (let s = 0; s < 8; s++) {
      const itemId = Number(row[R.ING_START + s]) || 0;
      if (itemId === 0) continue;
      const existing = ingMap.get(itemId);
      if (existing) existing.qty += 1;
      else ingMap.set(itemId, { item_id: itemId, qty: 1, slot: s });
    }

    const resultId = Number(row[R.RESULT]) || 0;
    const resultName =
      (row[R.RESULT_NAME] && String(row[R.RESULT_NAME]).trim()) ||
      items.get(resultId)?.display_name ||
      `Item #${resultId}`;

    recipes.push({
      id: Number(row[R.ID]),
      result_item_id: resultId,
      result_name: resultName,
      craft: primary.craft,
      cap: primary.cap,
      crystal_item_id: crystalId,
      crystal,
      yield: Number(row[R.QTY]) || 1,
      hq1_yield: Number(row[R.HQ1_QTY]) || null,
      hq2_yield: Number(row[R.HQ2_QTY]) || null,
      hq3_yield: Number(row[R.HQ3_QTY]) || null,
      desynth: 0,
      content_tag: (row[R.CONTENT_TAG] ?? null) || null,
      skills,
      ingredients: [...ingMap.values()],
    });
  }

  return { recipes, skippedDesynth, skippedEra, skippedNoCraft };
}

function persist(items, recipes) {
  const db = getDb();

  const upsertItem = db.prepare(`
    INSERT INTO items (id, name, display_name, stack_size, auctionable, base_sell)
    VALUES (@id, @name, @display_name, @stack_size, @auctionable, @base_sell)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      display_name = excluded.display_name,
      stack_size = excluded.stack_size,
      auctionable = excluded.auctionable,
      base_sell = excluded.base_sell
  `);

  const insertRecipe = db.prepare(`
    INSERT INTO recipes
      (id, result_item_id, result_name, craft, cap, crystal_item_id, crystal,
       yield, hq1_yield, hq2_yield, hq3_yield, desynth, content_tag)
    VALUES
      (@id, @result_item_id, @result_name, @craft, @cap, @crystal_item_id, @crystal,
       @yield, @hq1_yield, @hq2_yield, @hq3_yield, @desynth, @content_tag)
  `);
  const insertSkill = db.prepare(
    'INSERT INTO recipe_skills (recipe_id, craft, cap) VALUES (?, ?, ?)'
  );
  const insertIng = db.prepare(
    'INSERT INTO recipe_ingredients (recipe_id, item_id, qty, slot) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const it of items.values()) upsertItem.run(it);

    // Recipes are fully rebuilt so re-seeding stays idempotent.
    db.exec(
      'DELETE FROM recipe_ingredients; DELETE FROM recipe_skills; DELETE FROM recipes;'
    );
    for (const r of recipes) {
      insertRecipe.run(r);
      for (const s of r.skills) insertSkill.run(r.id, s.craft, s.cap);
      for (const ing of r.ingredients) insertIng.run(r.id, ing.item_id, ing.qty, ing.slot);
    }
  });
  tx();
}

/** Fetch the LandSandBoat dumps and (re)populate items + recipes. */
export async function runIngest({ log = console.log } = {}) {
  log('› Fetching LandSandBoat data…');
  const [itemSql, recipeSql] = await Promise.all([
    fetchText(config.lsb.itemUrl),
    fetchText(config.lsb.recipeUrl),
  ]);

  log('› Parsing items…');
  const items = buildItems(itemSql);
  log(`  parsed ${items.size.toLocaleString()} items`);

  log('› Parsing recipes…');
  const { recipes, skippedDesynth, skippedEra, skippedNoCraft } = buildRecipes(
    recipeSql,
    items
  );
  log(
    `  kept ${recipes.length.toLocaleString()} synthesis recipes ` +
      `(skipped ${skippedDesynth} desynth, ${skippedEra} out-of-era, ${skippedNoCraft} craftless)`
  );

  log('› Writing to database…');
  persist(items, recipes);

  setMeta('last_seed_at', new Date().toISOString());
  setMeta('item_count', items.size);
  setMeta('recipe_count', recipes.length);
  setMeta('era_tags', config.lsb.eraTags.join(','));

  log(`✓ Seed complete: ${recipes.length.toLocaleString()} recipes, ${items.size.toLocaleString()} items.`);
  return { items: items.size, recipes: recipes.length };
}

// Allow `npm run seed` / `node src/ingest/lsb.js`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
