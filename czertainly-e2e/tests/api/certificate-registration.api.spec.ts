/**
 * Platform-level pre-registration: register with a challenge, complete with the right secret and a matching CSR, and
 * the completion decision table (wrong, missing or blank secret, no CSR, no authorization, an issued certificate).
 * Shared-tier safety: registration creates new certificates only, recorded before any assertion. A special-character
 * CN case is pinned as an expected failure while core#2258 and core#2509 are open.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { opsBase } from '../../utils/regression/lifecycle/certificateLabels';
import { specialCharCn } from '../../utils/regression/ownCertificates';
import { issueExisting } from '../../utils/regression/lifecycle/certificateOperations';
import { msBetween, newChallenge, registerOwnCertificate, registrationDefaults, registrationOf } from '../../utils/regression/lifecycle/preRegistration';
import { leaksIn, messagesOf, RawAnswer, sendRaw } from '../../utils/regression/lifecycle/rawAnswers';
import { newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { getCertificate } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { LIFECYCLE_MS, SLOW_LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { isLocalTier } from '../../utils/regression/tier/kind';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { assertHeldFor, firingsOfObject, getFirings, getPlatformTriggerGate, waitForFinishedFirings } from '../../utils/regression/events/eventHistory';
import { EVENT } from '../../utils/regression/events/eventVocabulary';
import { associateTriggers } from '../../utils/regression/events/eventAssociations';
import { createOwnChain, setCustomAttributeAction } from '../../utils/regression/events/workflowObjects';
import { createOwnCustomAttribute } from '../../utils/regression/customAttributes';
import { cloneRunRaProfile, OwnRaProfile } from '../../utils/regression/ownRaProfiles';

const SPEC = 'API-CERT-21';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('Certificate pre-registration through the v2 API', { tag: tags.api }, () => {
    test('registering with a CN and a challenge gives a registered certificate and never echoes the secret',
        testMeta({
            id: 'API-CERT-21', prio: 'P1', issue: 'ilm#429',
            rule: [
                'REGISTERED placeholder; the secret is stored encrypted and never returned; expiresAt defaults to defaultIssuanceWindowDays; core#1820 (platform-level on EJBCA-NG and MS ADCS NG)',
                'requested → pending_registration → registered; the "Certificate Registered" event fires only with a challenge; requestAttributeWarnings always empty; expiresAt only with a secret',
            ],
        }),
        async ({ api, ownRaProfile }, testInfo) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const defaults = await registrationDefaults(api);
            testInfo.annotations.push({ type: 'registration-settings', description: `defaultIssuanceWindowDays ${defaults.defaultIssuanceWindowDays}, maxFailedAttempts ${defaults.maxFailedAttempts}` });
            test.skip(defaults.maxFailedAttempts < 1 || defaults.defaultIssuanceWindowDays < 1, `registration settings on this tier (maxFailedAttempts ${defaults.maxFailedAttempts}, window ${defaults.defaultIssuanceWindowDays} days) cannot hold a challenge-protected registration`);

            const reg = await test.step('POST …/certificates/register {csrAttributes: [CN], authorizationSecret} → 200 {uuid, certificateData: ""}', async () => {
                const r = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c21', secret: newChallenge(), note: 'Certificate pre-registration through the v2 API' });
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

            // The event arms observe through an own trigger on `Certificate registered`, associated on an own RA+ clone of the run RA
            // profile (the run RA profile is shared by the run's other specs and is never associated): a firing in that scope is the
            // event. A platform-level trigger on the event would act on these certificates too, so only the two event arms skip then.
            const gate = await getPlatformTriggerGate(api, [EVENT.registered]);
            let observer: { ra: OwnRaProfile; scope: { resource: 'raProfiles'; objectUuid: string } } | undefined;
            const FIRING_WAIT = { timeoutMs: 180_000 };

            await test.step('The "Certificate registered" event fires for a challenge-protected registration (own observer)', async () => {
                if (gate) {
                    testInfo.annotations.push({ type: 'skipped-step', description: gate });
                    return;
                }
                const clone = await cloneRunRaProfile(api, SPEC, 'c21ev');
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'c21ev-mark', resources: ['certificates'] });
                const chain = await createOwnChain(api, SPEC, { suffix: 'c21ev', event: EVENT.registered, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'fired')] });
                const sent = await associateTriggers(api, SPEC, { event: EVENT.registered, resource: 'raProfiles', object: clone, triggers: [chain.trigger] });
                expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
                observer = { ra: clone, scope: { resource: 'raProfiles', objectUuid: clone.uuid } };
                const withSecret = await registerOwnCertificate(api, clone, SPEC, { suffix: 'c21ev', secret: newChallenge(), note: 'API-CERT-21 event arm: challenge-protected registration' });
                expect(withSecret.answer.status, withSecret.answer.text.slice(0, 300)).toBe(200);
                const page = await waitForFinishedFirings(api, { event: EVENT.registered, scope: observer.scope, pageSize: 50 }, 1, FIRING_WAIT);
                expect(firingsOfObject(page, withSecret.cert!.uuid), 'one firing of Certificate registered for the challenge-protected certificate').toHaveLength(1);
            });

            await test.step('Without a secret: registered, no registration block', async () => {
                const plain = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c21p', note: 'API-CERT-21 registration without a challenge' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, plain.cert!.uuid)).registration ?? null).toBeNull();
            });

            await test.step('Without a secret: no "Certificate registered" firing (after the observer has shown it works)', async () => {
                if (!observer) {
                    testInfo.annotations.push({ type: 'skipped-step', description: gate ?? 'the event observer was not set up' });
                    return;
                }
                const scope = observer.scope;
                const noSecret = await registerOwnCertificate(api, observer.ra, SPEC, { suffix: 'c21evp', note: 'API-CERT-21 event arm: registration without a challenge' });
                expect(noSecret.answer.status, noSecret.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, noSecret.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                // A later challenge-protected registration in the same scope bounds the wait: once its firing is finished, the
                // registration before it has been handled too; a short grace window then holds the absence.
                const after = await registerOwnCertificate(api, observer.ra, SPEC, { suffix: 'c21evs', secret: newChallenge(), note: 'API-CERT-21 event arm: the registration after the one without a challenge' });
                expect(after.answer.status, after.answer.text.slice(0, 300)).toBe(200);
                const page = await waitForFinishedFirings(api, { event: EVENT.registered, scope, pageSize: 50 }, 2, FIRING_WAIT);
                expect(firingsOfObject(page, after.cert!.uuid), 'the later challenge-protected registration fired').toHaveLength(1);
                expect(firingsOfObject(page, noSecret.cert!.uuid), 'no firing for the registration without a challenge').toEqual([]);
                await assertHeldFor({ forMs: 15_000, everyMs: 5_000 }, async () => {
                    const r = await getFirings(api, { event: EVENT.registered, scope, pageSize: 50 });
                    expect(r.status, r.text.slice(0, 200)).toBe(200);
                    expect(firingsOfObject(r.page!, noSecret.cert!.uuid), 'no firing for the registration without a challenge').toEqual([]);
                    expect(r.page!.totalItems, 'only the two challenge-protected registrations fired in the scope').toBe(2);
                });
            });

            await test.step('No valid credentials → 401 on register', async () => {
                const a = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/register`, { csrAttributes: [], attributes: [] }, { headers: { authorization: 'Bearer invalid' }, identityOverride: true });
                if (isLocalTier()) testInfo.annotations.push({ type: 'local-stack', description: `register with an invalid bearer answered ${a.status} (not asserted on a local stack)` });
                else expect(a.status, a.text.slice(0, 200)).toBe(401);
            });

        });

    test('a CN with RFC 4514 special characters registers with an escaped subject DN',
        testMeta({
            id: 'API-CERT-21', row: 'rfc4514', prio: 'P1', issue: 'ilm#429', bug: ['core#2258', 'core#2509'],
            rule: ['core#2258 / core#2509 (the subject DN built from request attributes must be well-formed and RFC 4514 escaped; open bugs, pinned as test.fail)', 'csrAttributes project to the subject'],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(120_000);
            const ra = ownRaProfile;
            const cn = specialCharCn(runName('c21dn-' + Date.now().toString(36)));
            // The bugs break the register itself (422 "Invalid subject DN … badly formatted directory string"), so the marker sits right
            // before it; the setup above runs outside it. The test turns red when the bugs are fixed (then drop the pin).
            test.fail(true, 'core#2258 / core#2509: the subject DN built from request attributes is malformed and not RFC 4514 escaped (open)');
            const r = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c21dn', cn, secret: newChallenge(), note: 'API-CERT-21 special-character CN (core#2258 / core#2509)' });
            expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, r.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            const detail = await getCertificate(api, r.cert!.uuid);
            // RFC 4514 §2.4: a comma and a plus inside a value are escaped with a backslash. The CN keeps the run prefix at its start
            // (a leading space would make the teardown refuse the certificate).
            expect(String(detail.subjectDn)).toContain(`CN=${cn.split(',')[0]}\\, O= QA\\+Team`);
        });

    test('completing a registered certificate with the right secret and a CSR issues it with the CSR key',
        testMeta({
            id: 'API-CERT-22', prio: 'P1', issue: 'ilm#429',
            rule: [
                'complete = POST …/{c}/issue with request, format, authorizationSecret; the registered identity is preserved',
                'after the first issuance the window is cleared and the authorization is retained ACTIVE for renew / rekey; a verified secret resets the counter',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;

            await test.step('With a challenge: complete with the right secret and a matching CSR → 200, issued with the CSR key, identity preserved, authorization ACTIVE / 0 / no window', async () => {
                const reg = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c22', secret: newChallenge() });
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
                const reg = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c22p' });
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

    test('completion refuses a wrong secret, a missing secret, no CSR and an issued certificate',
        testMeta({
            id: 'API-CERT-23', prio: 'P1', issue: 'ilm#429',
            rule: [
                'wrong secret: 422 "The certificate registration challenge is invalid.", failedAttempts + 1 committed before the rejection, history "Certificate registration challenge verification failed (attempt N)"; missing / blank: 422 "…challenge is required." with no attempt; a verified secret resets the counter',
                'no CSR: "A certificate signing request is required to issue a registered certificate. Certificate: …"; a secret against no active authorization: "An authorization secret was presented but the certificate has no active registration authorization to verify it against."; an issued certificate: "Cannot issue certificate with state Issued."',
                'ilm#279 (wrong secret → 422, failedAttempts++, still REGISTERED)',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            // Two wrong secrets are sent before the right one: a tier whose maxFailedAttempts is 2 or less would LOCK the
            // authorization and the table could not be judged (settings are read, never set).
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
                const r = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c23', secret: newChallenge() });
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
                const plain = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c23p' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
                refused(await issueExisting(api, plain.cert!, ra, { request: csrFromKey(newKeyPair(), plain.cn).derBase64, authorizationSecret: newChallenge() }),
                    'An authorization secret was presented but the certificate has no active registration authorization to verify it against.');
            });
        });
});
