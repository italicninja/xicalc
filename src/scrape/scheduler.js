import cron from 'node-cron';
import { config } from '../config.js';
import { runScrape } from './psxi.js';

let running = false;

/** Start the recurring PSXI price sync (no-op when disabled or cron invalid). */
export function startScheduler({ log = console.log } = {}) {
  if (!config.psxi.enabled) {
    log('PSXI scheduler not started (PSXI_SCRAPE_ENABLED=false).');
    return null;
  }
  if (!cron.validate(config.psxi.cron)) {
    log(`PSXI scheduler not started: invalid cron "${config.psxi.cron}".`);
    return null;
  }

  const task = cron.schedule(config.psxi.cron, async () => {
    if (running) {
      log('PSXI scrape skipped: previous run still in progress.');
      return;
    }
    running = true;
    try {
      await runScrape({ log });
    } catch (err) {
      log(`PSXI scrape error: ${err.message}`);
    } finally {
      running = false;
    }
  });

  log(`PSXI scheduler started (cron "${config.psxi.cron}").`);
  return task;
}
