/**
 * API-PROT-17 — ACME answers to malformed requests on the run ACME profile's new-account URL (ilm#430): 400 problem+json
 * malformed (core#2779); the empty body still answers serverInternal (core#2669).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AcmeClient } from '../../../utils/regression/protocols/acmeClient';
import { GuardedApi } from '../../../utils/regression/guard/types';
import { acmeErrorType, acmeProblem, isProblemJson, protocolGet, ProtocolResponse, protocolPost, stackTextIn } from '../../../utils/regression/protocols/protocolHttp';
import { ensureAcmeOnRaProfile } from '../../../utils/regression/ownRaProfiles';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';

interface AcmeTarget {
    newAccountUrl: string;
    acmeRoot: string;
}

test.describe('ACME protocol answers to malformed requests', { tag: tags.api }, () => {
    let shared: AcmeTarget | undefined;

    async function target(api: GuardedApi, spec: string): Promise<AcmeTarget> {
        if (shared) return shared;
        const { directoryUrl } = await ensureAcmeOnRaProfile(api, spec);
        const dir = await new AcmeClient(directoryUrl).init();
        const origin = new URL(directoryUrl).origin;
        shared = { newAccountUrl: String(dir.newAccount), acmeRoot: `${origin}/api/v1/protocols/acme` };
        return shared;
    }

    /** A 400 problem document with a non-empty detail and no stack text; its type is checked apart, after a known-bug marker. */
    function expectProblemDocument(res: ProtocolResponse): { type: string } {
        expect(res.status, res.text.slice(0, 300)).toBe(400);
        expect(isProblemJson(res.contentType), `content type ${res.contentType}`).toBe(true);
        const problem = acmeProblem(res);
        expect(problem, `a problem document: ${res.text.slice(0, 300)}`).toBeTruthy();
        expect(problem!.detail.length, 'detail is non-empty').toBeGreaterThan(0);
        expect(stackTextIn(res.text), 'no class names or stack text in the body').toBeUndefined();
        return problem!;
    }

    function expectProblem(res: ProtocolResponse, code: string): void {
        expect(expectProblemDocument(res).type).toBe(acmeErrorType(code));
    }

    const PARAMS: Array<{ name: string; body: string; rule: string; bug?: string }> = [
        { name: 'garbage non-JWS body', body: 'this is not a JWS at all', rule: 'the body must be a flattened JWS, else 400 malformed; ilm#430 table "ACME bad JWS → 400 problem+json malformed"' },
        { name: 'malformed JWS structure', body: JSON.stringify({ protected: '!!', payload: 'e30', signature: 'AA' }), rule: 'a body that is not a flattened JWS is malformed (AcmeJwsRequest.readRequest, RFC 8555 §6.2); ilm#430 table "ACME bad JWS"' },
        { name: 'JWS without signature', body: JSON.stringify({ protected: 'e30', payload: 'e30' }), rule: 'a JWS without its signature member is malformed (core#2779; before it, an uncaught NullPointerException answered serverInternal, core#2669)' },
        { name: '{} body', body: '{}', rule: 'an empty JSON object is not a flattened JWS: malformed (core#2779; before it serverInternal, core#2669)' },
        { name: 'empty body', body: '', bug: 'core#2669', rule: 'an empty body is malformed (RFC 8555 §6.7); Spring refuses the missing @RequestBody before the ACME code, which answers serverInternal today (core#2669, open)' },
    ];

    for (const p of PARAMS) {
        test(`new-account answers 400 problem+json malformed for the ${p.name === '{} body' ? 'empty JSON object body' : p.name}`,
            testMeta({ id: 'API-PROT-17', row: p.name, prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: p.bug, rule: [p.rule, 'RFC 8555 §6.7: errors are application/problem+json with type urn:ietf:params:acme:error:<code>'] }),
            async ({ api, own }) => {
                const t = await test.step('Prerequisite: the RA-profile ACME directory of the run', async () => target(api, own.spec));
                const res = await test.step(`POST new-account (application/jose+json) with the ${p.name}`, async () =>
                    protocolPost(t.newAccountUrl, { contentType: 'application/jose+json', body: p.body }));
                await test.step('400 problem+json …:malformed, non-empty detail, no stack text', async () => {
                    const problem = expectProblemDocument(res);
                    if (p.bug) test.fail(true, `${p.bug}: the ${p.name} answers serverInternal`);
                    expect(problem.type).toBe(acmeErrorType('malformed'));
                });
            });
    }

    test('the directory of an unknown profile answers 400 problem+json',
        testMeta({
            id: 'API-PROT-17', row: 'unknown profile', prio: 'P3', needs: 'ca', issue: 'ilm#430', pin: 'acme-unknown-profile-server-internal',
            rule: [
                'pinned as today\'s behaviour, ilm#430 table "ACME unknown profile → 400 problem+json serverInternal" (the directory request of step 8); RFC 8555 sets no type for an unknown directory',
                'an unknown profile (or an RA profile without ACME) answers 400 serverInternal "Given profile name is not found" (AcmeServiceImpl); flips when core gives it a client error type',
            ],
        }),
        async ({ api, own }) => {
            const t = await test.step('Prerequisite: the ACME root of the tier', async () => target(api, own.spec));
            const res = await test.step('GET …/acme/<run>-nosuch/directory', async () => protocolGet(`${t.acmeRoot}/${runName('nosuch')}/directory`));
            await test.step('400 problem+json …:serverInternal, non-empty detail, no stack text', async () => expectProblem(res, 'serverInternal'));
        });
});
