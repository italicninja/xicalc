import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

const eraTags = (process.env.ERA_CONTENT_TAGS ?? ',COP,TOAU,WOTG,RoZ')
  .split(',')
  .map((t) => t.trim());

export const config = {
  projectRoot,
  port: Number(process.env.PORT) || 3000,
  databasePath: resolvePath(process.env.DATABASE_PATH || './data/xicalc.db'),

  // LandSandBoat raw SQL sources (the open-source emulator HorizonXI runs on).
  lsb: {
    itemUrl:
      process.env.LSB_ITEM_URL ||
      'https://raw.githubusercontent.com/LandSandBoat/server/base/sql/item_basic.sql',
    recipeUrl:
      process.env.LSB_RECIPE_URL ||
      'https://raw.githubusercontent.com/LandSandBoat/server/base/sql/synth_recipes.sql',
    // Keep recipes whose content_tag is in this set. '' = base game.
    eraTags,
  },

  psxi: {
    enabled: (process.env.PSXI_SCRAPE_ENABLED ?? 'true') !== 'false',
    cron: process.env.PSXI_SCRAPE_CRON || '7 * * * *',
    server: process.env.PSXI_SERVER || 'horizonxi',
    baseUrl: process.env.PSXI_BASE_URL || 'https://www.psxi.gg',
    userAgent:
      'xicalc/1.0 (HorizonXI crafting calculator; respectful hourly price sync)',
    // Bounded, resumable listing refresh: each run prices the N stalest items,
    // so coverage of all ~3.5k recipe items builds over several runs.
    maxItemsPerRun: Number(process.env.PSXI_MAX_ITEMS_PER_RUN) || 300,
    requestDelayMs: Number(process.env.PSXI_REQUEST_DELAY_MS) || 200,
    requestTimeoutMs: Number(process.env.PSXI_REQUEST_TIMEOUT_MS) || 20000,
    // Trailing window (days) used to compute the median price.
    medianWindowDays: Number(process.env.PSXI_MEDIAN_WINDOW_DAYS) || 30,
  },

  adminToken: process.env.ADMIN_TOKEN || '',
};
