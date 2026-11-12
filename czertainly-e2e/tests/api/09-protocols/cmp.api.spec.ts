/**
 * API-PROT-39 — CMP answers to malformed requests. ilm#430.
 *
 * WHAT: 1. An empty POST (as application/pkixcmp) on the RA-profile URL and on the profile URL → 400 {message} "Unable to read HTTP
 *          message", never a 5xx, no stack text.
 *       2. Fixed garbage bytes and a truncated PKIMessage on each URL → HTTP 200 application/pkixcmp with an error PKIMessage (rejection
 *          status); for the garbage bytes the failInfo is badRequest and the status text names CMPSRV100.
 * WHY: every CMP protocol error is HTTP 200 plus application/pkixcmp plus a PKIMessage (an unparseable body → an unprotected error,
 *      badRequest, CMPSRV100; RFC 4210 §5.3.21). An empty body is no protocol error: the required @RequestBody is missing and Spring
 *      answers 400 before the CMP service runs.
 * HOW: one own CMP profile (the dedicated RA profile as its default RA, activated on that RA profile; recorded in the ledger, skipped with
 *      the named reason without a CA) serves both URLs. The garbage bytes are fixed, so a failure replays byte for byte.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { buildErrorPkiMessage, errorRejectionProblems, parsePkiMessage } from '../../../utils/regression/protocols/cmpMessageParser';
import { expectMessageObject } from '../../../utils/regression/errorContract';
import { GuardedApi } from '../../../utils/regression/guard/types';
import { fixedGarbage, protocolPost, ProtocolResponse, stackTextIn } from '../../../utils/regression/protocols/protocolHttp';
import { cmpProfileUrl, createOwnCmpProfile, enableOwnCmpProfile, ensureCmpActiveOnOwnRaProfile, randomSecret } from '../../../utils/regression/protocols/protocolProfiles';
import { ensureProtocolRaProfile } from '../../../utils/regression/ownRaProfiles';
import { testMeta, tags } from '../../../utils/regression/tags';

interface CmpTargets {
    raUrl: string;
    profileUrl: string;
}

const PKIXCMP = /^application\/pkixcmp\b/i;

test.describe('CMP endpoint answers to malformed requests', { tag: tags.api }, () => {
    let shared: CmpTargets | undefined;

    async function targets(api: GuardedApi, spec: string, env: { baseUrl: string }): Promise<CmpTargets> {
        if (shared) return shared;
        const ra = await ensureProtocolRaProfile(api, spec, 'cmp-api');
        const cmp = await createOwnCmpProfile(api, spec, 'cmp-pin', { sharedSecret: randomSecret(), raProfileUuid: ra.uuid, note: 'CMP profile with the dedicated RA profile as default RA, activated on the dedicated RA profile' });
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
        test(`an empty CMP POST on the ${where} URL is refused with 400, never 5xx`,
            testMeta({
                id: 'API-PROT-39', row: `${where} URL, empty body`, prio: 'P1', needs: 'ca', issue: 'ilm#430',
                rule: ['CmpController: the body is a required @RequestBody byte[]; Spring answers a missing body with HttpMessageNotReadableException → 400 {message} "Unable to read HTTP message" (ExceptionHandlingAdvice), before the CMP service runs (the rule that a CMP protocol error is HTTP 200 applies to protocol errors only)'],
            }),
            async ({ api, env, own }) => {
                const t = await test.step('Prerequisite: an own CMP profile (the dedicated RA profile default) activated on the dedicated RA profile', async () => targets(api, own.spec, env));
                const res = await test.step(`POST ${where} URL with an empty body as application/pkixcmp`, async () =>
                    protocolPost(where === 'RA-profile' ? t.raUrl : t.profileUrl, { contentType: 'application/pkixcmp', body: Buffer.alloc(0) }));
                await test.step('400 {message} "Unable to read HTTP message", no stack text', async () => {
                    expect(res.status, res.text.slice(0, 300)).toBe(400);
                    expect(expectMessageObject(res.text)).toContain('Unable to read HTTP message');
                    expect(stackTextIn(res.text)).toBeUndefined();
                });
            });

        for (const b of BODIES) {
            test(`a CMP POST of ${b.name} on the ${where} URL answers an error PKIMessage`,
                testMeta({
                    id: 'API-PROT-39', row: `${where} URL, ${b.name}`, prio: 'P1', needs: 'ca', issue: 'ilm#430',
                    rule: [
                        'ilm#430 table "CMP garbage body → CMP error message, CMPSRV100" (both stacks)',
                        'every CMP protocol error is HTTP 200 + application/pkixcmp + a PKIMessage; an unparseable body → unprotected error, badRequest, CMPSRV100 (RFC 4210 §5.3.21)',
                    ],
                }),
                async ({ api, env, own }, testInfo) => {
                    const t = await test.step('Prerequisite: an own CMP profile (the dedicated RA profile default) activated on the dedicated RA profile', async () => targets(api, own.spec, env));
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
