# CZERTAINLY-Automated-Testing-Framework

This is a framework for automated testing of CZERTAINLY.

CZERTAINLY platform is a microservice based application running in a Kubernetes cluster. The framework is designed to test the functionality of the platform by sending requests to the exposed endpoints of the microservices and checking the responses from outside of the cluster and inside of the cluster.

For testing the [Testkube](https://testkube.io/) is utilized and used.

## How to run the tests

Each test is defined in a separate folder and identified by a unique name. The structure of the test folder is as follows:
- `variables.json` - contains the variables used in the test, for the list of available variables see [Variables](#variables)
- `czertainly-values.yaml` - contains the values for the installation of the CZERTAINLY platform (defines the application)
- `tests` folder - contains tests definition, see the [Tests folder structure](#tests-folder-structure) for more information
- `initdb` folder - contains the SQL scripts for the initialization of the database

Tests are run according to the schedule using pre-defined workflows. The workflows are defined in the `.github/workflows` folder.
The workflow runs the tests included in the workflow [matrix strategy](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs).

Tests can be included and removed as required in the workflow definition using the unique name of the test folder.

## Variables

The variables are defined in the `variables.json` file that must be present in each test folder. The variables are used in the tests to define the behaviour of the workflow and running services, including parameters to build the testing environment with testing data.

The variables are defined in the following format:

```json
{
  "k8s-cluster": {
    "dist": "microk8s" <-- the distribution of the Kubernetes cluster, currently only microk8s is supported
  },
  "postgresql": {
    "version": 15 <-- the tag of the PostgreSQL container database that should be used for testing 
  },
  "czertainly": {
    "version": "2.10.0" <-- version of the CZERTAINLY Helm Chart that should be used for testing
  }
}
```

## Tests folder structure

The tests are defined in the `tests` folder under the unique test folder. It contains test and test-suite CRDs that define the tests to be run using the Testkube framework.

CRDs should be prepared using Testkube tools and documentation and then added to the `tests` folder.

Tests are organized as follows:
- `test` folder - contains test CRDs
- `test-suite` folder - contains the test-suite CRDs

## Cleanup is part of the test result

Anything a spec or `globalSetup` creates must be removed again, and a run that fails to remove it
does not pass. Cleanup failures are not warnings to be skimmed past: an object left in a shared
environment gets in the way of everyone using it, and a 500 answered by the platform during a
delete is a defect that would otherwise never reach anyone, because the run was green.

Failures are collected in `.smoke-cleanup.jsonl` — a file rather than memory, because specs run in
worker processes and `globalTeardown` runs in the main one. At the end of the run `globalTeardown`
prints one summary naming every object left behind, with its resource type, uuid, name and the
status the platform returned, and then fails the run.

When writing a new spec, record cleanup failures instead of only logging them:

```ts
import { recordCleanupFailure, statusOf } from '../../utils/cleanupLedger';

try {
    await deleteThing(api, uuid);
} catch (e) {
    recordCleanupFailure({ resource: 'thing', uuid, status: statusOf(e), message: String(e) });
}
```

For a chain of objects, use `attemptCleanup`, which retries once — deleting something immediately
after the operation that changed it can lose a race the platform wins a moment later — and accepts
`blockedBy`, so that an object still held by one further down the chain is reported as a
consequence rather than as a second cause.

Iterative local runs started with `SMOKE_PERSIST=true` skip teardown entirely and are expected to
leave their fixtures in place; nothing here applies to them.
