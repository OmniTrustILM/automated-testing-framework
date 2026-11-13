/**
 * estGlobalSetup — Playwright globalSetup of the EST suite.
 *
 * WHAT: empties the cleanup ledger before the run and records when the run started.
 * WHY: the ledger is a file; entries left by an earlier run would make this run report objects it
 *      never created. The log-hygiene spec scans the logs written since the run started.
 * HOW: the start time goes to `EST_RUN_STARTED_AT`, which Playwright hands on to the workers.
 */

import { clearCleanupFailures } from './cleanupLedger';

export default async function estGlobalSetup(): Promise<void> {
  clearCleanupFailures();
  process.env.EST_RUN_STARTED_AT = new Date().toISOString();
}
