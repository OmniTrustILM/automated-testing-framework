/**
 * timeouts — the named time budgets of the regression and API tests (`test.setTimeout(ISSUE_MS)`).
 *
 * Each budget carries its reason once here, instead of a comment next to a number. Constants only, no I/O.
 */

const MINUTE_MS = 60_000;

/** The wait for one certificate to reach `issued` after the request (a slow CA included): 3 minutes. */
export const ISSUED_WAIT_MS = 3 * MINUTE_MS;

/** The wait for one certificate to reach `revoked` after the revoke call: 2 minutes. */
export const REVOKED_WAIT_MS = 2 * MINUTE_MS;

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

/** A UI form flow (several create dialogs, a read-back and a reopened detail page) in one test: 5 minutes. */
export const FORM_FLOW_MS = 5 * MINUTE_MS;

/** The wait for the trigger rows of one object to appear after a firing (a whole condition matrix included): 3 minutes. */
export const TRIGGER_ROWS_WAIT_MS = 3 * MINUTE_MS;

/** The wait for the effect of a fired trigger to be committed and readable on the object: 1 minute. */
export const TRIGGER_EFFECT_WAIT_MS = MINUTE_MS;

/** The wait for a batch of firings (31 registrations) to all finish: 5 minutes. */
export const FIRINGS_FINISHED_WAIT_MS = 5 * MINUTE_MS;

/** The wait for one delivered message or request at a local catcher or receiver: 2 minutes. */
export const DELIVERY_WAIT_MS = 2 * MINUTE_MS;

/** The wait for the messages that five uploads fire one after the other at the local mail catcher: 3 minutes. */
export const SLOW_DELIVERY_WAIT_MS = 3 * MINUTE_MS;

/** How far a webhook timestamp may be from the runner clock: one minute of delivery delay plus five minutes of clock skew. */
export const WEBHOOK_CLOCK_TOLERANCE_MS = MINUTE_MS + 5 * MINUTE_MS;

/** The window in which a delivery that must NOT happen is watched for, and how often the catcher is read inside it. */
export const ABSENCE_WINDOW_MS = 15_000;
export const ABSENCE_READ_EVERY_MS = 3_000;

/** A list, dialog or detail reflects a change the UI just made (a dialog closes, an API list drops a deleted row): 30 seconds. */
export const LIST_STATE_MS = 30_000;

/** A form finishes loading the stored values or definitions it shows: 15 seconds. */
export const FORM_READY_MS = 15_000;

/** An attribute or connector form needs the connector's answer before it shows its fields: 30 seconds. */
export const CONNECTOR_FORM_MS = 30_000;

/** The create of an authority waits for the connector's connectivity check: 90 seconds. */
export const AUTHORITY_CREATE_MS = 90_000;

/** The create of an RA profile waits for the connector to read the CA's templates: 60 seconds. */
export const RA_PROFILE_CREATE_MS = 60_000;

/** One test of a few connector or vault reads and creates: 1 minute. */
export const CONNECTOR_READ_TEST_MS = MINUTE_MS;

/** One test that registers or creates on a connector and waits for its check: 2 minutes. */
export const CONNECTOR_WRITE_TEST_MS = 2 * MINUTE_MS;

/** A secret is activated asynchronously after its create: 1 minute. */
export const SECRET_ACTIVE_MS = MINUTE_MS;

/** The core log is read this far back when a row runs without the row that opened the window: 30 minutes. */
export const LOG_LOOKBACK_MS = 30 * MINUTE_MS;

/** The message broker is stopped and `/health` must turn DOWN: 1 minute; it must be UP again after the restart: 3 minutes. */
export const HEALTH_DOWN_MS = MINUTE_MS;
export const HEALTH_UP_MS = 3 * MINUTE_MS;

/** An audit-log entry arrives through the message broker: 1 minute. */
export const AUDIT_ENTRY_MS = MINUTE_MS;

/**
 * One test that stops the broker and polls `/health` (3 minutes), and one that restarts it and waits for health and the audit entry (5
 * minutes).
 */
export const BROKER_STOP_TEST_MS = 3 * MINUTE_MS;
export const BROKER_START_TEST_MS = 5 * MINUTE_MS;

/** The admin shell (or the sign-in form's result) is shown after a sign-in, a route change or a reload: 30 seconds. */
export const SHELL_VISIBLE_MS = 30_000;
/** The first look for the credential form before the provider choice is offered: 2 seconds. */
export const LOGIN_FORM_PROBE_MS = 2_000;
/** One sign-in and its checks (REG-AUTH-01): 90 seconds. */
export const SIGN_IN_TEST_MS = 90_000;
/** A walk over five pages with reloads and a second tab (REG-AUTH-02): 3 minutes. */
export const SESSION_WALK_TEST_MS = 3 * MINUTE_MS;
/** A sign-in, a second browser context and a change of the user's session (sign-out, disable, delete): 4 minutes. */
export const SESSION_CHANGE_TEST_MS = 4 * MINUTE_MS;
/** A core restart and the sign-in checks around it: 7 minutes; the core is ready again within 5. */
export const CORE_RESTART_TEST_MS = 7 * MINUTE_MS;
export const CORE_READY_AFTER_RESTART_MS = 5 * MINUTE_MS;
/** How often the readiness of the restarted core is asked: 3 seconds. */
export const READINESS_POLL_INTERVAL_MS = 3_000;
/** The dedicated user's role fixture, a sign-in in its own context and the refused pages (REG-AUTH-08): 5 minutes. */
export const RESTRICTED_USER_TEST_MS = 5 * MINUTE_MS;
/** The group-scoped fixture with six uploaded certificates and its sign-in (REG-AUTH-10): 7 minutes. */
export const GROUP_SCOPED_USER_TEST_MS = 7 * MINUTE_MS;
/** A certificate registered through the form reaches `registered`: 30 seconds. */
export const REGISTERED_WAIT_MS = 30_000;
/** A gated issue reaches `pending_approval`, and a rejected one `rejected`: 1 minute. */
export const APPROVAL_STATE_WAIT_MS = MINUTE_MS;
/** The rejected-approval row: the gated issue, the list, the reject and the tab checks: 5 minutes. */
export const APPROVAL_REJECT_TEST_MS = 5 * MINUTE_MS;
/** The registration expiry may differ from now plus the default window by this much (request time and clock skew): 5 minutes. */
export const REGISTRATION_EXPIRY_TOLERANCE_MS = 5 * MINUTE_MS;
/** A certificate list spec: the seed build on its first use, then the list reads: 4 minutes. */
export const LIST_SPEC_TEST_MS = 4 * MINUTE_MS;
/** The sidebar sweep: the sign-in, then up to 30 seconds per page; one page's list request answers within 45 seconds. */
export const SWEEP_SIGN_IN_MS = MINUTE_MS;
export const SWEEP_PAGE_MS = 30_000;
export const SWEEP_LIST_REQUEST_MS = 45_000;
/** A file of 5 MiB inspected and shown: 3 minutes; the inspection answers within 90 seconds. */
export const LARGE_FILE_TEST_MS = 3 * MINUTE_MS;
export const INSPECTION_ANSWER_MS = 90_000;
/** After Create the detail page opens, or the accepted-with-warnings panel shows: 15 seconds. */
export const ADD_FORM_OUTCOME_MS = 15_000;
/** The list request a filter change causes is seen within 20 seconds; the request is only observed for 5. */
export const FILTER_LIST_REQUEST_MS = 20_000;
export const FILTER_REQUEST_SEEN_MS = 5_000;
/** A typed filter value shows in its input within 1 second, a retried fill within 10, a reopened badge within 15. */
export const FILTER_VALUE_SHOWN_MS = 1_000;
export const FILTER_FILL_SETTLE_MS = 10_000;
export const FILTER_BADGE_REOPEN_MS = 15_000;

/** A certificate reaches a state that needs no CA decision (pending approval, rejected, registered after a retry): 1 minute. */
export const STATE_CHANGE_WAIT_MS = MINUTE_MS;

/**
 * A certificate or an approval shows a state that the platform sets within the same request chain (registered, approval closed): 30
 * seconds.
 */
export const QUICK_STATE_WAIT_MS = 30 * 1000;

/** An event firing on one object (a trigger over a certificate event) is awaited in the history: 3 minutes. */
export const EVENT_FIRING_WAIT_MS = 3 * MINUTE_MS;

/**
 * The property oracles walk every row of a whole listing (keys, discoveries, the audit log's closed window), two re-reads at most: 25
 * minutes.
 */
export const LISTING_ORACLES_MS = 25 * MINUTE_MS;

/** One probe that is sent once (a refused method): 20 seconds. */
export const SINGLE_PROBE_TEST_MS = 20 * 1000;

/** A test that makes a handful of API calls and reads (no issuance): 30 seconds. */
export const FEW_CALLS_TEST_MS = 30 * 1000;

/** A test of a few steps with creates and read-backs on own objects: 1 minute. */
export const SEVERAL_STEPS_TEST_MS = MINUTE_MS;

/** A test that creates users, roles and their links and reads them back: 90 seconds. */
export const ACCOUNT_STEPS_TEST_MS = 90 * 1000;

/** A test with many steps that stay on the API (no CA wait): 2 minutes. */
export const MANY_STEPS_TEST_MS = 2 * MINUTE_MS;

/** A battery of probes or one permission document switch plus its reads: 3 minutes. */
export const BATTERY_TEST_MS = 3 * MINUTE_MS;

/** A sweep over many listings, resources or refused requests: 4 minutes. */
export const WIDE_SWEEP_TEST_MS = 4 * MINUTE_MS;

/** A registration walk or a sweep with a seed or an issuance inside: 5 minutes. */
export const LONG_TEST_MS = 5 * MINUTE_MS;

/** An issue, a revoke and the reads of its validation: 6 minutes. */
export const ISSUE_AND_REVOKE_TEST_MS = 6 * MINUTE_MS;

/** A permission fixture row that issues through the restricted identity and waits for the certificate: 10 minutes. */
export const ISSUING_MATRIX_ROW_TEST_MS = 10 * MINUTE_MS;

/** The asynchronous upload becomes a certificate within this time: 90 seconds. */
export const ASYNC_UPLOAD_WAIT_MS = 90 * 1000;

/** The approval a refused fixture left behind is looked up once more in the cleanup: 10 seconds. */
export const LEFTOVER_APPROVAL_LOOKUP_MS = 10 * 1000;

/** One request with an oversized upload body: 2.5 minutes. */
export const OVERSIZED_UPLOAD_REQUEST_MS = 150 * 1000;

/** Two certificates issued on a clone, then a revoke that waits for an approval decision each way: 10 minutes. */
export const APPROVAL_REVOKE_TEST_MS = 10 * MINUTE_MS;

/** A seed subset is built (creates and owner updates) and read back sorted four times: 90 seconds. */
export const SEED_SORT_TEST_MS = 90 * 1000;

/** A UI form flow with one issuance and the tab checks that follow it: 5 minutes. */
export const UI_ISSUE_FLOW_MS = 5 * MINUTE_MS;

/** One ACME order (finalize, settle, download) and its checks: 5 minutes. */
export const ACME_ORDER_MS = 5 * MINUTE_MS;

/**
 * Removing the cert-manager objects of one row: three kubectl deletes of up to 150 s each, the settle poll of the issued certificates and a
 * margin: 10 minutes.
 */
export const CLUSTER_CLEANUP_MS = 10 * MINUTE_MS;

/** An uploaded or imported certificate shows up in the inventory search: 30 seconds. */
export const INVENTORY_APPEAR_MS = 30_000;

/** `kubectl wait` for a cert-manager issuer to be Ready: 120 seconds (a kubectl budget is in seconds). */
export const ISSUER_READY_SECONDS = 120;

/** `kubectl wait` for a cert-manager Certificate to be Ready: 240 seconds (a kubectl budget is in seconds). */
export const CERTIFICATE_READY_SECONDS = 240;

/** How far an ACME order's expiry may be from the server time plus the profile validity: 300 seconds. */
export const ACME_EXPIRY_TOLERANCE_SECONDS = 300;

// ---- discovery, keys and tokens, protocols

/** A discovery of one own target waited for until `completed` (v1 and the small v2 runs): 4 minutes. */
export const DISCOVERY_RUN_MS = 4 * MINUTE_MS;

/** A discovery with several targets, a trigger or eight ports waited for until `completed`: 5 minutes. */
export const DISCOVERY_LARGE_RUN_MS = 5 * MINUTE_MS;

/** A status of a run or a state of a certificate that follows a request (stopped, in progress, notScheduled, revoked): 1 minute. */
export const STATUS_CHANGE_MS = MINUTE_MS;

/** A run over two /24 ranges to reach the second chunk of 256 targets, and the untouched control run to complete: 10 minutes. */
export const DISCOVERY_CHUNK_MS = 10 * MINUTE_MS;

/** The whole stop and resume test: two runs, three cycles, about four minutes per chunk: 20 minutes. */
export const DISCOVERY_STOP_RESUME_TEST_MS = 20 * MINUTE_MS;

/** The whole trigger test: three runs on two targets and the wait for each action: 10 minutes. */
export const DISCOVERY_TRIGGER_TEST_MS = 10 * MINUTE_MS;

/** The scheduled job's history shows the run that the cron tick started (a tick every two minutes, a slow connector): 7 minutes. */
export const SCHEDULED_RUN_WAIT_MS = 7 * MINUTE_MS;

/** A token or token profile made and checked in the admin UI: 3 minutes. */
export const UI_FLOW_MS = 3 * MINUTE_MS;

/** A key made, operated on and judged in the admin UI (a software provider generates a key): 4 minutes. */
export const UI_KEY_FLOW_MS = 4 * MINUTE_MS;

/** ACME: one order to valid, a download, two revokes and a state wait: 5 minutes. */
export const ACME_FLOW_MS = 5 * MINUTE_MS;

/** The ACME client waits for an order to become valid after the finalize: 2 minutes. */
export const ACME_ORDER_WAIT_MS = 2 * MINUTE_MS;

/** The history entry of a revoke is written after the state changes: 15 seconds, read every second. */
export const HISTORY_ENTRY_MS = 15_000;
export const HISTORY_POLL_EVERY_MS = 1_000;

/** An external protocol client (`sscep`, `openssl cmp`) may run this long before the runner stops it: 90 seconds. */
export const EXTERNAL_TOOL_MS = 90_000;

/** A protocol client gets its answer from the platform within 60 seconds. */
export const PROTOCOL_ANSWER_MS = MINUTE_MS;

/** A form's create request is answered within 60 seconds. */
export const FORM_SUBMIT_MS = MINUTE_MS;

/** The page opens the detail route, or the requests sent so far are all answered, within 30 seconds. */
export const PAGE_ROUTE_MS = 30_000;

/** The connector's attribute form renders after its schema loaded: 20 seconds. */
export const ATTRIBUTE_FORM_MS = 20_000;

/** A read-only API test over one short list: 30 seconds. */
export const API_READ_TEST_MS = 30_000;

/** An API test that makes one object (or none) and reads the refusal back: 1 minute. */
export const API_SHORT_TEST_MS = MINUTE_MS;

/** An API test that makes a few own objects and reads them back: 90 seconds. */
export const API_OWN_OBJECTS_TEST_MS = 90_000;

/** An API test that makes a chain of own objects (a key and its operations, a trigger chain) and checks them: 2 minutes. */
export const API_STANDARD_TEST_MS = 2 * MINUTE_MS;

/** An API test around one discovery run on a range nothing answers on: 2.5 minutes. */
export const API_DISCOVERY_RUN_TEST_MS = 150_000;

/** An API test with several variants or objects in a row (refusals with seeds, key sizes and curves): 3 minutes. */
export const API_VARIANTS_TEST_MS = 3 * MINUTE_MS;

/** An API test over a whole matrix (every sign or encrypt variant of a key family, several key families): 4 minutes. */
export const API_MATRIX_TEST_MS = 4 * MINUTE_MS;

/** An API test that moves key material between two tokens (export, import, sign, verify per family): 5 minutes. */
export const API_ROUND_TRIP_TEST_MS = 5 * MINUTE_MS;

/** An API test that walks every algorithm a hardware token offers: 10 minutes. */
export const API_TOKEN_MATRIX_TEST_MS = 10 * MINUTE_MS;

/** A discovery run reaches the state a stop, resume or cancel asked for: 1 minute. */
export const DISCOVERY_CONTROL_WAIT_MS = MINUTE_MS;

/** A run over a small dark range (a /29) completes: 90 seconds. */
export const DISCOVERY_SMALL_RUN_WAIT_MS = 90_000;

/** A small own run is completed before a state refusal is read on it: 2 minutes. */
export const DISCOVERY_DONE_RUN_WAIT_MS = 2 * MINUTE_MS;

/** The seed run of a duplicate-name probe completes: 2.5 minutes. */
export const DISCOVERY_SEED_RUN_WAIT_MS = 150_000;

/** A v1 run over a /27 completes (the v1 connector tries every port): 200 seconds. */
export const DISCOVERY_V1_RUN_WAIT_MS = 200_000;
