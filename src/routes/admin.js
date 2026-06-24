import express from 'express';
import { config } from '../config.js';
import { runIngest } from '../ingest/lsb.js';
import { runScrape } from '../scrape/psxi.js';

export const adminRouter = express.Router();

// Bearer-token guard. When ADMIN_TOKEN is unset, admin endpoints are disabled.
adminRouter.use((req, res, next) => {
  if (!config.adminToken) {
    return res.status(404).json({ error: 'Admin endpoints disabled (set ADMIN_TOKEN)' });
  }
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token !== config.adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// POST /api/admin/seed -> re-import LandSandBoat data
adminRouter.post('/seed', async (req, res) => {
  try {
    const result = await runIngest({ log: () => {} });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/admin/scrape -> trigger a PSXI price sync now
adminRouter.post('/scrape', async (req, res) => {
  try {
    const result = await runScrape({ log: () => {} });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});
