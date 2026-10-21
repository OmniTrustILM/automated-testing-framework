/**
 * API-PROT-17 — ACME answers to malformed requests on the run ACME profile's new-account URL: every malformed body is
 * refused with 400 `application/problem+json` and its error type, with no stack text, and an unknown profile's directory
 * answers 400. Nothing is created.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { AcmeClient } from '../../utils/regression/protocols/acmeClient';
import { GuardedApi } from '../../utils/regression/guard/types';
import { acmeErrorType, acmeProblem, isProblemJson, protocolGet, ProtocolResponse, protocolPost, stackTextIn } from '../../utils/regression/protocols/protocolHttp';
import { ensureAcmeOnRaProfile, orSkipWithoutCa } from '../../utils/regression/ownRaProfiles';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'API-PROT-17';
const skip = (reason: string) => test.skip(true, reason);

interface AcmeTarget {
    /** The RA-profile directory's `newAccount` URL. */
    newAccountUrl: string;
    /** `<origin>/api/v1/protocols/acme`: the profile-based URL root for the unknown-profile parameter. */
    acmeRoot: string;
}

test.describe('ACME protocol answers to malformed requests', { tag: tags.api }, () => {
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
        { name: 'garbage non-JWS body', body: 'this is not a JWS at all', code: 'malformed', rule: 'the body must be a flattened JWS, else 400 malformed; ilm#430 table "ACME bad JWS → 400 problem+json malformed"' },
        // A JWS whose protected header is not base64url: AcmeJwsRequest.readRequest → ParseException → malformed (a MISSING
        // signature member is not used: it hits an uncaught NPE at AcmeJwsRequest.java — a suspected defect).
        { name: 'malformed JWS structure', body: JSON.stringify({ protected: '!!', payload: 'e30', signature: 'AA' }), code: 'malformed', rule: 'a body that is not a flattened JWS is malformed (AcmeJwsRequest.readRequest, RFC 8555 §6.2); ilm#430 table "ACME bad JWS"' },
        { name: '{} body', body: '{}', code: 'serverInternal', rule: 'ilm#430 table "ACME {} body → 400 problem+json serverInternal" (pinned old behaviour: a non-ACME exception becomes serverInternal; RFC 8555 would prefer malformed)' },
        { name: 'empty body', body: '', code: 'serverInternal', rule: 'Spring refuses the missing required @RequestBody String before the service (HttpMessageNotReadableException) → AcmeExceptionHandlingAdvice.handleOtherException → 400 serverInternal; same class as the {} arm (RFC 8555 §6.7 would prefer malformed — deviation noted; the malformed branch at ":316 / :406" is unreachable for an empty body)' },
    ];

    for (const p of PARAMS) {
        test(`new-account answers 400 problem+json ${p.code} for the ${p.name === '{} body' ? 'empty JSON object body' : p.name}`,
            testMeta({ id: 'API-PROT-17', row: p.name, prio: 'P1', issue: 'ilm#430', rule: [p.rule, 'RFC 8555 §6.7: errors are application/problem+json with type urn:ietf:params:acme:error:<code>'] }),
            async ({ api }) => {
                const t = await test.step('Prerequisite: the RA-profile ACME directory of the run', async () => target(api));
                const res = await test.step(`POST new-account (application/jose+json) with the ${p.name}`, async () =>
                    protocolPost(t.newAccountUrl, { contentType: 'application/jose+json', body: p.body }));
                await test.step(`400 problem+json …:${p.code}, non-empty detail, no stack text`, async () => expectProblem(res, p.code));
            });
    }

    test('the directory of an unknown profile answers 400 problem+json',
        testMeta({
            id: 'API-PROT-17', row: 'unknown profile', prio: 'P1', issue: 'ilm#430',
            rule: [
                'ilm#430 table "ACME unknown profile → 400 problem+json serverInternal" (the directory request of step 8)',
                'an unknown profile (or an RA profile without ACME) answers 400 serverInternal "Given profile name is not found" (AcmeServiceImpl); a non-ACME exception becomes serverInternal',
            ],
        }),
        async ({ api }) => {
            const t = await test.step('Prerequisite: the ACME root of the tier', async () => target(api));
            const res = await test.step('GET …/acme/<run>-nosuch/directory', async () => protocolGet(`${t.acmeRoot}/${runName('nosuch')}/directory`));
            await test.step('400 problem+json …:serverInternal, non-empty detail, no stack text', async () => expectProblem(res, 'serverInternal'));
        });
});
