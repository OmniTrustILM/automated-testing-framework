/**
 * API-CERT-21 / 22 / 23 — platform-level pre-registration (ilm#429 step 8; cert-lifecycle rules §6.2 PR-1, PR-2, PR-5,
 * PR-6, PR-7, PR-8; ilm#279 §2.3; core#1820): register with a challenge, complete with the right secret and a matching
 * CSR, and the completion decision table (wrong / missing / blank secret, no CSR, a secret against no authorization, an
 * issued certificate).
 *
 * GUARD REQUEST (lifecycle-shared-patches/README.md): `POST /v2/operations/authorities/{a}/raProfiles/{r}/certificates/register`
 * is a path-less CREATE (core ClientOperationServiceImpl.registerCertificate makes a new certificate; no pre-existing
 * object changes) that the guard's POST_CREATE list does not hold yet, so every register call is refused today. The three
 * rows are declared `test.fixme` with their full bodies and switch on when the route lands on the list.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    historyMessages, historyOf, issueExisting, leaksIn, messagesOf, msBetween, newChallenge, newKeyPair, opsBase, RawAnswer, registerOwn, registrationDefaults,
    registrationOf, sendRaw, specialCharCn,
} from '../../utils/regression/lifecycle';
import { csrFromKey, parseCertificate, publicKeyPemOf, sansOfDetail } from '../../utils/regression/pki';
import { apiJson, ensureRaProfileOrSkip, getCertificate, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { isLocalTier } from '../../utils/regression/tier';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-21';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('API-CERT-21 registration', { tag: tags.api }, () => {
    test(`API-CERT-21: a platform-level register with a CN and a challenge answers {uuid, certificateData:""}, the certificate is registered (ACTIVE, 0 attempts, the default window) and the secret is never echoed; without a secret there is no registration block`,
        meta({
            id: 'API-CERT-21', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §6.2 PR-1 (REGISTERED placeholder; the secret is stored encrypted and never returned; expiresAt defaults to defaultIssuanceWindowDays), PR-2 / core#1820 (platform-level on EJBCA-NG and MS ADCS NG)',
                'cert-lifecycle §6.2 PR-5 (requested → pending_registration → registered; the "Certificate Registered" event fires only with a challenge; requestAttributeWarnings always empty), PR-3 (expiresAt only with a secret)',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const defaults = await registrationDefaults(api);
            testInfo.annotations.push({ type: 'registration-settings', description: `defaultIssuanceWindowDays ${defaults.defaultIssuanceWindowDays}, maxFailedAttempts ${defaults.maxFailedAttempts}` });
            test.skip(defaults.maxFailedAttempts < 1 || defaults.defaultIssuanceWindowDays < 1, `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold a challenge-protected registration`);

            const reg = await test.step('POST …/certificates/register {csrAttributes: [CN], authorizationSecret} → 200 {uuid, certificateData: ""}', async () => {
                const r = await registerOwn(api, ra, SPEC, { suffix: 'c21', secret: newChallenge(), note: 'API-CERT-21 registration' });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                const body = r.answer.json as Record<string, unknown>;
                expect(body.uuid).toMatch(UUID_RE);
                expect(body.certificateData ?? '').toBe('');
                expect((body.requestAttributeWarnings as unknown[] | undefined) ?? []).toEqual([]);
                expect(r.answer.text, 'the secret is not echoed').not.toContain(r.secret!);
                return r;
            });
            const cert = reg.cert!;

            await test.step('registered within 30 s; registration ACTIVE, 0 failed attempts, expiresAt ≈ now + defaultIssuanceWindowDays (± 5 min)', async () => {
                await waitForCertificateState(api, cert.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                const detail = await getCertificate(api, cert.uuid);
                expect(detail.state).toBe('registered');
                expect(detail.registration?.state).toBe('active');
                expect(detail.registration?.failedAttempts ?? 0).toBe(0);
                const expected = new Date((reg.answer.serverAt ?? new Date()).getTime() + defaults.defaultIssuanceWindowDays * 24 * 3600 * 1000);
                expect(msBetween(String(detail.registration?.expiresAt), expected), 'expiresAt within 5 min of now + the default window').toBeLessThanOrEqual(5 * 60 * 1000);
                expect(JSON.stringify(detail), 'the detail never carries the secret').not.toContain(reg.secret!);
                expect(historyMessages(await historyOf(api, cert.uuid)).join('\n'), 'the history never carries the secret').not.toContain(reg.secret!);
            });

            await test.step('The "Certificate registered" event exists for the challenge-protected registration', async () => {
                const rows = await apiJson<Array<Record<string, unknown>>>(api, 'GET', `/api/v1/workflows/events/certificates/${cert.uuid}/history`);
                expect((rows ?? []).map((r) => String(r.event ?? r.eventName ?? ''))).toContain('certificate_registered');
            });

            await test.step('Without a secret: registered, no registration block, no "Certificate registered" event', async () => {
                const plain = await registerOwn(api, ra, SPEC, { suffix: 'c21p', note: 'API-CERT-21 registration without a challenge' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, plain.cert!.uuid)).registration ?? null).toBeNull();
                const rows = await apiJson<Array<Record<string, unknown>>>(api, 'GET', `/api/v1/workflows/events/certificates/${plain.cert!.uuid}/history`);
                expect((rows ?? []).map((r) => String(r.event ?? r.eventName ?? ''))).not.toContain('certificate_registered');
            });

            await test.step('No valid credentials → 401 on register', async () => {
                const a = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/register`, { csrAttributes: [], attributes: [] }, { headers: { authorization: 'Bearer invalid' }, identityOverride: true });
                if (isLocalTier()) testInfo.annotations.push({ type: 'local-stack', description: `register with an invalid bearer answered ${a.status} (not asserted on a local stack)` });
                else expect(a.status, a.text.slice(0, 200)).toBe(401);
            });

        });

    test(`API-CERT-21[rfc4514]: a CN with RFC 4514 special characters (comma, plus, a space after O=) registers with an escaped, well-formed subject DN — known bugs core#2258 / core#2509`,
        meta({
            id: 'API-CERT-21', prio: 'P1', issue: 'ilm#429', bug: ['core#2258', 'core#2509'],
            rule: ['core#2258 / core#2509 (the subject DN built from request attributes must be well-formed and RFC 4514 escaped; open bugs, pinned as test.fail)', 'cert-lifecycle §6.2 PR-3 (csrAttributes project to the subject)'],
        }),
        async ({ api }) => {
            // The rule is asserted; the test turns red when the bugs are fixed (then drop the pin).
            test.fail(true, 'core#2258 / core#2509: the subject DN built from request attributes is malformed and not RFC 4514 escaped (open)');
            test.setTimeout(120_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const cn = specialCharCn(regName('c21dn-' + Date.now().toString(36)));
            const r = await registerOwn(api, ra, SPEC, { suffix: 'c21dn', cn, secret: newChallenge(), note: 'API-CERT-21 special-character CN (core#2258 / core#2509)' });
            expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, r.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            const detail = await getCertificate(api, r.cert!.uuid);
            // RFC 4514 §2.4: a comma and a plus inside a value are escaped with a backslash. The CN keeps the run prefix at its start
            // (merge review M1: a leading space would make the teardown refuse the certificate).
            expect(String(detail.subjectDn)).toContain(`CN=${cn.split(',')[0]}\\, O= QA\\+Team`);
        });

    test(`API-CERT-22: completing a registered certificate with the right secret and a CSR of the registered identity issues it with the CSR key; the authorization stays ACTIVE with 0 attempts and no window; without a challenge a CSR alone completes`,
        meta({
            id: 'API-CERT-22', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §6.2 PR-6 (complete = POST …/{c}/issue with request, format, authorizationSecret; the registered identity is preserved)',
                'cert-lifecycle §6.2 PR-8 (after the first issuance the window is cleared and the authorization is retained ACTIVE for renew / rekey), PR-7 (a verified secret resets the counter)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));

            await test.step('With a challenge: complete with the right secret and a matching CSR → 200, issued with the CSR key, identity preserved, authorization ACTIVE / 0 / no window', async () => {
                const reg = await registerOwn(api, ra, SPEC, { suffix: 'c22', secret: newChallenge() });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                const registered = await getCertificate(api, reg.cert!.uuid);
                const csr = csrFromKey(newKeyPair(), reg.cn);
                const a = await issueExisting(api, reg.cert!, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
                const issued = await getCertificate(api, reg.cert!.uuid);
                expect(issued.subjectDn).toBe(registered.subjectDn);
                expect(sansOfDetail(issued.subjectAlternativeNames)).toEqual(sansOfDetail(registered.subjectAlternativeNames));
                expect(publicKeyPemOf(parseCertificate(issued.certificateContent))).toBe(csr.publicKeyPem);
                expect(issued.registration?.state).toBe('active');
                expect(issued.registration?.failedAttempts ?? 0).toBe(0);
                expect(issued.registration?.expiresAt ?? null, 'the issuance window is cleared').toBeNull();
            });

            await test.step('Without a challenge: a CSR alone completes; no registration block', async () => {
                const reg = await registerOwn(api, ra, SPEC, { suffix: 'c22p' });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                const csr = csrFromKey(newKeyPair(), reg.cn);
                const a = await issueExisting(api, reg.cert!, ra, { request: csr.derBase64 });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
                expect((await getCertificate(api, reg.cert!.uuid)).registration ?? null).toBeNull();
            });
        });

    test(`API-CERT-23: the completion decision table: wrong secret counts an attempt (422 "invalid", history "attempt N"), missing / empty / blank secret spends none (422 "required"), the right secret resets to 0, a secret against no authorization is refused, no CSR is refused, an issued certificate is refused`,
        meta({
            id: 'API-CERT-23', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §6.2 PR-7 (wrong secret: 422 "The certificate registration challenge is invalid.", failedAttempts + 1 committed before the rejection, history "Certificate registration challenge verification failed (attempt N)"; missing / blank: 422 "…challenge is required." with no attempt; a verified secret resets the counter)',
                'cert-lifecycle §6.2 PR-6 (no CSR: "A certificate signing request is required to issue a registered certificate. Certificate: …"; a secret against no active authorization: "An authorization secret was presented but the certificate has no active registration authorization to verify it against."; an issued certificate: "Cannot issue certificate with state Issued.")',
                'ilm#279 §2.3 (wrong → 422, failedAttempts++, still REGISTERED); cert-lifecycle §11 rule 6',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(420_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            // Two wrong secrets are sent before the right one: a tier whose maxFailedAttempts is 2 or less would LOCK the
            // authorization (PR-7) and the table could not be judged (Sonnet 6: settings are read, never set).
            const defaults = await registrationDefaults(api);
            test.skip(defaults.maxFailedAttempts <= 2, `maxFailedAttempts is ${defaults.maxFailedAttempts} on this tier: two wrong secrets would lock the registration (the table needs > 2)`);
            const refused = (a: RawAnswer, text: string) => {
                expect(a.status, a.text.slice(0, 300)).toBe(422);
                const m = messagesOf(a);
                expect(m).toHaveLength(1);
                expect(m[0]).toContain(text);
                expect(leaksIn(a.text)).toEqual([]);
            };
            const INVALID = 'The certificate registration challenge is invalid.';
            const REQUIRED = 'The certificate registration challenge is required.';

            const reg = await test.step('Fixture: a registration with a challenge', async () => {
                const r = await registerOwn(api, ra, SPEC, { suffix: 'c23', secret: newChallenge() });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                return r;
            });
            const cert = reg.cert!;
            const csr = csrFromKey(newKeyPair(), reg.cn);
            const attempts = async () => (await registrationOf(api, cert.uuid))?.failedAttempts ?? 0;

            await test.step('Wrong secret → 422 "invalid"; failedAttempts 1; state registered; history "attempt 1"; a second wrong one → 2', async () => {
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: `${reg.secret}-wrong` }), INVALID);
                expect(await attempts()).toBe(1);
                expect((await getCertificate(api, cert.uuid)).state).toBe('registered');
                expect(historyMessages(await historyOf(api, cert.uuid))).toContainEqual(expect.stringContaining('Certificate registration challenge verification failed (attempt 1)'));
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: `${reg.secret}-wrong-2` }), INVALID);
                expect(await attempts()).toBe(2);
            });

            await test.step('Missing, empty and blank secret → 422 "required"; the counter stays at 2', async () => {
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64 }), REQUIRED);
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: '' }), REQUIRED);
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: '   ' }), REQUIRED);
                expect(await attempts()).toBe(2);
            });

            await test.step('No CSR with the right secret → 422 "A certificate signing request is required…"', async () => {
                refused(await issueExisting(api, cert, ra, { authorizationSecret: reg.secret }), 'A certificate signing request is required to issue a registered certificate. Certificate: ');
            });

            await test.step('The right secret after the wrong ones → 200, issued, attempts reset to 0', async () => {
                const a = await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, cert.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, cert.uuid, reg.createdAfter, SPEC);
                expect(await attempts()).toBe(0);
            });

            await test.step('Complete on an issued certificate → 422 "Cannot issue certificate with state Issued."', async () => {
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: reg.secret }), 'Cannot issue certificate with state Issued.');
            });

            await test.step('A secret presented to a registration without an authorization → 422 "…no active registration authorization…"', async () => {
                const plain = await registerOwn(api, ra, SPEC, { suffix: 'c23p' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                refused(await issueExisting(api, plain.cert!, ra, { request: csrFromKey(newKeyPair(), plain.cn).derBase64, authorizationSecret: newChallenge() }),
                    'An authorization secret was presented but the certificate has no active registration authorization to verify it against.');
            });
        });
});
