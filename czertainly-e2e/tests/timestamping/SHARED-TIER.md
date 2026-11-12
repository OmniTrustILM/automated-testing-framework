# Timestamping block on a shared tier (design)

Goal: the `timestamping` block runs create-only on a shared tier (develop-01, Testkube) once DevOps deploys its components
(timestamp-formatting connector, time-quality monitor + NTP, `messaging.timeQuality` on core, an EJBCA authority with the TSA
profiles), with the suite's safety model untouched: every write goes through the guarded API, every created object is
run-prefixed and in the ledger before any assertion, ownership = ledger line + live run-prefixed name, teardown deletes only
own objects with read-back, nothing pre-existing is changed, no platform-wide setting is touched. Core read: `integration/spring-boot-4.1`.

## Per object

| Object | Verdict on a shared tier | Guard (new = marked) | Ledger type / teardown |
|---|---|---|---|
| connectors (credential provider, EJBCA, crypto v2, timestamp formatting, vault), authority instance, vault instance, EJBCA end-entity / certificate profiles / CA | reused read-only (looked up by function group, interface, name; EJBCA options read through callbacks) | reads; **new:** the three attribute callbacks as a guard kind of their own (`POST_CALLBACK`: `/v1/raProfiles/{id}/callback`, `/v1/keys/{id}/callback`, `/v2/connectors/{id}/callback`; path id = the authority / connector the preflight registered for this run, or an own token profile; scanned body; never a raw context) and the list POST `/v2/connectors/list` | none |
| token (keystore on the crypto connector), token profile | created own | existing create routes; `connectorUuid` is a reference field | `tokens`, `tokenProfiles` (core handler) |
| keys + key items | created own | existing `keys/keyPair` create, `keyItems` | `keys`, `keyItems` |
| vault profile | created own under the pre-existing vault instance | existing create (vault = scope parent) | `vaultProfiles` |
| vault secrets of the Basic credentials | created by core, named `tsp-basic-<own tsp uuid>-<own user>-<8 hex>` | none (core makes them) | no line; the TSP-profile / credential handler awaits them and deletes only that exact name |
| time-quality configuration | **created own, per object**: a row with its own uuid and unique name (`TimeQualityConfigurationServiceImpl`), the register and the cache are keyed by uuid, the monitor runs "an independent check cycle per configuration", delete is refused while a signing profile uses it. Not platform-wide. Side effects, accepted: core republishes the whole snapshot to the monitor on every create / delete, and the monitor queries the NTP servers the config names (`TSA_NTP_SERVERS` must be the tier's own NTP) | **new:** removed from `PLATFORM_DENY`; `POST /v1/timeQualityConfigurations` in `POST_CREATE`; path type `timeQualityConfigurations` (update and delete only on own); body field `timeQualityConfigurationUuid` typed. The bulk delete stays refused (no route) | `timeQualityConfigurations` (existing handler, after the signing profiles) |
| mapped user | created own, no certificate, no password | existing | `users` |
| role + grants | created own; grants are object-scoped on own objects; `keys/sign` is resource-wide on the OWN role only (auth refuses object-scoped `keys`); nothing on another role | existing (`PATCH users/{own}/roles`, `POST roles/{own}/permissions`, own object uuids) | `roles` |
| RA profile | created own under the pre-existing authority | existing | `raProfiles` |
| TSA certificate | created own (issued at EJBCA; the end entity stays at the CA as for every issuance) | existing create | `certificates` |
| issuer CA certificates | read; one Core adds while building the chain is a derived line (existing rule) | `GET …/chain` on the own certificate (existing) | derived `certificates` |
| trusting the issuing root (`PATCH /v1/certificates/{root}`) | **changes a pre-existing object: forbidden.** Avoided: on a shared tier the root must already be trusted, else the block is `unavailable` with the reason (DevOps task). Stays for the proven local stack, through a separate `localStack` guard used for that one request | none (the strict guard refuses it) | – |
| signing profile | created own | **new:** `POST /v1/signingProfiles` in `POST_CREATE`; path type `signingProfiles`; the connector uuid `workflow.signatureFormattingConnectorUuid` is a route-scoped reference waiver (core stores the FK and attribute values on the own profile, the connector is not written); certificate and time-quality uuids must be own | `signingProfiles` (existing handler: deactivates TSP, empties its signing records, deletes) |
| TSP profile | created own | **new:** `POST /v1/tspProfiles` in `POST_CREATE`; path type `tspProfiles`; `defaultSigningProfileUuid` typed `signingProfiles` (was probes only) | `tspProfiles` (existing handler) |
| TSP protocol activation | own ↔ own | **new:** path type `tsp/activate` → `tspProfiles`, so both uuids of `PATCH signingProfiles/{own}/protocols/tsp/activate/{own}` must be own | released by the TSP-profile handler (`deactivate`) |
| Basic credentials | created own under an own TSP profile, mapped user own | none new: a POST whose path names an own `tspProfiles` line; new path type `basicCredentials` → `tspBasicCredentials` | `tspBasicCredentials` (spec-added) or gone with the TSP profile |
| signing records | made by core for every TSP request under an own signing profile | list POSTs are reads (**new:** `/v1/signingRecords`, `/v1/{signingProfiles,tspProfiles}/list`, `/v1/signingProfiles/{id}/signingRecords`); delete only in the handler, per own profile | emptied by the signing-profile handler |

No new ledger type, no new teardown handler and no new REFERENCED_BY pair: the four timestamping types were registered for the local run
already. Their `snapshot` entries stay explicit gaps (the block run has no snapshot; the regression snapshot does not list these
resources), and the reason text no longer says "@local only".

## Rows

- **Shared tier and local:** the setup, the teardown, and every row of 00 (health, connectors), 10, 20, 30, 40, 45, 60, 70. Their only
  non-API effect is TSP traffic with the run's own Basic credentials and files under the test output directory.
- **Stay `@local`:** 00 "every dependency container is up" (docker inspect), 00 "Core is subscribed to the time-quality exchange" (queue
  inspection with docker exec; no read-only API signal exists, the qualified rows are the end-to-end signal), 50 (stops the NTP and
  monitor containers) and 55 (stops the cryptography and formatting connectors), all `@slow @disruptive` and `TSA_ALLOW_DISRUPTION`.
  `TSA_CRYPTO_PROVIDER=software-v1` (its token callback path is name-keyed) and `pkcs11` are not provisioned on a shared tier.
- 60 and 70 stay as written; the signing-record window of 60 is narrowed to the run's own signing profiles (other clients' records on a
  shared tier are not this suite's business).

## Selection

The blanket `@local` goes. Rows carry `@needs:timestamping` (new need): resolved from reads before the row creates anything, it skips with
a named reason when OpenSSL 3 is missing or a connected credential-provider (SoftKeyStore), EJBCA, software cryptography v2, timestamp
formatting or vault (secret interface) connector, the authority named by `TSA_AUTHORITY_NAME` or the vault instance named by
`TSA_VAULT_INSTANCE_NAME` is missing. The setup's preflight then checks the EJBCA profiles and CAs and writes `unavailable` with the reason
(every row skips), before it creates anything. Local-only rows keep `@local` and `describeLocalOnly`; the local proof serves them, the one
trust request and the v1 provider's name-keyed callback only. The Basic-credential passwords are not in the summary: they are derived from
`TSA_RUN_SECRET`, generated per run by the config (environment only).

## Open points

- The three form callbacks are NOT reads and have their own guard kind. What core does with them (CallbackServiceImpl): `/v2/connectors/{id}/callback`
  is authorised `CONNECTOR` ANY (the resource callbacks LIST); every callback writes an audit-log row; a GROUP answer (the key-spec and token forms)
  is upserted into the attribute DEFINITIONS of the pre-existing connector behind it (a cache write, the same one the UI's forms cause: the one write
  on a pre-existing object this block makes, accepted, nothing of the connector's settings or inventory is changed); credentials and secrets named in the
  body or in its `attributes` are expanded and sent to the connector, so the guard scans both and refuses any uuid that is not own or the registered
  parent (attribute definition uuids and the connector-side `authorityId` excepted: they are not inventory objects). The id of `/v1/keys/{id}/callback`
  is a token profile (own). Without these callbacks the block cannot provision on a shared tier (the EJBCA certificate-profile / CA options and the
  token / key-spec forms are callbacks).
- The setup's callbacks run only after the connectors, the authority and the vault instance were found (`discoverParents`), so a tier without the
  components gets none; a tier that has them but lacks an EJBCA profile or CA still gets the RA-profile callbacks before the preflight says
  `unavailable` (they are what the EJBCA options can only be read with): accepted, a handful of audit-log rows.
- `keys/sign` is resource-wide on the run's own role (auth refuses object-scoped `keys` permissions): the mapped user has no password and no
  certificate, it only authenticates a TSP Basic credential.
- The issuing root CA must already be trusted in the inventory (DevOps, once), and `TSA_NTP_SERVERS` must name the tier's own NTP.
- The EJBCA end entities of the TSA certificates stay at the CA (core deletes only its copy), as for every issuance by the suite.
- The block run has no regression snapshot, and the regression snapshot does not list signing / TSP / time-quality resources (explicit gap in the
  registry). In its place the setup (after the preflight, before the first create) and the teardown (after the block's own objects went) read the three
  lists and compare count + SHA-256 of the rows the run did not create (`utils/timestamping/inventory.ts`; counts and hashes in the state dir, no
  names). A tier that cannot list them (404 or any error answer) skips the check with the reason; a difference fails the teardown test, and
  another user changing the same resources meanwhile shows as one too.
- A preset `TSA_RUN_SECRET` (for example from Testkube) is kept and reused across runs: leave it unset there, so every run gets a fresh secret.
