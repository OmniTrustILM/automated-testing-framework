# RFC 8693 delegation release gate — issue 118

Run this suite against an **isolated disposable product deployment containing the delegation changes**. It creates two uniquely named OAuth2 providers and a uniquely named Keycloak realm. It removes both providers and the realm even after an assertion fails; cleanup failure fails the run. It never replaces the product's global authentication settings. Existing smoke tests keep their own configuration and setup.

The runner uses Node 22.9+ and its standard library, with no added dependencies. It has no browser, request trace, screenshots, videos or response attachments. HTTP errors report status only. Tokens and signing keys live only in memory; the uploaded JWK set contains public keys. Do not enable HTTP debugging, shell tracing or a network recorder for these runs.

## Exact issuer setup

The issuer probe was exercised with **Keycloak 26.8.1**, image digest `sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b`, and both required features:

```sh
docker compose -f delegation/compose.yaml up -d
npm run test:delegation:issuer
docker compose -f delegation/compose.yaml down
```

Supply `DELEGATION_KEYCLOAK_ADMIN_PASSWORD` to Compose via the environment; do not put it on the command line or commit it. Copy `.env.delegation.example` to the ignored `.env.delegation` for the runner. Wait until Keycloak is ready before the probe. The local Compose service binds only to `127.0.0.1:18818` and stores no persistent data. Stop it after testing, including a failed probe.

For a Kubernetes deployment, use an issuer URL reachable at the **same URL** by Core and the runner. Core must reach that issuer's `/protocol/openid-connect/certs`. A loopback issuer cannot be reached from a separate Core container. Start the test issuer with:

```text
start-dev --features=token-exchange-delegation,parameterized-scopes
```

The admin API fixture verifies the exact version before mutation. It creates a confidential service-account actor client with `standard.token.exchange.enabled=true`, a direct-grant subject client, an audience mapper and a test user. It fetches the actor's service-account UUID, then adds a JSON hardcoded `may_act` mapper containing that UUID and `client_id`. It obtains a real user token and a real service-account token, and posts both `subject_token` and `actor_token` to the RFC 8693 exchange grant. The returned JWT must retain the user's `sub` and identify the provisioned client and service account in `act`.

**The hardcoded `may_act` mapper is for this disposable fixture only.** It bypasses the consent/FGAP issuance policy so API tests are deterministic. Production issuance requires the consent and FGAP V2 delegation policy described in the [Keycloak delegation guide](https://www.keycloak.org/securing-apps/token-exchange). These are distinct from standard impersonating token exchange. See also the [26.8.1 upgrade notes](https://www.keycloak.org/docs/26.8.1/upgrading/) for the client delegation and FGAP changes.

## Product preconditions and execution

Provide all values in `.env.delegation.example`. The product admin token needs settings update plus audit list/search/export grants. `DELEGATION_USERNAME` must name an existing enabled product user; the fixture creates a matching Keycloak user. `DELEGATION_USER_UUID` is that **product user's** UUID, not the new Keycloak UUID. This lets assertions prove that operations execute as the user rather than the service account. Do not reuse another user's credentials or a shared product environment.

`DELEGATION_API_PATH` is a read-only, audited GET operation this user is allowed to perform. `/api/v1/settings/platform` is suitable when the user has settings detail permission. `DELEGATION_TSP_PATH` must name an enabled, fully working TSP profile accepting bearer authentication and authorizing this user. Its signer must produce granted timestamps. Audit collection must include successful resource operations and failed authentication. Use the default UTF-8 export with headers; comma, semicolon and other one-character separators are selectable via `DELEGATION_CSV_SEPARATOR`. Both default ZIP exports and raw CSV are supported.

```sh
npm run test:delegation:unit
npm run check:delegation
npm run test:delegation
```

Missing configuration fails before any network operation. There is no automatic skip for a missing issuer, product, signer or audit receiver. The eight required cases are named by issue scenario number: **1, 3, 4, 5, 6, 7, 8, 9**. They check real Keycloak exchange; user/delegate attribution; ordinary tokens after delegated requests; immediate allowlist revocation; omitted allowlist; signed string/array/null actors, missing claims and non-string delegate identifiers; nested and custom actor claims; successful RFC 3161 status and HTTP 401 refusals; audit search and CSV delegate identifier/subject columns. Successful audit matching uses a unique User-Agent per request. Authentication failures can precede MVC source capture, so refusal matching uses an audit-ID watermark and the unique provider/delegate diagnostic. Both poll up to 30 seconds for the receiver.

The manually triggered `delegation-release-gate.yml` workflow reads the same variables and secrets from the `delegation-disposable` GitHub environment. Configure only a disposable target there and set its `DELEGATION_DISPOSABLE` variable to `true`. Normal framework CI runs helper coverage and parses this runner without contacting a deployment. It does not substitute a helper test result for a product release-gate result.

## Manual evidence still required

Record the product, interface and administrator UI commit IDs, deployment ID, exact Keycloak version/features, UTC time, operator and outcome. Record operation paths, status codes and audit IDs; omit credentials, Authorization headers and raw tokens. A missing manual result is **pending**, never a pass.

| Scenario | Reproducible check | Evidence to record |
| --- | --- | --- |
| 2 — permission parity | Choose a read-only audited GET the user lacks permission for. Confirm the user's role/group grants in the UI. Set optional `DELEGATION_DENIED_API_PATH` in the ignored env file and run the suite. Its optional scenario 2 calls this path with the user's own and delegated token and requires HTTP 403 from both. | Path, reviewed permission/grant, both status codes, operator and UTC time. Tokens stay in memory. |
| 10 — provider UI | In the disposable deployment create a uniquely named OAuth2 provider through the UI. Check empty allowed delegates and default `client_id`, add two exact delegate identifiers, save/reload, change the delegate claim and inspect details. Clear the claim and confirm saving restores `client_id`; adding the same exact identifier twice must keep one entry. Check a 256-character identifier fails on save. Delete this manually created provider afterward. | Screenshots of form validation, saved form/detail and cleanup; redact the client secret and credential fields. |
| 10 — audit UI | After the automated run, inspect its persisted ordinary, delegated and rejected audit IDs. Verify user remains actor, delegate identifier/subject appear in list/detail, ordinary rows have none, and Delegate filter selects the expected records. Export filtered records and inspect delegate columns. | Audit IDs, redacted list/detail/filter screenshots, export column names and result count. |
| 11 — disclosure | Collect Core, Auth, audit receiver, reverse proxy, Keycloak and CI runner logs for the exact test window into restricted local files. Scan those files and the actual runner report using the command below. Inspect any external request recorder configuration and confirm credentials were not captured. | File/component names, time window, scanner exit code and counts, reviewer, and manual review of non-JWT secrets. Never paste matching lines. |

```sh
npm run check:delegation:logs -- /secure/path/core.log /secure/path/runner-report.txt
```

The scanner prints counts only and fails if a complete three-part JWT is present or a file cannot be read. Header/payload-only redaction, which is used by the product's audit policy, is permitted. The automated API/export assertions additionally compare all issued full tokens and their signatures in memory. The artifact scanner does not identify standalone signatures, opaque tokens, passwords or client secrets; review those using approved local secret-scanning tools without printing values. Do not upload collected raw logs or token-bearing artifacts. Remove restricted local collections after review.

## Local helper verification

`test:delegation:unit` exercises real RSA signatures/JWKs, a local HTTP boundary, Keycloak admin/exchange payloads, cleanup after partial setup failure, actual binary TSP request construction, audit correlation and filter/export requests, CSV/ZIP decoding, and the artifact-scanner CLI's positive/negative/unreadable-file behavior. It enforces at least 80% line and branch coverage over all four executable helper/CLI modules. Test and live-scenario entry points are excluded from helper coverage. These local HTTP fixtures verify the runner contract; they do not verify live product behavior.
