# Developers' e2e tests on a throw-away ILM

> Spike for ATF#165: the job runs on the branch `spike/165-throwaway-ilm` only. Names and paths may change before the nightly job exists.

These tests may break the platform on purpose: stop a connector, restart Core, switch the time-quality monitor off, change platform settings. They never run on a shared environment. They run on an ILM that a GitHub job builds from nothing on a kind cluster and throws away when the run ends.

## What the environment already has

The job builds the environment with `spike/165/env/up.sh`. It has:

- the ILM operator and a `Platform` on `develop-latest` images, with a managed database, messaging and Keycloak;
- the time-quality monitor sidecar in the Core pod;
- connectors: common credential provider, software cryptography provider, EJBCA NG and timestamp formatting;
- its own NTP server, Service `ntp`;
- its own EJBCA CE, `https://ejbca.ejbca.svc.cluster.local:8443`;
- a Traefik edge with client certificates at `https://ilm.kind.local:30443`.

Everything is in the namespace `ilm`.

## Add a test

1. Create a folder `tests/ephemeral/<your-test>/`.
2. Write the Playwright spec(s) in it. Use the helpers the other suites use:
   - `loadEnv()` and `getAuthenticatedApiContext()` to call the ILM API as the admin;
   - `getCustomObjectsApi()` and `getCoreApi()` (`utils/k8sClient`) to change the cluster. The job sets `KUBECONFIG_PATH`.
3. If the test needs something the base environment lacks, add Kubernetes manifests to `tests/ephemeral/<your-test>/env/`. Examples: another `Connector`, a mock server, a ConfigMap. The job applies every `env/` folder and waits for the deployments before any test starts.
   - Give your own objects your own names, so that changing them does not disturb other tests.
4. Clean up what the test changed in a `finally` block. This includes registrations in ILM and scaled-down connectors.
5. Push to the branch and open the workflow run.

`connector-outage/` is the example:

- its `env/` deploys a Network Discovery connector of its own;
- the spec registers that connector in ILM;
- the spec scales the `Connector` to 0 and checks that ILM's health check of it is no longer `ok`;
- the spec scales it back to 1 and checks that the health check is `ok` again.

## Run it

On GitHub: the workflow `.github/workflows/throwaway-ilm-spike.yml` runs this step: `Developers' e2e tests`.

On your machine:

1. Bring the environment up:

   ```sh
   OUT=/tmp/ilm-kind ILM_PRIVATE_PULL_USERNAME=... ILM_PRIVATE_PULL_PASSWORD=... bash spike/165/env/up.sh
   ```

   This needs Docker with about 10 GB of memory for the kind node, plus `kind`, `kubectl` and `helm`. It also needs a read-only pull login for `ilm-private`.

2. Write the env file:

   ```sh
   bash spike/165/env/atf-env.sh /tmp/ilm-kind
   ```

3. Run the tests:

   ```sh
   cd czertainly-e2e
   REG_ENV_FILE=/tmp/ilm-kind/atf.env npx playwright test -c playwright.ephemeral.config.ts
   ```

   The tests call `https://ilm.kind.local:30443`. Map that name to `127.0.0.1` in `/etc/hosts`.

The report is `test-results/ephemeral-junit.xml`.

## Rules

- **Never print the logs of the private containers.** The time-quality monitor and the timestamp formatting connector are private, and this repository and its job logs are public.
- **Never upload traces of their replies.**
- **A test must not depend on another test's state or order.** Each folder sets up what it needs.
