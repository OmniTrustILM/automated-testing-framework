/**
 * API-PROT-31 — a protocol POST with the wrong Content-Type is refused with 415 (RFC 9110 §15.5.16). ilm#430, core#2140.
 * The ACME directory and one own CMP profile are created once and recorded in the ledger; the refused requests create nothing.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AcmeClient } from '../../../utils/regression/protocols/acmeClient';
import { GuardedApi } from '../../../utils/regression/guard/types';
import { ProtocolResponse, protocolPost, stackTextIn } from '../../../utils/regression/protocols/protocolHttp';
import { createOwnCmpProfile, enableOwnCmpProfile, ensureCmpActiveOnOwnRaProfile, randomSecret } from '../../../utils/regression/protocols/protocolProfiles';
import { ensureProtocolRaProfile, ensureAcmeOnRaProfile } from '../../../utils/regression/ownRaProfiles';
import { testMeta, tags } from '../../../utils/regression/tags';

test.describe('protocol POSTs with the wrong Content-Type', { tag: tags.api }, () => {
    let acmeNewAccountUrl: string | undefined;
    let cmpUrl: string | undefined;

    async function acmeTarget(api: GuardedApi, spec: string): Promise<string> {
        if (acmeNewAccountUrl) return acmeNewAccountUrl;
        const { directoryUrl } = await ensureAcmeOnRaProfile(api, spec);
        const dir = await new AcmeClient(directoryUrl).init();
        acmeNewAccountUrl = String(dir.newAccount);
        return acmeNewAccountUrl;
    }

    async function cmpTarget(api: GuardedApi, spec: string): Promise<string> {
        if (cmpUrl) return cmpUrl;
        const ra = await ensureProtocolRaProfile(api, spec, 'cmp-api');
        const cmp = await createOwnCmpProfile(api, spec, 'cmp-ct', { sharedSecret: randomSecret(), note: 'CMP profile for the content-type refusal rows' });
        await enableOwnCmpProfile(api, cmp);
        cmpUrl = await ensureCmpActiveOnOwnRaProfile(api, ra, cmp);
        return cmpUrl;
    }

    /** The rule: 415, a body without stack or class text. */
    function expect415(res: ProtocolResponse): void {
        expect(stackTextIn(res.text), 'no class names or stack text in the body').toBeUndefined();
        expect(res.status, `status with body ${res.text.slice(0, 200)}`).toBe(415);
    }

    test('an ACME JWS sent as JSON is refused with 415',
        testMeta({
            id: 'API-PROT-31', row: 'ACME new-account as application/json', prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: 'core#2140',
            rule: ['a Content-Type mismatch is answered 500 instead of 415 (core#2140, open); RFC 9110 §15.5.16: 415 Unsupported Media Type', 'ilm#430 table: the ACME controller consumes application/jose+json only'],
        }),
        async ({ api, own }) => {
            const url = await test.step('Prerequisite: the RA-profile ACME directory of the run', async () => acmeTarget(api, own.spec));
            const body = JSON.stringify({ protected: 'e30', payload: 'e30', signature: 'AA' });
            const res = await test.step('POST new-account with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body }));
            expect(res.status, `the JSON body is refused: ${res.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            await test.step('415 and a body without stack text', async () => expect415(res));
        });

    test('a CMP POST sent as JSON is refused with 415',
        testMeta({
            id: 'API-PROT-31', row: 'CMP POST as application/json', prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: 'core#2140',
            rule: ['POST with a non-application/pkixcmp Content-Type → 500 (core#2140; ilm#430 table "CMP JSON body 500" on both stacks); the rule is 415 (RFC 9110 §15.5.16)'],
        }),
        async ({ api, own }) => {
            const url = await test.step('Prerequisite: an own CMP profile activated on the dedicated RA profile', async () => cmpTarget(api, own.spec));
            const res = await test.step('POST the CMP URL with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body: '{}' }));
            expect(res.status, `the JSON body is refused: ${res.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            await test.step('415 and a body without stack text', async () => expect415(res));
        });
});
