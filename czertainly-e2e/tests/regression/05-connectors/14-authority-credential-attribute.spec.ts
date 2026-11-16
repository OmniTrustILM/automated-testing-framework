/**
 * REG-CONN-14 — an own Basic credential used on an own authority (ilm#436).
 * A refusal that names a logon failure of the own credential at the CA skips with the reason; any other refusal fails.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { findCredentialConnector } from '../../../utils/regression/platform/connectorLookup';
import { findAuthoritySource, isCredentialLogonRefusal, probeOwnAuthorityLike } from '../../../utils/regression/config/authorities';
import { apiJson } from '../../../utils/regression/apiReads';
import { rowsNamed } from '../../../utils/regression/listReads';
import { describeHealth, healthByVersion } from '../../../utils/regression/platform/connectorApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import type { JsonObject } from '../../../utils/regression/json';
import { createOwnBasicCredential } from '../../../utils/regression/inventory/credentialsApi';
import { CONNECTOR_WRITE_TEST_MS } from '../../../utils/regression/timeouts';


const RULES = ['core/getCredentials is answered by core; a Basic credential is used on an authority; admin create guards'];

async function credentialOnAuthority(api: GuardedApi, own: OwnObjects, source: RegExp, testInfo: { annotations: Array<{ type: string; description?: string }> }): Promise<void> {
    const connector = await findCredentialConnector(api, 'Basic');
    test.skip(!connector, 'no connected credential connector offering the Basic kind on this tier (REG_CREDENTIAL_CONNECTOR)');
    const src = await findAuthoritySource(api, source);
    test.skip(!src, `no connected pre-existing authority on a ${source} connector to copy the settings from`);
    // A read before the first write: the connector the authority is created on must answer its LIVE health (a stored `connected` is not
    // enough).
    const health = await healthByVersion(api, { uuid: String(src!.connectorUuid), name: String(src!.connectorName), status: 'connected' });
    test.skip(!health.healthy, `the connector of the source authority does not answer its live health: ${describeHealth(health)}`);
    const credential = await test.step('Create an own Basic credential', async () => createOwnBasicCredential(api, own.spec, 'cred14', { connector: connector! }));
    const made = await test.step('Create an own authority with the source settings and the own credential', async () =>
        probeOwnAuthorityLike(api, own.spec, 'auth14', { source: src!, credential }));
    if (!made.ref) {
        const text = await made.answer.text;
        testInfo.annotations.push({ type: 'refused', description: `${made.answer.status} ${text.slice(0, 200)}` });
        await test.step('A refused creation leaves no authority of that name', async () => {
            const left = await rowsNamed(api, '/api/v1/authorities', made.name);
            // A row a refused create left behind is this run's: recorded and proven live before the assertion fails the test.
            if (left.length) await own.adoptNamed('authorities', made.name, { note: 'an authority a refused create left behind' });
            expect(left.length, 'a refused creation leaves nothing').toBe(0);
        });
        // The create was the probe: its answer is recorded and nothing is left behind. A connector that checks the own credential
        // against its CA refuses it at create; that is the one refusal named as a skip, every other refusal fails.
        test.skip(isCredentialLogonRefusal(text), `the connector validates the credential against its CA and refused the own test credential at create (${made.answer.status}): ${text.slice(0, 200)}`);
        // The gates were reads: the connector is alive and the source authority is connected, so any other refusal is the result.
        throw new Error(`the connector refused the authority with the own credential (${made.answer.status}): ${text.slice(0, 300)}`);
    }
    await test.step('The authority is connected and its credential attribute references the own credential', async () => {
        const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${made.ref!.uuid}`);
        expect(String(detail.status ?? '')).toMatch(/connected/i);
        const credentialAttr = ((detail.attributes ?? []) as JsonObject[]).find((a) => a.contentType === 'credential');
        expect(credentialAttr, 'the detail shows a credential attribute').toBeTruthy();
        expect(JSON.stringify(credentialAttr!.content), 'it references the own credential').toContain(credential.uuid);
    });
}

test.describe('Own credential on an authority', { tag: tags.regression }, () => {
    test('an own Basic credential is accepted on an own PyADCS authority and shown in its detail',
        testMeta({ id: 'REG-CONN-14', prio: 'P2', issue: 'ilm#436', rule: RULES }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            await credentialOnAuthority(api, own, /pyadcs/i, testInfo);
        });

    test.describe('on the local stack (EJBCA-NG)', () => {
        describeLocalOnly(test);
        test('an own Basic credential is accepted on an own EJBCA-NG authority',
            testMeta({ id: 'REG-CONN-14', row: 'local', prio: 'P2', issue: 'ilm#436', local: true, rule: RULES }),
            async ({ api, own }, testInfo) => {
                test.setTimeout(CONNECTOR_WRITE_TEST_MS);
                await credentialOnAuthority(api, own, /ejbca/i, testInfo);
            });
    });
});
