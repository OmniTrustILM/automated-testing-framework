/**
 * prot-known-bugs — protocol rows that pin a FILED product bug with `test.fail()` (B2: API-PROT-31, core#2140).
 *
 * The rule (protocols rules §1 cross-protocol, C-X1): a protocol POST with the wrong Content-Type must be refused
 * with 415 (RFC 9110 §15.5.16), never answered 500. Today core answers 500 (core#2140, open), so each parameter is
 * `test.fail()` with `@bug:core#2140`: the test asserts the rule and turns red (unexpected pass) once the bug is
 * fixed, when the marker is removed. Nothing is created: both requests are refused before any object exists.
 * Targets: the RA-profile ACME `new-account` URL of the run ACME profile and the RA-profile CMP URL of an own CMP
 * profile activated on a dedicated own RA profile (RA*).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { AcmeClient } from '../../utils/regression/acmeClient';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { ProtocolResponse, protocolPost, stackTextIn } from '../../utils/regression/protocolHttp';
import { createOwnCmpProfile, enableOwnCmpProfile, ensureCmpActiveOnOwnRaProfile, ensureProtocolRaProfile, randomSecret } from '../../utils/regression/protocolProfiles';
import { ensureAcmeOnRaProfile, orSkipWithoutCa } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'API-PROT-31';
const skip = (reason: string) => test.skip(true, reason);

test.describe('@api prot-known-bugs', () => {
    let acmeNewAccountUrl: string | undefined;
    let cmpUrl: string | undefined;

    async function acmeTarget(api: GuardedApi): Promise<string> {
        if (acmeNewAccountUrl) return acmeNewAccountUrl;
        const { directoryUrl } = await orSkipWithoutCa(ensureAcmeOnRaProfile(api, SPEC), skip);
        const dir = await new AcmeClient(directoryUrl).init();
        acmeNewAccountUrl = String(dir.newAccount);
        return acmeNewAccountUrl;
    }

    async function cmpTarget(api: GuardedApi): Promise<string> {
        if (cmpUrl) return cmpUrl;
        const ra = await orSkipWithoutCa(ensureProtocolRaProfile(api, SPEC, 'cmp-api'), skip);
        const cmp = await createOwnCmpProfile(api, SPEC, { name: regName(`cmp-ct-${Date.now().toString(36)}`), sharedSecret: randomSecret() }, 'CMP profile for the content-type pin (API-PROT-31)');
        await enableOwnCmpProfile(api, cmp);
        cmpUrl = await ensureCmpActiveOnOwnRaProfile(api, ra, cmp);
        return cmpUrl;
    }

    /** The rule: 415, a body without stack or class text. */
    function expect415(res: ProtocolResponse): void {
        expect(stackTextIn(res.text), 'no class names or stack text in the body').toBeUndefined();
        expect(res.status, `status with body ${res.text.slice(0, 200)}`).toBe(415);
    }

    test('API-PROT-31[ACME new-account as application/json]: a JWS posted as application/json is refused with 415, not 500',
        meta({
            id: 'API-PROT-31', prio: 'P1', issue: 'ilm#430', bug: 'core#2140',
            rule: ['protocols §1 cross-protocol / C-X1: a Content-Type mismatch is answered 500 instead of 415 (core#2140, open); RFC 9110 §15.5.16: 415 Unsupported Media Type', 'ilm#430 table: the ACME controller consumes application/jose+json only'],
        }),
        async ({ api }) => {
            const url = await test.step('Prerequisite: the RA-profile ACME directory of the run', async () => acmeTarget(api));
            const body = JSON.stringify({ protected: 'e30', payload: 'e30', signature: 'AA' });
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            const res = await test.step('POST new-account with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body }));
            await test.step('415 and a body without stack text', async () => expect415(res));
        });

    test('API-PROT-31[CMP POST as application/json]: a CMP POST as application/json is refused with 415, not 500',
        meta({
            id: 'API-PROT-31', prio: 'P1', issue: 'ilm#430', bug: 'core#2140',
            rule: ['protocols §8.2 r6: POST with a non-application/pkixcmp Content-Type → 500 (core#2140; ilm#430 table "CMP JSON body 500" on both stacks); the rule is 415 (RFC 9110 §15.5.16)', 'protocols §1 C-X1'],
        }),
        async ({ api }) => {
            const url = await test.step('Prerequisite: an own CMP profile activated on RA*', async () => cmpTarget(api));
            test.fail(true, 'core#2140: a wrong Content-Type on a protocol POST answers 500 instead of 415');
            const res = await test.step('POST the CMP URL with Content-Type application/json', async () => protocolPost(url, { contentType: 'application/json', body: '{}' }));
            await test.step('415 and a body without stack text', async () => expect415(res));
        });
});
