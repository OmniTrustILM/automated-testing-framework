/**
 * API-PROT-31 — A protocol POST with the wrong Content-Type is refused with 415. ilm#430, core#2140.
 *
 * WHAT: 1. An ACME JWS (new-account) sent as application/json → 415 with a body free of stack and class text.
 *       2. A CMP message sent as application/json → 415 with a body free of stack and class text.
 * WHY: RFC 9110 §15.5.16: an unsupported media type is a 415, never a 500. Today core answers 500 (known bug core#2140, open), so both
 *      tests carry the bug marker with `test.fail()` and turn red once it is fixed.
 * HOW: the ACME directory of the run RA profile and one own CMP profile activated on the dedicated own RA profile are created once
 *      (recorded in the ledger; skip with the named reason without a CA). The refused requests create nothing.
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
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            const res = await test.step('POST new-account with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body }));
            await test.step('415 and a body without stack text', async () => expect415(res));
        });

    test('a CMP POST sent as JSON is refused with 415',
        testMeta({
            id: 'API-PROT-31', row: 'CMP POST as application/json', prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: 'core#2140',
            rule: ['POST with a non-application/pkixcmp Content-Type → 500 (core#2140; ilm#430 table "CMP JSON body 500" on both stacks); the rule is 415 (RFC 9110 §15.5.16)'],
        }),
        async ({ api, own }) => {
            const url = await test.step('Prerequisite: an own CMP profile activated on the dedicated RA profile', async () => cmpTarget(api, own.spec));
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            const res = await test.step('POST the CMP URL with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body: '{}' }));
            await test.step('415 and a body without stack text', async () => expect415(res));
        });
});
