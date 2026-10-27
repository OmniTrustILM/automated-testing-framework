/**
 * API-CERT-21, 22, 23 — Platform-level pre-registration through the v2 API. ilm#429.
 *
 * WHAT: 1. Register with a CN and a challenge → 200; the certificate becomes registered with an active registration, no failed attempt and
 *          an expiry of now plus the default issuance window; the secret is never echoed, stored in the detail or written to the
 *          history; without a secret there is no registration block.
 *       2. The "Certificate registered" event fires for a challenge-protected registration and not for one without a challenge.
 *       3. Register with an invalid bearer token → 401 (not on a local stack).
 *       4. A CN with RFC 4514 special characters registers with an escaped subject DN (core#2258, core#2509: test.fail while open).
 *       5. Complete a registered certificate with the right secret and a CSR → issued with the CSR key, the registered identity kept, the
 *          authorization still active, the window cleared; without a challenge a CSR alone completes.
 *       6. Completion refuses a wrong secret (422, failed attempts counted, history "attempt N"), a missing or blank secret (422, no
 *          attempt), no CSR, a secret without an active authorization and an already issued certificate; the right secret afterwards
 *          issues and resets the counter.
 * WHY: a registration reserves an identity and a challenge-protected right to complete it (core#1820; ilm#279 for the wrong-secret rule).
 *      The secret is stored encrypted and never returned. The Certificate Registered event fires only with a challenge. The subject DN
 *      built from request attributes must be well-formed and RFC 4514 escaped.
 * HOW: registration creates new own certificates only, recorded in the ledger before any assertion. The event rows observe through an own
 *      trigger on an own clone of the run RA profile (the run RA profile is shared by other specs and is never associated) and skip while
 *      a platform-level trigger on the event would act on these certificates too. The rows skip when the tier's registration settings
 *      cannot hold a challenge (completion table: maxFailedAttempts must exceed 2, because two wrong secrets are sent before the right
 *      one; settings are read, never set). The register call has no path and is not on the guard's list yet.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { opsBase } from '../../../utils/regression/lifecycle/certificateLabels';
import { specialCharCn, waitIssued } from '../../../utils/regression/ownCertificates';
import { issueExisting } from '../../../utils/regression/lifecycle/certificateOperations';
import { msBetween, newChallenge, registerOwnCertificate, registrationDefaults, registrationOf } from '../../../utils/regression/lifecycle/preRegistration';
import { sendRaw } from '../../../utils/regression/lifecycle/rawAnswers';
import { newKeyPair, csrFromKey, parseCertificate, publicKeyPemOf, sansOfDetail } from '../../../utils/regression/pkiBuilders';
import { getCertificate, ApiAnswer } from '../../../utils/regression/apiReads';
import { expectRefused } from '../../../utils/regression/errorContract';
import { checkedCommonName, ownCommonName, ownName } from '../../../utils/regression/ledger/runState';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { EVENT_FIRING_WAIT_MS, LIFECYCLE_MS, MANY_STEPS_TEST_MS, QUICK_STATE_WAIT_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { isLocalTier } from '../../../utils/regression/tier/kind';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { assertHeldFor, firingsOfObject, getFirings, waitForFinishedFirings } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { cloneRunRaProfile, OwnRaProfile } from '../../../utils/regression/ownRaProfiles';
import type { GuardedApi } from '../../../utils/regression/guard/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long a firing of an event is awaited. */
const FIRING_WAIT = { timeoutMs: EVENT_FIRING_WAIT_MS };

test.describe('Certificate pre-registration through the v2 API', { tag: tags.api }, () => {
    test('registering with a CN and a challenge gives a registered certificate and never echoes the secret',
        testMeta({
            id: 'API-CERT-21', prio: 'P1', issue: 'ilm#429', needs: 'registration-settings',
            rule: [
                'REGISTERED placeholder; the secret is stored encrypted and never returned; expiresAt defaults to defaultIssuanceWindowDays; core#1820 (platform-level on EJBCA-NG and MS ADCS NG)',
                'requested → pending_registration → registered; the "Certificate Registered" event fires only with a challenge; requestAttributeWarnings always empty; expiresAt only with a secret',
            ],
        }),
        async ({ api, own, ownRaProfile }, testInfo) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const defaults = await registrationDefaults(api);
            testInfo.annotations.push({ type: 'registration-settings', description: `defaultIssuanceWindowDays ${defaults.defaultIssuanceWindowDays}, maxFailedAttempts ${defaults.maxFailedAttempts}` });

            const reg = await test.step('POST …/certificates/register {csrAttributes: [CN], authorizationSecret} → 200 {uuid, certificateData: ""}', async () => {
                const r = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c21', secret: newChallenge(), note: 'Certificate pre-registration through the v2 API' });
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
                await waitForCertificateState(api, cert.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                const detail = await getCertificate(api, cert.uuid);
                expect(detail.state).toBe('registered');
                expect(detail.registration?.state).toBe('active');
                expect(detail.registration?.failedAttempts ?? 0).toBe(0);
                const expected = new Date((reg.answer.serverAt ?? new Date()).getTime() + defaults.defaultIssuanceWindowDays * 24 * 3600 * 1000);
                expect(msBetween(String(detail.registration?.expiresAt), expected), 'expiresAt within 5 min of now + the default window').toBeLessThanOrEqual(5 * 60 * 1000);
                expect(JSON.stringify(detail), 'the detail never carries the secret').not.toContain(reg.secret!);
                expect(historyMessages(await historyOf(api, cert.uuid)).join('\n'), 'the history never carries the secret').not.toContain(reg.secret!);
            });

            await test.step('Without a secret: registered, no registration block', async () => {
                const plain = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c21p', note: 'API-CERT-21 registration without a challenge' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                expect((await getCertificate(api, plain.cert!.uuid)).registration ?? null).toBeNull();
            });
        });

    // The two event arms observe through an own trigger on `Certificate registered`, associated on an own clone of the run RA
    // profile (the run RA profile is shared by the run's other specs and is never associated): a firing in that scope is the event.
    // A platform-level trigger on the event would act on these certificates too, so the arms skip then; the gate is read first.
    /**
     * An own clone of the run RA profile with an own trigger on `Certificate registered` associated on it; firings in its scope are the
     * event.
     */
    async function ownRegisteredObserver(api: GuardedApi, own: OwnObjects, suffix: string): Promise<{ ra: OwnRaProfile; scope: { resource: 'raProfiles'; objectUuid: string } }> {
        const clone = await cloneRunRaProfile(api, own.spec, suffix);
        const attr = await own.customAttribute(`${suffix}-mark`, { resources: ['certificates'] });
        const chain = await createOwnChain(api, own.spec, suffix, { event: EVENT.registered, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'fired')] });
        const sent = await associateTriggers(api, own.spec, { event: EVENT.registered, resource: 'raProfiles', object: clone, triggers: [chain.trigger] });
        expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
        return { ra: clone, scope: { resource: 'raProfiles', objectUuid: clone.uuid } };
    }

    test('the "Certificate registered" event fires for a challenge-protected registration',
        testMeta({
            id: 'API-CERT-21', row: 'event-fires', prio: 'P1', issue: 'ilm#429', needs: 'ca',
            rule: ['the "Certificate Registered" event fires with a challenge; observed through an own trigger on an own clone of the run RA profile; skipped while a platform-level trigger on the event would act on these certificates too'],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.registered);
            const observer = await ownRegisteredObserver(api, own, 'c21ev');
            const withSecret = await registerOwnCertificate(api, observer.ra, own.spec, { suffix: 'c21ev', secret: newChallenge(), note: 'API-CERT-21 event arm: challenge-protected registration' });
            expect(withSecret.answer.status, withSecret.answer.text.slice(0, 300)).toBe(200);
            const page = await waitForFinishedFirings(api, { event: EVENT.registered, scope: observer.scope, pageSize: 50 }, 1, FIRING_WAIT);
            expect(firingsOfObject(page, withSecret.cert!.uuid), 'one firing of Certificate registered for the challenge-protected certificate').toHaveLength(1);
        });

    test('a registration without a challenge fires no "Certificate registered" event',
        testMeta({
            id: 'API-CERT-21', row: 'no-event-without-secret', prio: 'P1', issue: 'ilm#429', needs: 'ca',
            rule: ['the "Certificate Registered" event fires only with a challenge; a registration without one fires nothing (checked after the observer has shown it fires for a challenge-protected one)'],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.registered);
            const observer = await ownRegisteredObserver(api, own, 'c21nev');
            const scope = observer.scope;
            await test.step('A challenge-protected registration fires once: the observer works', async () => {
                const before = await registerOwnCertificate(api, observer.ra, own.spec, { suffix: 'c21nevb', secret: newChallenge(), note: 'API-CERT-21 event arm: the registration that shows the observer works' });
                expect(before.answer.status, before.answer.text.slice(0, 300)).toBe(200);
                await waitForFinishedFirings(api, { event: EVENT.registered, scope, pageSize: 50 }, 1, FIRING_WAIT);
            });
            const noSecret = await test.step('A registration without a challenge is registered', async () => {
                const r = await registerOwnCertificate(api, observer.ra, own.spec, { suffix: 'c21evp', note: 'API-CERT-21 event arm: registration without a challenge' });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                return r;
            });
            await test.step('A later challenge-protected registration bounds the wait; the one without a challenge never fired', async () => {
                // A later challenge-protected registration in the same scope bounds the wait: once its firing is finished, the
                // registration before it has been handled too; a short grace window then holds the absence.
                const after = await registerOwnCertificate(api, observer.ra, own.spec, { suffix: 'c21evs', secret: newChallenge(), note: 'API-CERT-21 event arm: the registration after the one without a challenge' });
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
        });

    test('register refuses an invalid bearer token with 401',
        testMeta({
            id: 'API-CERT-21', row: 'no-credentials', prio: 'P1', issue: 'ilm#429',
            rule: ['no valid credentials → 401 on register; not asserted on a local stack, where the dev proxy (AUTH_MODE=header) or the localhost identity may authenticate the call'],
        }),
        async ({ api, own, ownRaProfile }) => {
            test.skip(isLocalTier(), 'local stack: the dev proxy (AUTH_MODE=header) or the localhost identity may authenticate a call with an invalid bearer token, so the 401 is not asserted there');
            // The name is built (and checked) before the request: a failing name check cannot leave an accepted register unrecorded.
            const name = ownCommonName('c21-anon');
            const a = await sendRaw(api, 'POST', `${opsBase(ownRaProfile)}/certificates/register`, { csrAttributes: [], attributes: [] }, { headers: { authorization: 'Bearer invalid' }, identityOverride: true });
            // Ledger first: a register accepted without credentials made a certificate of this run.
            own.probe('certificates', a, { name, note: 'register accepted with an invalid bearer', parents: { raProfile: ownRaProfile.uuid, authority: ownRaProfile.authorityUuid } });
            expect(a.status, a.text.slice(0, 200)).toBe(401);
        });

    test('a CN with RFC 4514 special characters registers with an escaped subject DN',
        testMeta({
            id: 'API-CERT-21', row: 'rfc4514', prio: 'P1', issue: 'ilm#429', bug: ['core#2258', 'core#2509'],
            rule: ['core#2258 / core#2509 (the subject DN built from request attributes must be well-formed and RFC 4514 escaped; open bugs, marked with test.fail)', 'csrAttributes project to the subject'],
        }),
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            const ra = ownRaProfile;
            const cn = checkedCommonName(specialCharCn(ownName('c21dn')));
            // The bugs break the register itself (422 "Invalid subject DN … badly formatted directory string"), so the marker sits right
            // before it; the setup above runs outside it. The test turns red when the bugs are fixed (then drop the pin).
            test.fail(true, 'core#2258 / core#2509: the subject DN built from request attributes is malformed and not RFC 4514 escaped (open)');
            const r = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c21dn', cn, secret: newChallenge(), note: 'API-CERT-21 special-character CN (core#2258 / core#2509)' });
            expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, r.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
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
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;

            await test.step('With a challenge: complete with the right secret and a matching CSR → 200, issued with the CSR key, identity preserved, authorization ACTIVE / 0 / no window', async () => {
                const reg = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c22', secret: newChallenge() });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                const registered = await getCertificate(api, reg.cert!.uuid);
                const csr = csrFromKey(newKeyPair(), reg.cn);
                const a = await issueExisting(api, reg.cert!, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitIssued(api, reg.cert!.uuid);
                await own.derivedKey(reg.cert!.uuid, reg.createdAfter);
                const issued = await getCertificate(api, reg.cert!.uuid);
                expect(issued.subjectDn).toBe(registered.subjectDn);
                expect(sansOfDetail(issued.subjectAlternativeNames)).toEqual(sansOfDetail(registered.subjectAlternativeNames));
                expect(publicKeyPemOf(parseCertificate(issued.certificateContent))).toBe(csr.publicKeyPem);
                expect(issued.registration?.state).toBe('active');
                expect(issued.registration?.failedAttempts ?? 0).toBe(0);
                expect(issued.registration?.expiresAt ?? null, 'the issuance window is cleared').toBeNull();
            });

            await test.step('Without a challenge: a CSR alone completes; no registration block', async () => {
                const reg = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c22p' });
                expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, reg.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                const csr = csrFromKey(newKeyPair(), reg.cn);
                const a = await issueExisting(api, reg.cert!, ra, { request: csr.derBase64 });
                expect(a.status, a.text.slice(0, 300)).toBe(200);
                await waitIssued(api, reg.cert!.uuid);
                await own.derivedKey(reg.cert!.uuid, reg.createdAfter);
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
        async ({ api, own, ownRaProfile, needs }) => {
            test.setTimeout(LIFECYCLE_MS);
            const ra = ownRaProfile;
            // Two wrong secrets are sent before the right one: a tier whose maxFailedAttempts is 2 or less would LOCK the
            // authorization and the table could not be judged (settings are read, never set).
            await needs.registrationSettings({ minFailedAttempts: 3 });
            // 422, exactly one message that contains the text (the rest of the message names the certificate).
            const refused = (a: ApiAnswer, text: string) => {
                expectRefused(a, { status: 422, text: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
            };
            const INVALID = 'The certificate registration challenge is invalid.';
            const REQUIRED = 'The certificate registration challenge is required.';

            const reg = await test.step('Fixture: a registration with a challenge', async () => {
                const r = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c23', secret: newChallenge() });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
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
                await waitIssued(api, cert.uuid);
                await own.derivedKey(cert.uuid, reg.createdAfter);
                expect(await attempts()).toBe(0);
            });

            await test.step('Complete on an issued certificate → 422 "Cannot issue certificate with state Issued."', async () => {
                refused(await issueExisting(api, cert, ra, { request: csr.derBase64, authorizationSecret: reg.secret }), 'Cannot issue certificate with state Issued.');
            });

            await test.step('A secret presented to a registration without an authorization → 422 "…no active registration authorization…"', async () => {
                const plain = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c23p' });
                expect(plain.answer.status, plain.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, plain.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                refused(await issueExisting(api, plain.cert!, ra, { request: csrFromKey(newKeyPair(), plain.cn).derBase64, authorizationSecret: newChallenge() }),
                    'An authorization secret was presented but the certificate has no active registration authorization to verify it against.');
            });
        });
});
