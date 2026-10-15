/**
 * prot-cmp — CMP endpoint pins at the HTTP level (B2: API-PROT-39, ilm#430 step 9: "CMP garbage body → CMP error
 * message, CMPSRV100" on both stacks).
 *
 * Rule (protocols rules §8.2 r6–r7): every CMP protocol error is HTTP 200 + `application/pkixcmp` + a PKIMessage
 * whose body is `error` [23] with a `rejection` status (RFC 4210 §5.3.21); an unparseable request is an unprotected
 * error with failInfo `badRequest` and the status text `CMPSRV100: pki message request cannot be parsed`
 * (interfaces ImplFailureInfo, PkiMessageError). Parameters: garbage bytes, an empty body, a real PKIMessage cut
 * short; each posted as `application/pkixcmp` to the RA-profile URL and to the profile-based URL of one own CMP
 * profile (RA* as its default RA profile and activated on RA*). The EMPTY body never reaches the CMP service: Spring
 * refuses the missing required `@RequestBody byte[]` (CmpController :44-46) with 400 `{"message":"Unable to read HTTP
 * message…"}` (reviewer F4; the ledger's "same class, probe once" resolved from the controller binding). The exact
 * text of the truncated answer is recorded as an annotation (ledger: probe once); GET → 500 and the JSON-body 500
 * belong to other rows. The garbage bytes are FIXED (a sha256 chain of a constant), so a failure replays byte for byte.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { buildErrorPkiMessage, errorRejectionProblems, parsePkiMessage } from '../../utils/regression/cmpAsn1';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { fixedGarbage, protocolPost, ProtocolResponse, stackTextIn } from '../../utils/regression/protocolHttp';
import {
    cmpProfileUrl, createOwnCmpProfile, enableOwnCmpProfile, ensureCmpActiveOnOwnRaProfile, ensureProtocolRaProfile, randomSecret,
} from '../../utils/regression/protocolProfiles';
import { orSkipWithoutCa } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'API-PROT-39';
const skip = (reason: string) => test.skip(true, reason);

interface CmpTargets {
    raUrl: string;
    profileUrl: string;
}

const PKIXCMP = /^application\/pkixcmp\b/i;

test.describe('@api prot-cmp', () => {
    let shared: CmpTargets | undefined;

    async function targets(api: GuardedApi, env: { baseUrl: string }): Promise<CmpTargets> {
        if (shared) return shared;
        const ra = await orSkipWithoutCa(ensureProtocolRaProfile(api, SPEC, 'cmp-api'), skip);
        const cmp = await createOwnCmpProfile(api, SPEC, { name: regName(`cmp-pin-${Date.now().toString(36)}`), sharedSecret: randomSecret(), raProfileUuid: ra.uuid },
            'CMP profile with RA* as default RA, activated on RA* (API-PROT-39)');
        await enableOwnCmpProfile(api, cmp);
        const raUrl = await ensureCmpActiveOnOwnRaProfile(api, ra, cmp);
        shared = { raUrl, profileUrl: cmpProfileUrl(env.baseUrl, cmp.name) };
        return shared;
    }

    /** The common oracle: 200 application/pkixcmp, a PKIMessage with an error body and a rejection status. */
    function expectErrorMessage(res: ProtocolResponse) {
        expect(res.status, res.text.slice(0, 200)).toBe(200);
        expect(res.contentType ?? '', 'Content-Type application/pkixcmp').toMatch(PKIXCMP);
        const message = parsePkiMessage(res.body);
        expect(errorRejectionProblems(message)).toEqual([]);
        return message.error!;
    }

    const BODIES: Array<{ name: string; body: () => Buffer; exact: boolean }> = [
        { name: 'garbage bytes', body: () => fixedGarbage('API-PROT-39', 200), exact: true },
        { name: 'truncated DER', body: () => { const whole = buildErrorPkiMessage({ failInfoBits: [2], statusString: 'qa truncated' }); return whole.subarray(0, Math.floor(whole.length * 0.6)); }, exact: false },
    ];

    for (const where of ['RA-profile', 'profile'] as const) {
        test(`API-PROT-39[${where} URL, empty body]: an empty POST as application/pkixcmp is refused by the framework with 400 "Unable to read HTTP message", never 5xx`,
            meta({
                id: 'API-PROT-39', prio: 'P1', issue: 'ilm#430',
                rule: ['CmpController :44-46: the body is a required @RequestBody byte[]; Spring answers a missing body with HttpMessageNotReadableException → 400 {message} "Unable to read HTTP message" (ExceptionHandlingAdvice), before the CMP service runs (protocols §8.2 r6 applies to protocol errors only)'],
            }),
            async ({ api, env }) => {
                const t = await test.step('Prerequisite: an own CMP profile (RA* default) activated on RA*', async () => targets(api, env));
                const res = await test.step(`POST ${where} URL with an empty body as application/pkixcmp`, async () =>
                    protocolPost(where === 'RA-profile' ? t.raUrl : t.profileUrl, { contentType: 'application/pkixcmp', body: Buffer.alloc(0) }));
                await test.step('400 {message} "Unable to read HTTP message", no stack text', async () => {
                    expect(res.status, res.text.slice(0, 300)).toBe(400);
                    expect(expectMessageObject(res.text)).toContain('Unable to read HTTP message');
                    expect(stackTextIn(res.text)).toBeUndefined();
                });
            });

        for (const b of BODIES) {
            test(`API-PROT-39[${where} URL, ${b.name}]: POST as application/pkixcmp answers 200 application/pkixcmp with an error PKIMessage (rejection${b.exact ? ', badRequest, CMPSRV100' : ''})`,
                meta({
                    id: 'API-PROT-39', prio: 'P1', issue: 'ilm#430',
                    rule: [
                        'ilm#430 table "CMP garbage body → CMP error message, CMPSRV100" (both stacks)',
                        'protocols §8.2 r6: every CMP protocol error is HTTP 200 + application/pkixcmp + a PKIMessage; r7: an unparseable body → unprotected error, badRequest, CMPSRV100 (RFC 4210 §5.3.21)',
                    ],
                }),
                async ({ api, env }, testInfo) => {
                    const t = await test.step('Prerequisite: an own CMP profile (RA* default) activated on RA*', async () => targets(api, env));
                    const url = where === 'RA-profile' ? t.raUrl : t.profileUrl;
                    const res = await test.step(`POST ${where} URL with ${b.name} as application/pkixcmp`, async () => protocolPost(url, { contentType: 'application/pkixcmp', body: b.body() }));
                    const error = await test.step('200 application/pkixcmp; the body is a PKIMessage with an error body and a rejection status', async () => expectErrorMessage(res));
                    if (b.exact) {
                        await test.step('failInfo badRequest and the status text names CMPSRV100', async () => {
                            expect(error.failInfo).toContain('badRequest');
                            expect(error.statusStrings.join(' | ')).toContain('CMPSRV100');
                        });
                    } else {
                        testInfo.annotations.push({ type: 'probe-once', description: `${b.name}: failInfo ${error.failInfo.join(',') || '-'}; status text ${JSON.stringify(error.statusStrings)}` });
                    }
                });
        }
    }
});
