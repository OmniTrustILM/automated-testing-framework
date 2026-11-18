/** timeouts — the named time budgets of the regression and API tests; each constant states its reason once, here. Constants only, no I/O. */

const MINUTE_MS = 60_000;

/** The wait for one certificate to reach `issued` after the request (a slow CA included): 3 minutes. */
export const ISSUED_WAIT_MS = 3 * MINUTE_MS;

export const REVOKED_WAIT_MS = 2 * MINUTE_MS;

export const ISSUE_MS = 4 * MINUTE_MS;

export const LIFECYCLE_MS = 7 * MINUTE_MS;

export const SLOW_LIFECYCLE_MS = 8 * MINUTE_MS;

export const EVENT_DELIVERY_MS = 15 * MINUTE_MS;

/** The core comes up on an empty database (REG-CORE-01): startup budget, and the whole test around it. */
export const CORE_STARTUP_MS = 15 * MINUTE_MS;
export const CORE_STARTUP_TEST_MS = 17 * MINUTE_MS;

/** The upgrade of a local stack (REG-DEP-02): startup budget of the upgraded core, and the whole test around it. */
export const UPGRADE_STARTUP_MS = 35 * MINUTE_MS;
export const UPGRADE_TEST_MS = 45 * MINUTE_MS;

export const FORM_FLOW_MS = 5 * MINUTE_MS;

export const TRIGGER_ROWS_WAIT_MS = 3 * MINUTE_MS;

export const TRIGGER_EFFECT_WAIT_MS = MINUTE_MS;

export const FIRINGS_FINISHED_WAIT_MS = 5 * MINUTE_MS;

export const DELIVERY_WAIT_MS = 2 * MINUTE_MS;

export const SLOW_DELIVERY_WAIT_MS = 3 * MINUTE_MS;

/** How far a webhook timestamp may be from the runner clock: one minute of delivery delay plus five minutes of clock skew. */
export const WEBHOOK_CLOCK_TOLERANCE_MS = MINUTE_MS + 5 * MINUTE_MS;

/** The window in which a delivery that must NOT happen is watched for, and how often the catcher is read inside it. */
export const ABSENCE_WINDOW_MS = 15_000;
export const ABSENCE_READ_EVERY_MS = 3_000;

export const LIST_STATE_MS = 30_000;

export const FORM_READY_MS = 15_000;

export const CONNECTOR_FORM_MS = 30_000;

export const AUTHORITY_CREATE_MS = 90_000;

export const RA_PROFILE_CREATE_MS = 60_000;

export const CONNECTOR_READ_TEST_MS = MINUTE_MS;

export const CONNECTOR_WRITE_TEST_MS = 2 * MINUTE_MS;

export const SECRET_ACTIVE_MS = MINUTE_MS;

/** The core log is read this far back when a row runs without the row that opened the window: 30 minutes. */
export const LOG_LOOKBACK_MS = 30 * MINUTE_MS;

/** The message broker is stopped and `/health` must turn DOWN: 1 minute; it must be UP again after the restart: 3 minutes. */
export const HEALTH_DOWN_MS = MINUTE_MS;
export const HEALTH_UP_MS = 3 * MINUTE_MS;

export const AUDIT_ENTRY_MS = MINUTE_MS;

/**
 * One test that stops the broker and polls `/health` (3 minutes), and one
 * that restarts it and waits for health and the audit entry (5 minutes).
 */
export const BROKER_STOP_TEST_MS = 3 * MINUTE_MS;
export const BROKER_START_TEST_MS = 5 * MINUTE_MS;

export const SHELL_VISIBLE_MS = 30_000;
export const LOGIN_FORM_PROBE_MS = 2_000;
export const SIGN_IN_TEST_MS = 90_000;
export const SESSION_WALK_TEST_MS = 3 * MINUTE_MS;
export const SESSION_CHANGE_TEST_MS = 4 * MINUTE_MS;
/** A core restart and the sign-in checks around it: 7 minutes; the core is ready again within 5. */
export const CORE_RESTART_TEST_MS = 7 * MINUTE_MS;
export const CORE_READY_AFTER_RESTART_MS = 5 * MINUTE_MS;
export const READINESS_POLL_INTERVAL_MS = 3_000;
export const RESTRICTED_USER_TEST_MS = 5 * MINUTE_MS;
export const GROUP_SCOPED_USER_TEST_MS = 7 * MINUTE_MS;
export const REGISTERED_WAIT_MS = 30_000;
export const APPROVAL_STATE_WAIT_MS = MINUTE_MS;
export const APPROVAL_REJECT_TEST_MS = 5 * MINUTE_MS;
/** The registration expiry may differ from now plus the default window by this much (request time and clock skew): 5 minutes. */
export const REGISTRATION_EXPIRY_TOLERANCE_MS = 5 * MINUTE_MS;
export const LIST_SPEC_TEST_MS = 4 * MINUTE_MS;
/** The sidebar sweep: the sign-in, then up to 30 seconds per page; one page's list request answers within 45 seconds. */
export const SWEEP_SIGN_IN_MS = MINUTE_MS;
export const SWEEP_PAGE_MS = 30_000;
export const SWEEP_LIST_REQUEST_MS = 45_000;
/** A file of 5 MiB inspected and shown: 3 minutes; the inspection answers within 90 seconds. */
export const LARGE_FILE_TEST_MS = 3 * MINUTE_MS;
export const INSPECTION_ANSWER_MS = 90_000;
export const ADD_FORM_OUTCOME_MS = 15_000;
/** The list request a filter change causes is seen within 20 seconds; the request is only observed for 5 seconds. */
export const FILTER_LIST_REQUEST_MS = 20_000;
export const FILTER_REQUEST_SEEN_MS = 5_000;

export const STATE_CHANGE_WAIT_MS = MINUTE_MS;

/**
 * A certificate or an approval shows a state that the platform sets
 * within the same request chain (registered, approval closed): 30 seconds.
 */
export const QUICK_STATE_WAIT_MS = 30 * 1000;

export const EVENT_FIRING_WAIT_MS = 3 * MINUTE_MS;

/**
 * The property oracles walk every row of a whole listing (keys, discoveries,
 * the audit log's closed window), two re-reads at most: 25 minutes.
 */
export const LISTING_ORACLES_MS = 25 * MINUTE_MS;

export const SINGLE_PROBE_TEST_MS = 20 * 1000;

export const FEW_CALLS_TEST_MS = 30 * 1000;

export const SEVERAL_STEPS_TEST_MS = MINUTE_MS;

export const ACCOUNT_STEPS_TEST_MS = 90 * 1000;

export const MANY_STEPS_TEST_MS = 2 * MINUTE_MS;

export const BATTERY_TEST_MS = 3 * MINUTE_MS;

export const WIDE_SWEEP_TEST_MS = 4 * MINUTE_MS;

export const LONG_TEST_MS = 5 * MINUTE_MS;

export const ISSUE_AND_REVOKE_TEST_MS = 6 * MINUTE_MS;

export const ISSUING_MATRIX_ROW_TEST_MS = 10 * MINUTE_MS;

/** API-CERT-08 failed row: up to five issued waits in a row (the e-mail SAN probe, then two attempts of an issue and a parallel renew), then the matrix. */
export const FAILED_FIXTURE_ROW_TEST_MS = 5 * ISSUED_WAIT_MS + MANY_STEPS_TEST_MS;

export const ASYNC_UPLOAD_WAIT_MS = 90 * 1000;

export const LEFTOVER_APPROVAL_LOOKUP_MS = 10 * 1000;

export const OVERSIZED_UPLOAD_REQUEST_MS = 150 * 1000;

export const APPROVAL_REVOKE_TEST_MS = 10 * MINUTE_MS;

export const SEED_SORT_TEST_MS = 90 * 1000;

export const UI_ISSUE_FLOW_MS = 5 * MINUTE_MS;

export const ACME_ORDER_MS = 5 * MINUTE_MS;

/**
 * Removing the cert-manager objects of one row: three kubectl deletes of up to 150 s each, the settle poll of the issued certificates and a
 * margin: 10 minutes.
 */
export const CLUSTER_CLEANUP_MS = 10 * MINUTE_MS;

export const INVENTORY_APPEAR_MS = 30_000;

/** `kubectl wait` for a cert-manager issuer to be Ready: 120 seconds (a kubectl budget is in seconds). */
export const ISSUER_READY_SECONDS = 120;

/** `kubectl wait` for a cert-manager Certificate to be Ready: 240 seconds (a kubectl budget is in seconds). */
export const CERTIFICATE_READY_SECONDS = 240;

/** How far an ACME order's expiry may be from the server time plus the profile validity: 300 seconds. */
export const ACME_EXPIRY_TOLERANCE_SECONDS = 300;


export const DISCOVERY_RUN_MS = 4 * MINUTE_MS;

export const DISCOVERY_LARGE_RUN_MS = 5 * MINUTE_MS;

export const STATUS_CHANGE_MS = MINUTE_MS;

/** A run over two /24 ranges to reach the second chunk of 256 targets, and the untouched control run to complete: 10 minutes. */
export const DISCOVERY_CHUNK_MS = 10 * MINUTE_MS;

export const DISCOVERY_STOP_RESUME_TEST_MS = 20 * MINUTE_MS;

export const DISCOVERY_TRIGGER_TEST_MS = 10 * MINUTE_MS;

export const SCHEDULED_RUN_WAIT_MS = 7 * MINUTE_MS;

export const UI_FLOW_MS = 3 * MINUTE_MS;

export const UI_KEY_FLOW_MS = 4 * MINUTE_MS;

export const ACME_FLOW_MS = 5 * MINUTE_MS;

export const ACME_ORDER_WAIT_MS = 2 * MINUTE_MS;

/** The history entry of a revoke is written after the state changes: 15 seconds, read every second. */
export const HISTORY_ENTRY_MS = 15_000;
export const HISTORY_POLL_EVERY_MS = 1_000;

/** An external protocol client (`sscep`, `openssl cmp`) may run this long before the runner stops it: 90 seconds. */
export const EXTERNAL_TOOL_MS = 90_000;

export const PROTOCOL_ANSWER_MS = MINUTE_MS;

export const FORM_SUBMIT_MS = MINUTE_MS;

export const PAGE_ROUTE_MS = 30_000;

export const ATTRIBUTE_FORM_MS = 20_000;

export const API_READ_TEST_MS = 30_000;

export const API_SHORT_TEST_MS = MINUTE_MS;

export const API_OWN_OBJECTS_TEST_MS = 90_000;

export const API_STANDARD_TEST_MS = 2 * MINUTE_MS;

export const API_DISCOVERY_RUN_TEST_MS = 150_000;

export const API_VARIANTS_TEST_MS = 3 * MINUTE_MS;

export const API_MATRIX_TEST_MS = 4 * MINUTE_MS;

export const API_ROUND_TRIP_TEST_MS = 5 * MINUTE_MS;

export const API_TOKEN_MATRIX_TEST_MS = 10 * MINUTE_MS;

export const DISCOVERY_CONTROL_WAIT_MS = MINUTE_MS;

export const DISCOVERY_SMALL_RUN_WAIT_MS = 90_000;

export const DISCOVERY_DONE_RUN_WAIT_MS = 2 * MINUTE_MS;

export const DISCOVERY_SEED_RUN_WAIT_MS = 150_000;

/** A v1 run over a /27 completes (the v1 connector tries every port): 200 seconds. */
export const DISCOVERY_V1_RUN_WAIT_MS = 200_000;
