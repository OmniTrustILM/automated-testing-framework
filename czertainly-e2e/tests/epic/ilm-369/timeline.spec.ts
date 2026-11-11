/**
 * WHAT: Epic ilm#369 — reminders for non-compliant certificates, over the hourly runs of the certificate status job (S2–S10).
 * WHY: a reminder is sent by a later run of a scheduled job, hours after the certificate became not compliant; no single test can wait for that.
 * HOW: the timeline is split. The seed (`@timeline-t0`) creates the groups, profiles, triggers, compliance rule and certificates, makes the
 *      certificates not compliant (T0) and checks the first notifications. One check per later moment (`@timeline-r1`, `-r2`, `-r3`) finds the
 *      objects by their `TIMELINE_ID` prefix and reads the outcome of the job run R<k>: the k-th run that started after T0.
 *      What "in run R<k>" means is the notifications and event firings that lie between the start of that run and the start of the next one.
 *      The last check removes the objects of the timeline; a seed first removes the leftovers of earlier timelines older than 6 hours.
 *      Certificates C6 and C7 are uploaded, not issued: an RA profile of this execution is removed with it, and with it its expiring threshold.
 */

import { APIRequestContext } from '@playwright/test';
import { test, expect, getAuthenticatedApiContext } from '../../../fixtures/testFixtures';
import { readSmokeState } from '../../../utils/smokeState';
import { generateSelfSignedCert, uploadCertificate, findCertificateByFingerprint } from '../../../utils/certificateUtils';
import {
    EXPIRING_EVENT, NOT_COMPLIANT_EVENT, ENVIRONMENT, Notification, associateComplianceProfile, archiveCertificate, assignRaProfile,
    attributeNameOf, call, cleanupStaleTimelines, cleanupTimeline, createComplianceSetup, createGroup, createNotificationProfile, createNotifyingTrigger,
    eventHistoryOf, findTimelineCertificates, getCertificate, isExpiring, isNotCompliant, issueCertificate, listMyNotifications, makeCompliance,
    notificationsOf, prefixOf, runAfter, setGroup, statusJobRuns, userUuidOf, within,
} from '../../../utils/epic369Utils';

const SEED = 'seed';

async function withApi<T>(request: APIRequestContext, env: Parameters<typeof getAuthenticatedApiContext>[1], body: (api: APIRequestContext) => Promise<T>): Promise<T> {
    const api = await getAuthenticatedApiContext(request, env);
    try {
        return await body(api);
    } finally {
        await api.dispose();
    }
}

/** What a check needs of the seed: the certificates, the flag attribute, the user's notifications, the job runs and T0. */
async function readTimeline(api: APIRequestContext) {
    const prefix = prefixOf();
    const certs = await findTimelineCertificates(api, prefix);
    for (const name of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) {
        if (!certs[name]) throw new Error(`${ENVIRONMENT} certificate ${prefix}${name} of the ${SEED} is not found: the timeline was not seeded or was removed`);
    }
    const attributes = (await call(api, 'get', '/v1/attributes/custom')) as Array<{ uuid: string; name: string }>;
    const attribute = attributes.find((a) => a.name === attributeNameOf(prefix));
    if (!attribute) throw new Error(`${ENVIRONMENT} custom attribute of the ${SEED} is not found`);
    const notifications = await listMyNotifications(api);
    const firstOfC1 = notificationsOf(notifications, certs.c1).filter(isNotCompliant)[0];
    if (!firstOfC1) throw new Error(`C1 has no "not compliant" notification, so T0 is unknown: S2 failed in the ${SEED}`);
    const t0 = firstOfC1.sentAt;
    const runs = await statusJobRuns(api);
    return { prefix, certs, attributeUuid: attribute.uuid, notifications, runs, t0 };
}

type Timeline = Awaited<ReturnType<typeof readTimeline>>;

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
    test('S2: the first notification is sent at once (seed of the timeline, T0)', { tag: ['@epic-369', '@regression', '@timeline', '@timeline-t0'] }, async ({ request, env }) => {
        test.setTimeout(20 * 60_000);
        const smoke = readSmokeState();
        if (!smoke) throw new Error(`${ENVIRONMENT} the smoke state of this run is missing: its PKI chain was not provisioned`);
        const prefix = prefixOf();

        await withApi(request, env, async (api) => {
            await cleanupStaleTimelines(api, prefix);
            await cleanupTimeline(api, prefix);

            const userUuid = await userUuidOf(api, env.username);
            const group = async (n: number) => createGroup(api, `${prefix}g${n}`);
            const [g1, g2, g3, g4, g5, g7] = [await group(1), await group(2), await group(3), await group(4), await group(5), await group(7)];

            const p0 = await createNotificationProfile(api, `${prefix}p0`, userUuid);
            const p1 = await createNotificationProfile(api, `${prefix}p1`, userUuid, { repetitions: 2 });
            const p2 = await createNotificationProfile(api, `${prefix}p2`, userUuid, { frequency: 'PT2H' });
            const p3 = await createNotificationProfile(api, `${prefix}p3`, userUuid, { repetitions: 2 });
            const p4 = await createNotificationProfile(api, `${prefix}p4`, userUuid);
            await createNotifyingTrigger(api, `${prefix}t1`, NOT_COMPLIANT_EVENT, [p1], g1);
            await createNotifyingTrigger(api, `${prefix}t2`, NOT_COMPLIANT_EVENT, [p2], g2);
            await createNotifyingTrigger(api, `${prefix}t3`, NOT_COMPLIANT_EVENT, [p0], g3);
            await createNotifyingTrigger(api, `${prefix}t7`, NOT_COMPLIANT_EVENT, [p1, p0], g7);
            await createNotifyingTrigger(api, `${prefix}t6`, EXPIRING_EVENT, [p3], g4);
            await createNotifyingTrigger(api, `${prefix}t5`, EXPIRING_EVENT, [p4], g5);

            const compliance = await createComplianceSetup(api, prefix);
            await associateComplianceProfile(api, compliance.profileUuid, smoke.raProfileUuid);

            // S9, S10 set-up: certificates that are expiring from the start, in the groups of the expiring triggers.
            const expiring: Record<string, string> = {};
            for (const [name, groupUuid] of [['c6', g4], ['c7', g5]] as const) {
                const cert = generateSelfSignedCert(`${prefix}${name}`, 10);
                await uploadCertificate(api, cert.pem);
                await expect.poll(async () => (await findCertificateByFingerprint(api, cert.fingerprint))?.uuid, { message: `${name} appears after the upload`, timeout: 60_000 }).toBeTruthy();
                expiring[name] = (await findCertificateByFingerprint(api, cert.fingerprint))!.uuid;
                await setGroup(api, expiring[name], groupUuid);
            }

            // C1–C5 and C8, issued from the run RA profile; compliant first, so that the flip below is the transition.
            const compliant: Record<string, string> = {};
            for (const [name, groupUuid] of [['c1', g1], ['c2', g2], ['c3', g3], ['c4', g1], ['c5', g1], ['c8', g7]] as const) {
                compliant[name] = await issueCertificate(api, smoke.authorityUuid, smoke.raProfileUuid, `${prefix}${name}`, groupUuid);
                await makeCompliance(api, compliant[name], compliance.attributeUuid, true);
            }

            // T0: each certificate becomes not compliant, the compliance check runs on that certificate only.
            for (const name of ['c1', 'c2', 'c3', 'c4', 'c5', 'c8']) await makeCompliance(api, compliant[name], compliance.attributeUuid, false);

            // S2, S4, S5: the first notification of each, at once.
            const expectedAtT0: Record<string, number> = { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c8: 2 };
            let notifications: Notification[] = [];
            await expect.poll(async () => {
                notifications = await listMyNotifications(api);
                return Object.fromEntries(Object.keys(expectedAtT0).map((c) => [c, notificationsOf(notifications, compliant[c]).filter(isNotCompliant).length]));
            }, { message: 'first notifications at T0 per certificate', timeout: 180_000, intervals: [5_000] }).toEqual(expectedAtT0);
            expect((await eventHistoryOf(api, compliant.c1)).filter((f) => f.event === NOT_COMPLIANT_EVENT).length, 'C1 event history shows the "Certificate not compliant" firing').toBe(1);

            // S6: C4 is compliant again at once, and the status job has not run in between: it has only the first notification.
            await makeCompliance(api, compliant.c4, compliance.attributeUuid, true);
            expect(notificationsOf(await listMyNotifications(api), compliant.c4).filter(isNotCompliant), 'C4 keeps only its first notification').toHaveLength(1);

            // S8: C5 is archived before R1.
            await archiveCertificate(api, compliant.c5);
            expect((await getCertificate(api, compliant.c5)).archived, 'C5 is archived').toBe(true);

            // S9, S10: the validation status of C6 and C7 is expiring before the next hourly run.
            for (const name of ['c6', 'c7']) {
                await expect.poll(async () => (await getCertificate(api, expiring[name])).validationStatus, { message: `${name} validation status`, timeout: 180_000, intervals: [5_000] }).toBe('expiring');
            }
        });
    });

    test('S3: the reminder at R1, and the first expiring notification in the same run', { tag: ['@epic-369', '@timeline', '@timeline-r1'] }, async ({ request, env }) => {
        test.setTimeout(5 * 60_000);
        await withApi(request, env, async (api) => {
            const t = await readTimeline(api);
            const { run: r1, next } = runAfter(t.runs, t.t0, 1);
            const to = next?.start;

            await test.step('S2: before R1 each certificate has its first notification', async () => {
                for (const [cert, n] of Object.entries({ c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 })) expect(countIn(t, cert, 'notCompliant', 0, r1.start), `${cert} before R1`).toBe(n);
            });
            await test.step('S3: C1 gets one reminder at R1 and one new firing; the result of R1 reports the reminders', async () => {
                expect(r1.status, 'R1 succeeded').toBe('succeeded');
                expect(countIn(t, 'c1', 'notCompliant', r1.start, to), 'C1 reminders at R1').toBe(1);
                expect(await firingsIn(api, t, 'c1', r1.start, to), 'C1 firings at R1').toBe(1);
                const handled = /Handled (\d+) non-compliant certificates with reminders/.exec(r1.message);
                expect(handled, `the result message of R1: ${r1.message}`).not.toBeNull();
                expect(Number(handled![1]), 'reminders handled in R1 (C1 and C8, at least)').toBeGreaterThanOrEqual(2);
            });
            await test.step('S4: C2, frequency 2 hours: nothing at R1', async () => {
                expect(countIn(t, 'c2', 'notCompliant', r1.start, to)).toBe(0);
            });
            await test.step('S5: C3 (neither frequency nor repetitions) gets nothing and no firing; C8 gets one more, from P1 only', async () => {
                expect(countIn(t, 'c3', 'notCompliant', r1.start, to)).toBe(0);
                expect(await firingsIn(api, t, 'c3', r1.start, to), 'C3 firings at R1').toBe(0);
                expect(countIn(t, 'c8', 'notCompliant', 0, r1.start), 'C8 at T0 (P1 and P0)').toBe(2);
                expect(countIn(t, 'c8', 'notCompliant', r1.start, to), 'C8 at R1 (P1)').toBe(1);
            });
            await test.step('S6, S8: C4 (compliant again) and C5 (archived) get no reminder', async () => {
                expect(countIn(t, 'c4', 'notCompliant', r1.start, to)).toBe(0);
                expect(countIn(t, 'c5', 'notCompliant', r1.start, to)).toBe(0);
            });
            await test.step('S9, S10: R1 is the first expiring notification of C6 and the first of C7, in the same run', async () => {
                expect(countIn(t, 'c6', 'expiring', 0, r1.start), 'C6 expiring before R1').toBe(0);
                expect(countIn(t, 'c6', 'expiring', r1.start, to), 'C6 at R1').toBe(1);
                expect(countIn(t, 'c7', 'expiring', r1.start, to), 'C7 at R1').toBe(1);
                const handled = /Handled (\d+) expiring certificates/.exec(r1.message);
                expect(handled, `the result message of R1: ${r1.message}`).not.toBeNull();
                expect(Number(handled![1]), 'expiring certificates handled in R1 (C6 and C7, at least)').toBeGreaterThanOrEqual(2);
            });
        });
    });

    test('S7: R2 sends nothing for C1, and a new non-compliance starts again from the beginning', { tag: ['@epic-369', '@timeline', '@timeline-r2'] }, async ({ request, env }) => {
        test.setTimeout(10 * 60_000);
        const smoke = readSmokeState();
        if (!smoke) throw new Error(`${ENVIRONMENT} the smoke state of this run is missing: its PKI chain was not provisioned`);
        await withApi(request, env, async (api) => {
            const t = await readTimeline(api);
            const { run: r1, next: r2 } = runAfter(t.runs, t.t0, 1);
            if (!r2) throw new Error(`${ENVIRONMENT} run R2 of the status job is not in its history`);
            const { run, next: r3 } = runAfter(t.runs, t.t0, 2);
            if (r3) throw new Error(`${ENVIRONMENT} R3 has already started: S7 must be done between R2 and R3`);

            await test.step('S3: at R2 C1 gets nothing and no firing; two notifications in total', async () => {
                expect(run.status, 'R2 succeeded').toBe('succeeded');
                expect(countIn(t, 'c1', 'notCompliant', run.start), 'C1 after R2').toBe(0);
                expect(await firingsIn(api, t, 'c1', run.start), 'C1 firings at R2').toBe(0);
                expect(totalOf(t, 'c1', 'notCompliant'), 'C1 in total: the first notification counts as the first repetition').toBe(2);
            });
            await test.step('S4, S5, S6, S8: nothing at R2 for C2, C3, C4, C5 and C8; C8 has 3 in total', async () => {
                for (const cert of ['c2', 'c3', 'c4', 'c5', 'c8']) expect(countIn(t, cert, 'notCompliant', run.start), `${cert} at R2`).toBe(0);
                expect(totalOf(t, 'c8', 'notCompliant'), 'C8 in total').toBe(3);
                expect(totalOf(t, 'c3', 'notCompliant'), 'C3 in total').toBe(1);
            });
            await test.step('S9, S10: the second expiring notification of C6, and C7 notified again', async () => {
                expect(countIn(t, 'c6', 'expiring', run.start), 'C6 at R2').toBe(1);
                expect(countIn(t, 'c7', 'expiring', run.start), 'C7 at R2').toBe(1);
                expect(r1.start).toBeLessThan(run.start);
            });

            await test.step('S7: C1 becomes compliant and not compliant again, and the user gets a new notification', async () => {
                // This execution has its own RA profile; the compliance profile of the timeline is associated with it for the check of C1.
                await associateComplianceProfile(api, (await complianceProfileOf(api, t.prefix)), smoke.raProfileUuid);
                await assignRaProfile(api, t.certs.c1, smoke.raProfileUuid);
                await makeCompliance(api, t.certs.c1, t.attributeUuid, true);
                await makeCompliance(api, t.certs.c1, t.attributeUuid, false);
                let count = 0;
                await expect.poll(async () => {
                    count = notificationsOf(await listMyNotifications(api), t.certs.c1).filter(isNotCompliant).length;
                    return count;
                }, { message: 'C1 notifications after the new non-compliance', timeout: 240_000, intervals: [5_000] }).toBe(3);
            });
        });
    });

    test('S9: R3 — C1 reminds again, C2 gets its reminder, C6 has two expiring notifications, C7 one more (last check, removes the timeline)', { tag: ['@epic-369', '@regression', '@timeline', '@timeline-r3'] }, async ({ request, env }) => {
        test.setTimeout(10 * 60_000);
        await withApi(request, env, async (api) => {
            try {
                const t = await readTimeline(api);
                const { run: r1, next: r2 } = runAfter(t.runs, t.t0, 1);
                if (!r2) throw new Error(`${ENVIRONMENT} run R2 of the status job is not in its history`);
                const { run: r3 } = runAfter(t.runs, t.t0, 3);

                await test.step('S7: at R3 C1 gets one reminder again (the count started from the beginning)', async () => {
                    expect(r3.status, 'R3 succeeded').toBe('succeeded');
                    expect(countIn(t, 'c1', 'notCompliant', r3.start), 'C1 reminders at R3').toBe(1);
                    expect(totalOf(t, 'c1', 'notCompliant'), 'C1: 2 before, the new first notification, one reminder').toBe(4);
                });
                await test.step('S4: C2 (frequency 2 hours): nothing at R1 and R2, one reminder at R3', async () => {
                    expect(countIn(t, 'c2', 'notCompliant', 0, r3.start), 'C2 before R3: only the first').toBe(1);
                    expect(countIn(t, 'c2', 'notCompliant', r3.start), 'C2 at R3').toBe(1);
                    expect(r2.start).toBeGreaterThan(r1.start);
                });
                await test.step('S5, S6, S8: nothing more for C3, C4, C5, C8', async () => {
                    expect(totalOf(t, 'c3', 'notCompliant'), 'C3 in total').toBe(1);
                    expect(totalOf(t, 'c4', 'notCompliant'), 'C4 in total').toBe(1);
                    expect(totalOf(t, 'c5', 'notCompliant'), 'C5 in total').toBe(1);
                    expect(totalOf(t, 'c8', 'notCompliant'), 'C8 in total').toBe(3);
                });
                await test.step('S9: R3 sends nothing for C6, which has exactly 2 expiring notifications', async () => {
                    expect(countIn(t, 'c6', 'expiring', r3.start), 'C6 at R3').toBe(0);
                    expect(totalOf(t, 'c6', 'expiring'), 'C6 in total').toBe(2);
                });
                await test.step('S10: C7 is notified at R3 as well, as at every run', async () => {
                    expect(countIn(t, 'c7', 'expiring', r3.start), 'C7 at R3').toBe(1);
                });
            } finally {
                const failures = await cleanupTimeline(api, prefixOf());
                expect(failures, 'the timeline objects are removed').toEqual([]);
            }
        });
    });
});

async function complianceProfileOf(api: APIRequestContext, prefix: string): Promise<string> {
    const profiles = (await call(api, 'get', '/v2/complianceProfiles')) as Array<{ uuid: string; name: string }>;
    const profile = profiles.find((p) => p.name === `${prefix}compliance`);
    if (!profile) throw new Error(`${ENVIRONMENT} compliance profile of the ${SEED} is not found`);
    return profile.uuid;
}
