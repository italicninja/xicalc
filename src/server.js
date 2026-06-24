import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { getDb, isEmpty, getMeta } from './db.js';
import { runIngest } from './ingest/lsb.js';
import { startScheduler } from './scrape/scheduler.js';
import { recipesRouter } from './routes/recipes.js';
import { pricesRouter } from './routes/prices.js';
import { adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// API
app.use('/api', recipesRouter);
app.use('/api', pricesRouter);
app.use('/api/admin', adminRouter);

// Health check (used by Railway)
app.get('/healthz', (req, res) => {
  try {
    const db = getDb();
    const recipes = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
    res.json({
      status: 'ok',
      recipes,
      lastSeedAt: getMeta('last_seed_at'),
      lastScrapeAt: getMeta('psxi_last_scrape_at'),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Static UI
app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

async function boot() {
  getDb(); // open + migrate schema

  if (isEmpty()) {
    console.log('Database is empty — seeding from LandSandBoat…');
    try {
      await runIngest();
    } catch (err) {
      console.error('Initial seed failed (continuing; retry via /api/admin/seed):', err.message);
    }
  } else {
    console.log(`DB ready (last seeded ${getMeta('last_seed_at') || 'unknown'}).`);
  }

  startScheduler();

  app.listen(config.port, () => {
    console.log(`xicalc listening on http://localhost:${config.port}`);
  });
}

boot();
