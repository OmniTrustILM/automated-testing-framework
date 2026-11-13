/**
 * estGlobalTeardown — Playwright globalTeardown of the EST suite.
 *
 * WHAT: fails the run when the specs left objects behind in the platform.
 * WHY: a leaking run must not be green; a shared environment would fill up with profiles,
 *      secrets and certificates.
 */

import { formatCleanupReport, readCleanupFailures } from './cleanupLedger';
import { Logger } from './Logger';

const logger = new Logger('EstGlobalTeardown');

export default async function estGlobalTeardown(): Promise<void> {
  const failures = readCleanupFailures();
  if (failures.length === 0) {
    logger.info('Cleanup ledger is empty');
    return;
  }
  throw new Error(formatCleanupReport(failures));
}
