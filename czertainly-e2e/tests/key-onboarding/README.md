# Key onboarding block (`@dev-tests`)

## WHAT

The developers' suite for ilm#409, "one-time list and onboard of existing token keys", ported by QA into the regression
config as its own block: four specs (`10-listing`, `20-onboarding`, `25-merge`, `30-removal`, same titles, order and
assertions as the source), every test tagged `@dev-tests @key-onboarding @local` and `@issue:ilm#409`. They list the key
pairs on a PKCS#11 token, onboard planted pairs into the inventory (one under a chosen name, one into the key a
certificate already brought in), sign with them through Core, and remove keys from the inventory one at a time and in
bulk. Test bodies, assertions and titles are the developers'; only the plumbing and a few names changed.

## WHY

The source suite provisioned with a bash script (fixed names, reuse of what exists, state files) and called the API with
the administrator's client certificate. In the regression framework every object is created per run, named
`<run id>-...`, written to the ledger right after its create and deleted by the run-end teardown; admin calls go through
the guard. The block needs a PKCS#11 connector with key listing, a SoftHSM token behind its proxy sidecar and docker on
the runner (to plant key pairs on the token the way a tool outside the platform would), so it runs on a proven local stack
only; a stack without them makes every test skip with the reason.

## HOW

- Setup (`key-onboarding.setup.ts`, its own project) checks the prerequisites, creates the run's objects, plants the key
  pairs and writes `<REG_STATE_DIR>/<run id>.key-onboarding.json`. Specs only READ it, lazily inside tests
  (`utils/keyOnboarding/provisioning.ts`).
- Fixtures (`utils/keyOnboarding/fixtures.ts`): `admin` (AdminApi over the guarded `api`, here the framework's `localApi`),
  `adminWorker` (the same over a worker-scoped local-stack guard, for hooks) and `provisioned` (the ready provisioning). A test skips with the setup's reason when the block is unavailable.
- Every spec calls `describeLocalOnly(test)`; the `api` of the fixtures is `localApi`, the guard with the local-stack option (it needs a proven local stack and a `@local` test).
- Ledger spec of the objects a test creates: `key-onboarding/<file stem>`. Every key a test onboards into a new key or
  creates, the run's custom attribute and the uploaded certificate (with the key Core links to it) are recorded right
  after the call answers; every key a test removes from the inventory gets a `deleted` line.

### Run

```
REG_ENV_FILE=<local-stack env file> TIER_KIND=local DEV_BLOCK=key-onboarding \
  npx playwright test -c playwright.devblock.config.ts
```

The regression config holds no `@dev-tests` test; see tests/dev-blocks/README.md.

### Environment (utils/keyOnboarding/config.ts)

| Variable | Default |
|---|---|
| KO_PKCS11_CONNECTOR_URL | http://localhost:8290 (the PKCS#11 connector as core reaches it; needs the key listing feature) |
| KO_VAULT_CONNECTOR_URL | http://localhost:8200 (the credential provider v2 connector with the secret interface) |
| KO_PKCS11_PROFILE | softhsm |
| KO_PKCS11_TOKEN | softhsm |
| KO_TOKEN_PIN | unset; no default, the block is unavailable without it |
| KO_SIDECAR_CONTAINER | pkcs11-sidecar-softhsm |

### One setup, one teardown

- Setup creates, for this run and with run-prefixed names: a vault instance, a vault profile, the secret holding the token
  PIN, the token on the PKCS#11 connector and its token profile. Both connectors are pre-existing parents: never
  registered, approved or changed here. It then plants the key pairs under labels `<run id>-ko-<role>` (RSA with an ID,
  EC with a short ID, EC without an ID, two EC pairs sharing an ID, an RSA private key without its public key, the pairs
  the removal specs use, and an EC pair whose public key a certificate carries).
- Teardown removes the ILM objects of the block in reference order (the framework's order: keys and certificates before
  the token profile and token, the secret before the vault profile and instance) through the run-end delete engine, then removes the token objects whose
  label starts with this run's id (private keys, public keys, certificates). The token objects go last, only after every
  ILM key of the block is gone: otherwise Core keeps a key whose token objects vanished.
- The token step is skipped (and says so in the teardown's annotation) when a platform object could not be deleted or was
  kept, e.g. the key core derived from the certified pair's certificate once it holds the token pair (the keys handler
  keeps a derived key that is in a token): removing the token objects then would leave core with a key whose pair is gone.
- What can stay behind: token objects when the run is cut off before the teardown, or when the token step was skipped or
  failed (its error names the exact label prefix and the command that removes them); a key a test removed from the
  inventory stays on the token until that last step. The prefix is the full run id, so planted pairs of earlier runs are
  never touched.
- Running on a shared tier needs, besides a tier with the PKCS#11 connector and a token: guard rules for the
  token-key routes (`tokenKeys`, `onboard`, `removeFromInventory`; today they pass only on a proven local stack) and a way
  to plant key pairs that does not need docker on the runner.

## Changes against the source

- Names: the custom attribute is `<run id>-cost-center` (was `key-onboarding-cost-center`) and is created per run, never
  looked up or enabled when it already exists; the key `createKeyPair` makes is `<run id>-created` (was
  `ko-created-<time>`); the EC pair is onboarded as `<ec label>-edge-signer` (was `Edge signer <ec label>`).
- The certified pair's certificate is uploaded through the framework's own-certificate helper (base64 of the PEM, which
  core reads like the DER the source sent; the regression specs upload the same way), named after the pair's label; the
  helper also records the key core derives from it.
- 30-removal: the group's `beforeAll` is kept; it uses the worker-scoped admin `adminWorker`: the framework's `workerApi` is the plain guard, which refuses this block's onboarding and removal calls, so `adminWorker` is built with `withWorkerApi(..., { localStack: true })` (fixtures/regressionFixtures.ts), which refuses off a proven local stack and renews the token when it runs low and reads the summary
  in its body (`provisioningOrSkip()`), since a hook cannot use the per-test fixtures; a skip there skips the group.
- Ledger lines added after the calls named above; nothing else in a test body changed.

## Known weak spots kept as in the source (for the authors)

- 10: the paging test takes a page size of a third of the listing; with very few pairs it degenerates to one page.
- 10 / 20: message texts (`no public key`, `without an ID unique to it`, `compromised`) are matched as substrings.
- 20 / 25: signing answers only the scheme and digest the suite names (PKCS1-v1_5, SHA-256) for every attribute Core asks
  for; an algorithm that asks for another attribute fails with the suite's own error, not a product defect.
- 20 / 30: `keyUuid ?? ''` turns a missing uuid into a request for `/v1/keys/`, which fails with a less direct message.
- 20: the test after the onboarding reads `results[0]`, so it depends on the first test passing (serial group).
- No case for: onboarding without the permission, a connector without key listing, an empty token, a token key whose
  algorithm Core does not know, concurrent onboarding of the same pair.

The block is outside the spec lint (tests/unit/specGuards.spec.ts) by design, like the timestamping block: openssl / docker run as
child processes on the runner and the token calls pass only under the guard's `localStack` option. Its safety rests on `@local` on
every test, `describeLocalOnly`, the guarded admin API with the local-stack proof, and the ledger. The calls that list, onboard and
remove token keys are not in the guard's own API words, so the block passes only on a proven local stack, by design.
