/**
 * API-GEN-41, API-GEN-42 — Credentials of the kinds ApiKey and SoftKeyStore. ilm#428.
 *
 * WHAT: 1. (API-GEN-41, ApiKey) An own credential with valid attributes → 201; the detail shows the kind, the connector and the secret
 *          attributes without data, and the list lists it; the plain secrets are in no body; deleting it → 204, then 404.
 *       2. (API-GEN-41) Each required attribute left out in turn → 422 and nothing stays behind.
 *       3. (API-GEN-42, SoftKeyStore) The same two rows for a credential built from a PKCS#12 keystore the runner generates: type PKCS12,
 *          password and file.
 * WHY: the credential provider offers three kinds and only Basic had a test; a kind that cannot be created from its own definitions, or
 *      shows a secret in a detail or a list, is a defect the Basic rows do not show. A missing required attribute is refused by the
 *      connector and relayed as 422 (interfaces#898).
 * HOW: create-only on shared tiers with run-prefixed names; the attributes come from the live definitions of the kind, the secrets and
 *      the keystore are generated per run and logged nowhere. Every create goes through `createOwn` or a probe that records an accepted
 *      create in the ledger before any assertion, and a credential row that a refused create left behind is adopted by its unique name.
 *      A row skips with the named reason when no connected credential connector offers the kind (a read, before anything is written).
 *      Env: REG_CREDENTIAL_CONNECTOR (the connector to prefer).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { deleteOwnAndProveGone, refused422 } from '../../../utils/regression/inventory/configProbes';
import { adoptByName, attributeOf, containsSecret, contentWithData, findRowByUuid, probeCredential, randomSecret, readCredential } from '../../../utils/regression/inventory/credentialsApi';
import { apiKeyAttributes, createOwnKindCredential, kindBody, kindConnector, omittableRequired, softKeyStoreAttributes, withoutAttribute, type BuiltAttributes, type CredentialKind, type KindConnector } from '../../../utils/regression/inventory/credentialKinds';
import { labelOf } from '../../../utils/regression/inventory/raProfileValidation';
import { selfSignedPkcs12 } from '../../../utils/regression/pkiBuilders';
import { readAnswer } from '../../../utils/regression/inventory/searchApi';
import { escapeRegExp } from '../../../utils/regression/text';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { JsonObject } from '../../../utils/regression/json';

const ISSUE = 'ilm#428';

/**
 * The connector of the kind and the attributes of a valid credential, or the row skips with the named reason (reads only). A SoftKeyStore
 * keystore is encrypted with the very password the credential sends.
 */
async function setupOf(kind: CredentialKind, api: GuardedApi): Promise<{ connector: KindConnector; built: BuiltAttributes }> {
    const found = await kindConnector(api, kind);
    test.skip(!found.ok, found.skip ?? `no ${kind} credential connector`);
    const connector = found.ok!;
    const password = randomSecret();
    const built = kind === 'ApiKey'
        ? apiKeyAttributes(connector.defs)
        : softKeyStoreAttributes(connector.defs, { password, p12: selfSignedPkcs12(ownName('ks'), password) });
    test.skip('problem' in built, 'problem' in built ? `${connector.name}: ${built.problem}` : '');
    return { connector, built: built as BuiltAttributes };
}

const KINDS: ReadonlyArray<{ kind: CredentialKind; id: 'API-GEN-41' | 'API-GEN-42'; suffix: string }> = [
    { kind: 'ApiKey', id: 'API-GEN-41', suffix: 'apikey' },
    { kind: 'SoftKeyStore', id: 'API-GEN-42', suffix: 'softks' },
];

test.describe('credential kinds', { tag: tags.api }, () => {
    for (const { kind, id, suffix } of KINDS) {
        test(`an own ${kind} credential is created, read back with masked secrets and deleted`,
            testMeta({ id, row: 'create-read-delete', prio: 'P2', issue: ISSUE, rule: ['SECRET content is serialised with data null: ResponseAttributeSerializer; core#202, interfaces#125', 'the attributes of a credential come from its kind: GET /v1/connectors/{uuid}/attributes/credentialProvider/{kind}', 'delete: 204, then 404'] }),
            async ({ api, own }) => {
                const { connector, built } = await setupOf(kind, api);
                const credential = await createOwnKindCredential(api, own.spec, suffix, { connector, kind, attributes: built.attributes });

                await test.step('the 201 answer carries no secret', async () => {
                    for (const secret of built.secrets) expect(containsSecret(credential.createText, secret), 'a plain secret is not in the create answer').toBe(false);
                });
                await test.step('the detail shows the kind and connector and masks every secret attribute', async () => {
                    const read = await readCredential(api, credential.uuid);
                    expect(read.status, read.text.slice(0, 300)).toBe(200);
                    const detail = read.json as JsonObject;
                    expect([detail.name, detail.kind, detail.connectorUuid]).toEqual([credential.name, kind, connector.uuid]);
                    for (const a of (detail.attributes ?? []) as JsonObject[]) {
                        if (String(a.contentType).toLowerCase() === 'secret') expect(contentWithData(a), `attribute ${String(a.name)}: no secret data`).toEqual([]);
                    }
                    expect(built.attributes.every((a) => attributeOf(detail, String(a.name))), 'every attribute sent is listed in the detail').toBe(true);
                    for (const secret of built.secrets) expect(containsSecret(read.text, secret), 'a plain secret is not in the detail').toBe(false);
                });
                await test.step('the list has the credential and no plain secret', async () => {
                    const list = await readAnswer(api, '/api/v1/credentials');
                    expect(list.status, list.text.slice(0, 300)).toBe(200);
                    const row = (list.json as JsonObject[]).find((r) => r.uuid === credential.uuid);
                    expect(row, 'the own credential is listed').toBeTruthy();
                    expect(row!.kind).toBe(kind);
                    for (const secret of built.secrets) expect(containsSecret(list.text, secret), 'a plain secret is not in the list').toBe(false);
                });
                await deleteOwnAndProveGone(api, 'credentials', credential, 'Credential', own.spec);
                expect(await findRowByUuid(api, '/api/v1/credentials', credential.uuid), 'the credential is not listed any more').toBeUndefined();
            });

        test(`a ${kind} credential without a required attribute is refused 422`,
            testMeta({ id, row: 'missing-required', prio: 'P2', issue: ISSUE, rule: ['the connector decides the required attributes and its 422 is relayed as 422 (interfaces#898)', 'the credential row is saved before the attribute lookup fails (core#2512): an orphan is adopted and removed'] }),
            async ({ api, own }) => {
                const { connector, built } = await setupOf(kind, api);
                const omit = omittableRequired(connector.defs, built.attributes);
                test.skip(!omit.length, `${connector.name}: the ${kind} kind has no required attribute to leave out`);
                for (const attribute of omit) {
                    await test.step(`without ${attribute}`, async () => {
                        const name = ownName(`${suffix}-no-${attribute}`.slice(0, 40));
                        const probe = await probeCredential(api, own.spec, await kindBody(api, connector, kind, name, withoutAttribute(built.attributes, attribute)), `${kind} create without ${attribute}`);
                        // An orphan row of the refused create is the run's own: the ledger gets it before the first assertion.
                        await adoptByName(api, '/api/v1/credentials', 'credentials', name, own.spec, `orphan of a refused ${kind} create without ${attribute}`);
                        const messages = refused422(probe);
                        const def = connector.defs.find((d) => d.name === attribute) ?? {};
                        expect(messages.join(' ').toLowerCase(), `the refusal names ${attribute}`).toMatch(new RegExp(`${escapeRegExp(labelOf(def))}|${escapeRegExp(attribute)}`.toLowerCase()));
                    });
                }
            });
    }
});
