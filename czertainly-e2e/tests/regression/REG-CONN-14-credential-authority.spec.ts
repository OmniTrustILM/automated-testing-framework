/**
 * REG-CONN-14 — an own Basic credential (common credential provider) used on an authority (ilm#436, T12; platform area).
 *
 * Shared tier (S-own): the own credential is created on the credential connector; the authority is an OWN authority on
 * the same connector as a pre-existing PyADCS authority, with that authority's connector attributes copied read-only
 * and the credential attribute replaced by the own credential (no CA host is written into the suite; the source is
 * only read). Its detail names the own credential. A refused creation (the connector cannot reach the CA) leaves no
 * authority of the run name behind and skips with the connector's text (never a pass). The local arm does the same
 * on the EJBCA-NG authority of the local stack. The credential callback of the authority FORM (`core/getCredentials`
 * through the pre-existing connector) is guard request G-3: `[callback]` is `test.fixme` with its body.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnAuthorityLike, createOwnBasicCredential, findAuthoritySource, findCredentialConnector } from '../../utils/regression/platformApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const SPEC = 'REG-CONN-14';
type Json = Record<string, any>;

const RULES = ['platform-keys-connectors A4 r15 (core/getCredentials answered by core), P-CONN credential row (Basic credential used on an authority); A4 r3 (admin create guards)'];

async function credentialOnAuthority(api: GuardedApi, source: RegExp, testInfo: { annotations: Array<{ type: string; description?: string }> }): Promise<void> {
    const connector = await findCredentialConnector(api, 'Basic');
    test.skip(!connector, 'no connected credential connector offering the Basic kind on this tier (REG_CREDENTIAL_CONNECTOR)');
    const src = await findAuthoritySource(api, source);
    test.skip(!src, `no connected pre-existing authority on a ${source} connector to copy the settings from`);
    const credential = await createOwnBasicCredential(api, connector!, `cred14-${Date.now().toString(36)}`, SPEC);
    const made = await createOwnAuthorityLike(api, src!, credential, `auth14-${Date.now().toString(36)}`, SPEC);
    if (!made.ref) {
        const text = await made.response.text();
        testInfo.annotations.push({ type: 'refused', description: `${made.response.status()} ${text.slice(0, 200)}` });
        const all = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
        expect(all.some((a) => a.name === made.name), 'a refused creation leaves nothing').toBe(false);
        test.skip(true, `the connector refused the authority with the own credential (${made.response.status()}): environment gate, not a pass`);
    }
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${made.ref!.uuid}`);
    expect(String(detail.status ?? '')).toMatch(/connected/i);
    const credentialAttr = ((detail.attributes ?? []) as Json[]).find((a) => a.contentType === 'credential');
    expect(credentialAttr, 'the detail shows a credential attribute').toBeTruthy();
    expect(JSON.stringify(credentialAttr!.content), 'it references the own credential').toContain(credential.uuid);
}

test.describe('REG-CONN own credential on an authority', { tag: tags.regression }, () => {
    test('REG-CONN-14: an own Basic credential is accepted on an own PyADCS authority (settings copied from a pre-existing one); the detail references the credential; a refused creation leaves nothing',
        meta({ id: 'REG-CONN-14', prio: 'P1', issue: 'ilm#436', rule: RULES }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            await credentialOnAuthority(api, /pyadcs/i, testInfo);
        });

    test.fixme('REG-CONN-14[callback]: the authority form\'s credential callback (core/getCredentials, kind Basic) lists the run\'s own credential',
        meta({ id: 'REG-CONN-14', prio: 'P1', issue: 'ilm#436', rule: RULES }),
        async ({ api }, testInfo) => {
            test.setTimeout(60_000);
            testInfo.annotations.push({ type: 'fixme', description: 'guard request G-3: a callback POST on a pre-existing connector is ownership-refused' });
            const connector = await findCredentialConnector(api, 'Basic');
            test.skip(!connector, 'no credential connector');
            const credential = await createOwnBasicCredential(api, connector!, `cred14c-${Date.now().toString(36)}`, SPEC);
            const src = await findAuthoritySource(api, /pyadcs/i);
            test.skip(!src, 'no PyADCS authority');
            const defs = await apiJson<Json[]>(api, 'GET', `/api/v1/connectors/${src!.connectorUuid}/attributes/authorityProvider/${src!.kind}`);
            const attr = defs.find((d) => d.contentType === 'credential');
            const res = await api.post(`/api/v1/connectors/${src!.connectorUuid}/authorityProvider/${src!.kind}/callback`, {
                data: { uuid: attr?.uuid, name: attr?.name, pathVariables: { credentialKind: 'Basic' }, queryParameters: {}, requestBody: {} },
            });
            expect(res.status()).toBe(200);
            expect(JSON.stringify(await res.json())).toContain(credential.uuid);
        });

    test.describe('on the local stack (EJBCA-NG)', () => {
        describeLocal(test);
        test('REG-CONN-14[local]: an own Basic credential is accepted on an own EJBCA-NG authority; the detail references the credential',
            meta({ id: 'REG-CONN-14', prio: 'P1', issue: 'ilm#436', local: true, rule: RULES }),
            async ({ api }, testInfo) => {
                test.setTimeout(120_000);
                await credentialOnAuthority(api, /ejbca/i, testInfo);
            });
    });
});
