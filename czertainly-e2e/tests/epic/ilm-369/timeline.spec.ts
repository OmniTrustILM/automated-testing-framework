/**
 * timeline — Epic ilm#369: reminders for non-compliant certificates over the hourly runs of the certificate status job.
 * A seed makes the certificates not compliant ("the start"); one check per later job run (run 1, 2, 3) finds them by TIMELINE_ID.
 */
import { APIRequestContext } from '@playwright/test';
import { minLifetimeForTest } from '../../../utils/auth/accessToken';
import { test, expect, getAuthenticatedApiContext } from '../../../fixtures/testFixtures';
import { recordCleanupFailure } from '../../../utils/cleanupLedger';
import { generateSelfSignedCert, uploadCertificate, findCertificateByFingerprint } from '../../../utils/certificateUtils';
import { Logger } from '../../../utils/Logger';
import { readSmokeState } from '../../../utils/smokeState';
import {
    EXPIRING_EVENT, NOT_COMPLIANT_EVENT, ENVIRONMENT, Notification, associateComplianceProfile, archiveCertificate, assignRaProfile,
    attributeNameOf, call, cleanupStaleTimelines, cleanupTimeline, complianceProfileOf, createComplianceSetup, createGroup, createNotificationProfile,
    createNotifyingTrigger, eventHistoryOf, findTimelineCertificates, getCertificate, isExpiring, isNotCompliant, issueCertificate, listMyNotifications,
    makeCompliance, notificationsOf, prefixOf, runAfter, setGroup, statusJobRuns, TIMELINE_CERTIFICATES, userUuidOf, within,
} from '../../../utils/epic369Utils';

const logger = new Logger('Epic369Timeline');
const SEED = 'seed';

function requireSmokeState() {
    const smoke = readSmokeState();
    if (!smoke) throw new Error(`${ENVIRONMENT} the smoke state of this run is missing: its PKI chain was not provisioned`);
    return smoke;
}

async function withApi<T>(request: APIRequestContext, env: Parameters<typeof getAuthenticatedApiContext>[1], body: (api: APIRequestContext) => Promise<T>): Promise<T> {
    const api = await getAuthenticatedApiContext(request, env, { minLifetimeMs: minLifetimeForTest(test.info().timeout) });
    try {
        return await body(api);
    } finally {
        await api.dispose();
    }
}

/** What a check needs of the seed: the certificates, the flag attribute, the user's notifications, the job runs and the start. */
async function readTimeline(api: APIRequestContext) {
    const prefix = prefixOf();
    const certs = await findTimelineCertificates(api, prefix);
    for (const name of TIMELINE_CERTIFICATES) {
        if (!certs[name]) throw new Error(`${ENVIRONMENT} certificate ${prefix}${name} of the ${SEED} is not found: the timeline was not seeded or was removed`);
    }
    const attributes = (await call(api, 'get', '/v1/attributes/custom')) as Array<{ uuid: string; name: string }>;
    const attribute = attributes.find((a) => a.name === attributeNameOf(prefix));
    if (!attribute) throw new Error(`${ENVIRONMENT} custom attribute of the ${SEED} is not found`);
    const notifications = await listMyNotifications(api);
    const firstOfReminded = notificationsOf(notifications, certs.reminded).filter(isNotCompliant)[0];
    if (!firstOfReminded) throw new Error(`the reminded certificate has no "not compliant" notification, so the start is unknown: S2 failed in the ${SEED}`);
    const runs = await statusJobRuns(api);
    return { prefix, certs, attributeUuid: attribute.uuid, notifications, runs, start: firstOfReminded.sentAt };
}

type Timeline = Awaited<ReturnType<typeof readTimeline>>;

/** The k-th job run after the start and the end of its window: the start of the next run. */
function windowOf(t: Timeline, k: number) {
    const { run, next } = runAfter(t.runs, t.start, k);
    return { run, from: run.start, to: next?.start, next };
}

const kindFilter = { notCompliant: isNotCompliant, expiring: isExpiring };

function countIn(t: Timeline, cert: string, kind: keyof typeof kindFilter, from: number, to?: number): number {
    return within(notificationsOf(t.notifications, t.certs[cert]).filter(kindFilter[kind]), (n: Notification) => n.sentAt, from, to).length;
}

const totalOf = (t: Timeline, cert: string, kind: keyof typeof kindFilter): number => countIn(t, cert, kind, 0);

async function firingsIn(api: APIRequestContext, t: Timeline, cert: string, from: number, to?: number): Promise<number> {
    const firings = (await eventHistoryOf(api, t.certs[cert])).filter((f) => f.event === NOT_COMPLIANT_EVENT);
    return within(firings, (f) => f.triggeredAt, from, to).length;
}

test.describe('@epic-369 reminders timeline', () => {
    // A retry of the seed would meet the certificates of the first attempt; the runner repeats the whole timeline instead.
    test.describe.configure({ retries: 0 });

    test('S2: the first notification is sent at once (the seed of the timeline)', { tag: ['@epic-369', '@regression', '@timeline', '@timeline-t0'] }, async ({ request, env }) => {
        test.setTimeout(20 * 60_000);
        const smoke = requireSmokeState();
        const prefix = prefixOf();

        await withApi(request, env, async (api) => {
            await cleanupStaleTimelines(api, prefix);
            const leftovers = await cleanupTimeline(api, prefix);
            if (leftovers.length) throw new Error(`${ENVIRONMENT} objects of an earlier seed with this prefix could not be removed:\n${leftovers.join('\n')}`);

            const userUuid = await userUuidOf(api, env.username);
            const group = async (n: number) => createGroup(api, `${prefix}g${n}`);
            const [g1, g2, g3, g4, g5, g7] = [await group(1), await group(2), await group(3), await group(4), await group(5), await group(7)];

            const notifyOnce = await createNotificationProfile(api, `${prefix}p0`, userUuid);
            const twoRepetitions = await createNotificationProfile(api, `${prefix}p1`, userUuid, { repetitions: 2 });
            const everyTwoHours = await createNotificationProfile(api, `${prefix}p2`, userUuid, { frequency: 'PT2H' });
            const expiringTwice = await createNotificationProfile(api, `${prefix}p3`, userUuid, { repetitions: 2 });
            const expiringUnlimited = await createNotificationProfile(api, `${prefix}p4`, userUuid);
            await createNotifyingTrigger(api, `${prefix}t1`, NOT_COMPLIANT_EVENT, [twoRepetitions], g1);
            await createNotifyingTrigger(api, `${prefix}t2`, NOT_COMPLIANT_EVENT, [everyTwoHours], g2);
            await createNotifyingTrigger(api, `${prefix}t3`, NOT_COMPLIANT_EVENT, [notifyOnce], g3);
            await createNotifyingTrigger(api, `${prefix}t7`, NOT_COMPLIANT_EVENT, [twoRepetitions, notifyOnce], g7);
            await createNotifyingTrigger(api, `${prefix}t6`, EXPIRING_EVENT, [expiringTwice], g4);
            await createNotifyingTrigger(api, `${prefix}t5`, EXPIRING_EVENT, [expiringUnlimited], g5);

            const compliance = await createComplianceSetup(api, prefix);
            await associateComplianceProfile(api, compliance.profileUuid, smoke.raProfileUuid);

            // compliant first, so that the flip below is the transition
            const compliant: Record<string, string> = {};
            const issued = [['reminded', g1], ['twohourly', g2], ['once', g3], ['recovered', g1], ['archived', g1], ['twoprofiles', g7]] as const;
            for (const [name, groupUuid] of issued) {
                compliant[name] = await issueCertificate(api, smoke.authorityUuid, smoke.raProfileUuid, `${prefix}${name}`, groupUuid);
                await makeCompliance(api, compliant[name], compliance.attributeUuid, true);
            }

            // S9, S10: self-signed, valid for 10 days (inside the expiring threshold); marked as a trusted CA so validation reaches the validity
            const expiring: Record<string, string> = {};
            for (const [name, groupUuid] of [['expiring', g4], ['everyrun', g5]] as const) {
                const cert = generateSelfSignedCert(`${prefix}${name}`, 10);
                await uploadCertificate(api, cert.pem);
                await expect.poll(async () => (await findCertificateByFingerprint(api, cert.fingerprint))?.uuid, { message: `${name} appears after the upload`, timeout: 60_000 }).toBeTruthy();
                expiring[name] = (await findCertificateByFingerprint(api, cert.fingerprint))!.uuid;
                await setGroup(api, expiring[name], groupUuid);
                await call(api, 'patch', `/v1/certificates/${expiring[name]}`, { trustedCa: true });
                await call(api, 'get', `/v1/certificates/${expiring[name]}/validate`);
            }

            for (const [name] of issued) await makeCompliance(api, compliant[name], compliance.attributeUuid, false);

            const expectedAtStart: Record<string, number> = { reminded: 1, twohourly: 1, once: 1, recovered: 1, archived: 1, twoprofiles: 2 };
            let notifications: Notification[] = [];
            try {
                await expect.poll(async () => {
                    notifications = await listMyNotifications(api);
                    return Object.fromEntries(Object.keys(expectedAtStart).map((c) => [c, notificationsOf(notifications, compliant[c]).filter(isNotCompliant).length]));
                }, { message: 'first notifications at the start, per certificate', timeout: 90_000, intervals: [5_000] }).toEqual(expectedAtStart);
            } catch (e) {
                for (const c of Object.keys(expectedAtStart)) {
                    const sent = notificationsOf(notifications, compliant[c]).map((n) => `${new Date(n.sentAt).toISOString()} ${n.message.slice(-40)}`);
                    const fired = (await eventHistoryOf(api, compliant[c])).map((f) => `${new Date(f.triggeredAt).toISOString()} ${f.event}`);
                    logger.warn(`${c}: notifications ${JSON.stringify(sent)}; firings ${JSON.stringify(fired)}`);
                }
                throw e;
            }
            expect((await eventHistoryOf(api, compliant.reminded)).filter((f) => f.event === NOT_COMPLIANT_EVENT).length, 'the reminded certificate shows the "Certificate not compliant" firing').toBe(1);

            // S6: compliant again before the next job run, so it keeps only its first notification
            await makeCompliance(api, compliant.recovered, compliance.attributeUuid, true);
            expect(notificationsOf(await listMyNotifications(api), compliant.recovered).filter(isNotCompliant), 'the recovered certificate keeps only its first notification').toHaveLength(1);

            // S8: archived before run 1
            await archiveCertificate(api, compliant.archived);
            expect((await getCertificate(api, compliant.archived)).archived, 'the archived certificate is archived').toBe(true);

            // S9, S10: the validation status is expiring before the next job run
            for (const name of ['expiring', 'everyrun']) {
                await expect.poll(async () => (await getCertificate(api, expiring[name])).validationStatus, { message: `${name} validation status`, timeout: 180_000, intervals: [5_000] }).toBe('expiring');
            }
        });
    });

    test('S3: run 1 sends one reminder, and the first expiring notification in the same run; also S2, S4–S6, S8–S10', { tag: ['@epic-369', '@timeline', '@timeline-r1'] }, async ({ request, env }) => {
        test.setTimeout(5 * 60_000);
        await withApi(request, env, async (api) => {
            const t = await readTimeline(api);
            const { run, from, to } = windowOf(t, 1);

            await test.step('S2: before run 1 each certificate has its first notification', async () => {
                for (const cert of ['reminded', 'twohourly', 'once', 'recovered', 'archived']) expect(countIn(t, cert, 'notCompliant', 0, from), `${cert} before run 1`).toBe(1);
            });
            await test.step('S3: the reminded certificate gets one reminder and one new firing; the result of run 1 reports the reminders', async () => {
                expect(run.status, 'run 1 succeeded').toBe('succeeded');
                expect(countIn(t, 'reminded', 'notCompliant', from, to), 'reminders of the reminded certificate in run 1').toBe(1);
                expect(await firingsIn(api, t, 'reminded', from, to), 'firings of the reminded certificate in run 1').toBe(1);
                const handled = /Handled (\d+) non-compliant certificates with reminders/.exec(run.message);
                expect(handled, `the result message of run 1: ${run.message}`).not.toBeNull();
                expect(Number(handled![1]), 'reminders handled in run 1 (the reminded and the two-profile certificate, at least)').toBeGreaterThanOrEqual(2);
            });
            await test.step('S4: the two-hourly certificate gets nothing in run 1', async () => {
                expect(countIn(t, 'twohourly', 'notCompliant', from, to)).toBe(0);
            });
            // both profiles notify the same user with the same text: the count cannot tell which profile sent the reminder
            await test.step('S5: the notify-once certificate gets nothing and no firing; the two-profile certificate gets one more', async () => {
                expect(countIn(t, 'once', 'notCompliant', from, to)).toBe(0);
                expect(await firingsIn(api, t, 'once', from, to), 'firings of the notify-once certificate in run 1').toBe(0);
                expect(countIn(t, 'twoprofiles', 'notCompliant', 0, from), 'the two-profile certificate at the start (both profiles)').toBe(2);
                expect(countIn(t, 'twoprofiles', 'notCompliant', from, to), 'the two-profile certificate in run 1 (the reminding profile)').toBe(1);
            });
            await test.step('S6, S8: the recovered and the archived certificate get no reminder', async () => {
                expect(countIn(t, 'recovered', 'notCompliant', from, to)).toBe(0);
                expect(countIn(t, 'archived', 'notCompliant', from, to)).toBe(0);
            });
            await test.step('S9, S10: run 1 sends the first expiring notification of both expiring certificates', async () => {
                expect(countIn(t, 'expiring', 'expiring', 0, from), 'expiring certificate before run 1').toBe(0);
                expect(countIn(t, 'expiring', 'expiring', from, to), 'expiring certificate in run 1').toBe(1);
                expect(countIn(t, 'everyrun', 'expiring', from, to), 'every-run certificate in run 1').toBe(1);
                const handled = /Handled (\d+) expiring certificates/.exec(run.message);
                expect(handled, `the result message of run 1: ${run.message}`).not.toBeNull();
                expect(Number(handled![1]), 'expiring certificates handled in run 1 (both expiring certificates, at least)').toBeGreaterThanOrEqual(2);
            });
        });
    });

    test('S7: run 2 sends nothing to the reminded certificate, and a new non-compliance starts from the beginning; also S3–S6, S8–S10', { tag: ['@epic-369', '@timeline', '@timeline-r2'] }, async ({ request, env }) => {
        test.setTimeout(10 * 60_000);
        const smoke = requireSmokeState();
        await withApi(request, env, async (api) => {
            const t = await readTimeline(api);
            const first = windowOf(t, 1);
            const { run, from, next } = windowOf(t, 2);
            if (next) throw new Error(`${ENVIRONMENT} run 3 has already started: S7 must be done between run 2 and run 3`);

            await test.step('S3: in run 2 the reminded certificate gets nothing and no firing; two notifications in total', async () => {
                expect(run.status, 'run 2 succeeded').toBe('succeeded');
                expect(countIn(t, 'reminded', 'notCompliant', from), 'the reminded certificate after run 2').toBe(0);
                expect(await firingsIn(api, t, 'reminded', from), 'firings of the reminded certificate in run 2').toBe(0);
                expect(totalOf(t, 'reminded', 'notCompliant'), 'the reminded certificate in total: the first notification counts as the first repetition').toBe(2);
            });
            await test.step('S4, S5, S6, S8: nothing in run 2; the two-profile certificate has 3 in total', async () => {
                for (const cert of ['twohourly', 'once', 'recovered', 'archived', 'twoprofiles']) expect(countIn(t, cert, 'notCompliant', from), `${cert} in run 2`).toBe(0);
                expect(totalOf(t, 'twoprofiles', 'notCompliant'), 'the two-profile certificate in total').toBe(3);
                expect(totalOf(t, 'once', 'notCompliant'), 'the notify-once certificate in total').toBe(1);
                expect(await firingsIn(api, t, 'once', from), 'firings of the notify-once certificate in run 2').toBe(0);
                expect(await firingsIn(api, t, 'twoprofiles', first.from, from), 'the two-profile certificate: the event is raised again in run 1').toBe(1);
            });
            await test.step('S9, S10: the second expiring notification, and the every-run certificate notified again', async () => {
                expect(countIn(t, 'expiring', 'expiring', from), 'expiring certificate in run 2').toBe(1);
                expect(countIn(t, 'everyrun', 'expiring', from), 'every-run certificate in run 2').toBe(1);
            });

            await test.step('S7: the reminded certificate becomes compliant and not compliant again, and the user gets a new notification', async () => {
                // this execution has its own RA profile: the timeline's compliance profile is associated with it for the check
                await associateComplianceProfile(api, await complianceProfileOf(api, t.prefix), smoke.raProfileUuid);
                await assignRaProfile(api, t.certs.reminded, smoke.raProfileUuid);
                await makeCompliance(api, t.certs.reminded, t.attributeUuid, true);
                await makeCompliance(api, t.certs.reminded, t.attributeUuid, false);
                await expect.poll(async () => notificationsOf(await listMyNotifications(api), t.certs.reminded).filter(isNotCompliant).length, {
                    message: 'notifications of the reminded certificate after the new non-compliance', timeout: 240_000, intervals: [5_000],
                }).toBe(3);
            });
        });
    });

    test('S7: run 3 reminds the restarted certificate once; also S4–S6, S8–S10 (the last check, removes the timeline)', { tag: ['@epic-369', '@regression', '@timeline', '@timeline-r3'] }, async ({ request, env }) => {
        test.setTimeout(10 * 60_000);
        await withApi(request, env, async (api) => {
            const prefix = prefixOf();
            let failures: string[] = [];
            try {
                const t = await readTimeline(api);
                const { run, from, to } = windowOf(t, 3);

                await test.step('S7: in run 3 the reminded certificate gets one reminder again (the count started from the beginning)', async () => {
                    expect(run.status, 'run 3 succeeded').toBe('succeeded');
                    expect(countIn(t, 'reminded', 'notCompliant', from, to), 'reminders of the reminded certificate in run 3').toBe(1);
                    expect(totalOf(t, 'reminded', 'notCompliant'), 'the reminded certificate: 2 before, the new first notification, one reminder').toBe(4);
                });
                await test.step('S4: the two-hourly certificate: nothing in runs 1 and 2, one reminder in run 3', async () => {
                    expect(countIn(t, 'twohourly', 'notCompliant', 0, from), 'the two-hourly certificate before run 3: only the first').toBe(1);
                    expect(countIn(t, 'twohourly', 'notCompliant', from, to), 'the two-hourly certificate in run 3').toBe(1);
                });
                await test.step('S5, S6, S8: nothing more for the notify-once, recovered, archived and two-profile certificates', async () => {
                    expect(totalOf(t, 'once', 'notCompliant'), 'the notify-once certificate in total').toBe(1);
                    expect(totalOf(t, 'recovered', 'notCompliant'), 'the recovered certificate in total').toBe(1);
                    expect(totalOf(t, 'archived', 'notCompliant'), 'the archived certificate in total').toBe(1);
                    expect(totalOf(t, 'twoprofiles', 'notCompliant'), 'the two-profile certificate in total').toBe(3);
                });
                await test.step('S9: run 3 sends nothing for the expiring certificate, which has exactly 2 expiring notifications', async () => {
                    expect(countIn(t, 'expiring', 'expiring', from, to), 'expiring certificate in run 3').toBe(0);
                    expect(totalOf(t, 'expiring', 'expiring'), 'expiring certificate in total').toBe(2);
                });
                await test.step('S10: the every-run certificate is notified in run 3 as well, as in every run', async () => {
                    expect(countIn(t, 'everyrun', 'expiring', from, to), 'every-run certificate in run 3').toBe(1);
                });
            } finally {
                failures = await cleanupTimeline(api, prefix);
                for (const message of failures) recordCleanupFailure({ resource: 'timeline', name: prefix, message });
            }
            expect(failures, 'the timeline objects are removed').toEqual([]);
        });
    });
});
