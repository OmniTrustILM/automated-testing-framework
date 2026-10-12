# CZERTAINLY-Automated-Testing-Framework

This is a framework for automated testing of CZERTAINLY.

CZERTAINLY platform is a microservice based application running in a Kubernetes cluster. The framework is designed to test the functionality of the platform by sending requests to the exposed endpoints of the microservices and checking the responses from outside of the cluster and inside of the cluster.

For testing the [Testkube](https://testkube.io/) is utilized and used.

## Regression suites

Alongside the Testkube tests, `regression/` holds suites that drive a locally built platform
rather than a deployed cluster. [regression/timestamping/](regression/timestamping/README.md)
exercises RFC 3161 timestamping end to end: it checks out every dependent repository,
including `development-environment`, rebuilds Core and the connector images, provisions the
environment and runs the API suite against it.
[regression/key-onboarding/](regression/key-onboarding/README.md) lists the key pairs on a
PKCS#11 token and onboards them against a stack that is already running.

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
