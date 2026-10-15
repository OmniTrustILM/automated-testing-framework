/**
 * prot-acme-protocol — ACME protocol-level pins (API-PROT-17 in B2: the malformed-request answers of ilm#430 step 8).
 *
 * Target: the RA-profile `new-account` URL of the run ACME profile (activated on an own RA profile). Every parameter
 * is a body the server must refuse with HTTP 400 `application/problem+json` and the pinned `type`
 * (RFC 8555 §6.7; protocols rules §4.2 r4 and r7: a non-ACME exception becomes 400 `serverInternal`, which is why
 * `{}`, an EMPTY body and an unknown profile are pinned that way — old behaviour, plan O4). The empty body never
 * reaches the service: Spring refuses a missing required `@RequestBody String` (AcmeRaProfileController) with
 * HttpMessageNotReadableException, which `AcmeExceptionHandlingAdvice.handleOtherException` (:38-43) turns into
 * `serverInternal`; RFC 8555 §6.7 would prefer `malformed` — a deviation noted, not a bug pinned (same class as `{}`).
 * The "unknown profile" parameter is the ilm#430 row itself: `GET …/acme/<unknown>/directory` → 400 `serverInternal`
 * "Given profile name is not found" (rules §4.2 r3). Nothing is created; every request is refused before an account exists.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { AcmeClient } from '../../utils/regression/acmeClient';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { acmeErrorType, acmeProblem, isProblemJson, protocolGet, ProtocolResponse, protocolPost, stackTextIn } from '../../utils/regression/protocolHttp';
import { ensureAcmeOnRaProfile, orSkipWithoutCa } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'API-PROT-17';
const skip = (reason: string) => test.skip(true, reason);

interface AcmeTarget {
    /** The RA-profile directory's `newAccount` URL. */
    newAccountUrl: string;
    /** `<origin>/api/v1/protocols/acme`: the profile-based URL root for the unknown-profile parameter. */
    acmeRoot: string;
}

test.describe('@api prot-acme-protocol', () => {
    let shared: AcmeTarget | undefined;

    async function target(api: GuardedApi): Promise<AcmeTarget> {
        if (shared) return shared;
        const { directoryUrl } = await orSkipWithoutCa(ensureAcmeOnRaProfile(api, SPEC), skip);
        const dir = await new AcmeClient(directoryUrl).init();
        const origin = new URL(directoryUrl).origin;
        shared = { newAccountUrl: String(dir.newAccount), acmeRoot: `${origin}/api/v1/protocols/acme` };
        return shared;
    }

    /** The common assertions of every parameter: 400, problem+json, the pinned type, a detail, no stack or class text. */
    function expectProblem(res: ProtocolResponse, code: string): void {
        expect(res.status, res.text.slice(0, 300)).toBe(400);
        expect(isProblemJson(res.contentType), `content type ${res.contentType}`).toBe(true);
        const problem = acmeProblem(res);
        expect(problem, `a problem document: ${res.text.slice(0, 300)}`).toBeTruthy();
        expect(problem!.type).toBe(acmeErrorType(code));
        expect(problem!.detail.length, 'detail is non-empty').toBeGreaterThan(0);
        expect(stackTextIn(res.text), 'no class names or stack text in the body').toBeUndefined();
    }

    const PARAMS: Array<{ name: string; body: string; code: string; rule: string }> = [
        { name: 'garbage non-JWS body', body: 'this is not a JWS at all', code: 'malformed', rule: 'protocols §4.2 r4: the body must be a flattened JWS, else 400 malformed; ilm#430 table "ACME bad JWS → 400 problem+json malformed"' },
        // A JWS whose protected header is not base64url: AcmeJwsRequest.readRequest → ParseException → malformed (a MISSING
        // signature member is not used: it hits an uncaught NPE at AcmeJwsRequest.java:83-84 — reviewer finding, suspected defect).
        { name: 'malformed JWS structure', body: JSON.stringify({ protected: '!!', payload: 'e30', signature: 'AA' }), code: 'malformed', rule: 'protocols §4.2 r4: a body that is not a flattened JWS is malformed (AcmeJwsRequest.readRequest, RFC 8555 §6.2); ilm#430 table "ACME bad JWS"' },
        { name: '{} body', body: '{}', code: 'serverInternal', rule: 'ilm#430 table "ACME {} body → 400 problem+json serverInternal" (pinned old behaviour; protocols §4.2 r7: a non-ACME exception becomes serverInternal; RFC 8555 would prefer malformed: O4)' },
        { name: 'empty body', body: '', code: 'serverInternal', rule: 'Spring refuses the missing required @RequestBody String before the service (HttpMessageNotReadableException) → AcmeExceptionHandlingAdvice.handleOtherException (:38-43) → 400 serverInternal; same class as the {} arm (plan O4: RFC 8555 §6.7 would prefer malformed — deviation noted, rules §4.2 r4 ":316 / :406" is unreachable for an empty body)' },
    ];

    for (const p of PARAMS) {
        test(`API-PROT-17[${p.name}]: new-account with a ${p.name} answers 400 problem+json ${p.code}`,
            meta({ id: 'API-PROT-17', prio: 'P1', issue: 'ilm#430', rule: [p.rule, 'RFC 8555 §6.7: errors are application/problem+json with type urn:ietf:params:acme:error:<code>'] }),
            async ({ api }) => {
                const t = await test.step('Prerequisite: the RA-profile ACME directory of the run', async () => target(api));
                const res = await test.step(`POST new-account (application/jose+json) with the ${p.name}`, async () =>
                    protocolPost(t.newAccountUrl, { contentType: 'application/jose+json', body: p.body }));
                await test.step(`400 problem+json …:${p.code}, non-empty detail, no stack text`, async () => expectProblem(res, p.code));
            });
    }

    test('API-PROT-17[unknown profile]: the directory of a profile name that does not exist answers 400 problem+json serverInternal',
        meta({
            id: 'API-PROT-17', prio: 'P1', issue: 'ilm#430',
            rule: [
                'ilm#430 table "ACME unknown profile → 400 problem+json serverInternal" (the directory request of step 8)',
                'protocols §4.2 r3: an unknown profile (or an RA profile without ACME) answers 400 serverInternal "Given profile name is not found" (AcmeServiceImpl :266-269); r7: a non-ACME exception becomes serverInternal',
            ],
        }),
        async ({ api }) => {
            const t = await test.step('Prerequisite: the ACME root of the tier', async () => target(api));
            const res = await test.step('GET …/acme/<run>-nosuch/directory', async () => protocolGet(`${t.acmeRoot}/${regName('nosuch')}/directory`));
            await test.step('400 problem+json …:serverInternal, non-empty detail, no stack text', async () => expectProblem(res, 'serverInternal'));
        });
});
