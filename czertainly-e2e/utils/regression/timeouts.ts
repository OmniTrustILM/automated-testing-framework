/**
 * timeouts — the named time budgets of the regression and API tests (`test.setTimeout(ISSUE_MS)`), so the reason for a
 * budget is written once here instead of in a comment next to a number. Each value is what the tests use today; a test
 * moves to a name when its owner touches it. Pure, no I/O.
 */

const MINUTE_MS = 60_000;

/**
 * Plain budgets for a test that has no named reason of its own: a few creates and reads (2 minutes), a short chain of
 * waits (5), a revoke chain (6), a role or key sweep (10). The specs still write 120_000 / 300_000 / 360_000 / 600_000;
 * they move to these names when their owner touches them.
 */
export const TWO_MINUTES_MS = 2 * MINUTE_MS;
export const FIVE_MINUTES_MS = 5 * MINUTE_MS;
export const SIX_MINUTES_MS = 6 * MINUTE_MS;
export const TEN_MINUTES_MS = 10 * MINUTE_MS;

/** One certificate issued (or one protocol enrolment) and checked: 4 minutes. */
export const ISSUE_MS = 4 * MINUTE_MS;

/** One issue plus one lifecycle operation (renew, rekey, revoke, register and complete): 7 minutes. */
export const LIFECYCLE_MS = 7 * MINUTE_MS;

/** A lifecycle chain over several certificates, or an operation followed by event processing: 8 minutes. */
export const SLOW_LIFECYCLE_MS = 8 * MINUTE_MS;

/** Notification delivery, scheduled jobs and full catalogue sweeps that wait on the platform: 15 minutes. */
export const EVENT_DELIVERY_MS = 15 * MINUTE_MS;

/** The core comes up on an empty database (REG-CORE-01): startup budget, and the whole test around it. */
export const CORE_STARTUP_MS = 15 * MINUTE_MS;
export const CORE_STARTUP_TEST_MS = 17 * MINUTE_MS;

/** The upgrade of a local stack (REG-DEP-02): startup budget of the upgraded core, and the whole test around it. */
export const UPGRADE_STARTUP_MS = 35 * MINUTE_MS;
export const UPGRADE_TEST_MS = 45 * MINUTE_MS;
