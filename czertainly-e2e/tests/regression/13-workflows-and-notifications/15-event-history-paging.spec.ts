/**
 * REG-WFL-15 — Event History paging over more than one page of firings. ilm#438.
 *
 * WHAT: 1. Associate one own trigger on `Certificate registered` of an own RA profile and pre-register 31 placeholder certificates with a
 *          challenge → 31 firings with one object each, all finished (polled), none Failed.
 *       2. For the page sizes 1, 10, 31, 32 and 50: every page holds at most the page size (a full page unless it is the last), the total
 *          does not depend on the size, firings are distinct across pages, the pages add up to 31, the order is newest first, and a page
 *          beyond the last is empty with status 200.
 *       3. The objects inside a firing default to a page of 10 and respect it.
 * WHY: a page size that is ignored returns the whole history (the Hibernate 7.4 risk of HHH-20943 and HHH-20911); firings must page
 *      like any other list.
 * HOW: the oracle is the number of placeholders this test created, never a baseline. The gates are reads before the first write (the `ca`
 *      need, no platform-level trigger on the event, registration settings that allow a challenge); a register refused after that fails the
 *      test. Own objects only, recorded before any assertion; the firings are asynchronous, so reads poll.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { registerPlaceholder } from '../../../utils/regression/events/workflowFixtures';
import { associateTriggers } from '../../../utils/regression/events/eventAssociations';
import { Firing, getFirings, waitForFinishedFirings } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { testMeta, tags } from '../../../utils/regression/tags';
import { EVENT_DELIVERY_MS, FIRINGS_FINISHED_WAIT_MS } from '../../../utils/regression/timeouts';

const FIRINGS = 31;

test.describe('Event History paging', { tag: tags.regression }, () => {
    test(`${FIRINGS} firings page distinctly at page sizes 1, 10, 31, 32 and 50 and add up to the number created`,
        testMeta({
            id: 'REG-WFL-15', prio: 'P2', issue: 'ilm#438', needs: ['ca', 'registration-settings'],
            rule: [
                'firings newest first; `pagination` for firings, `objectsPagination` for objects; counts per firing',
                'ilm#438 steps 19–20, 22; Hibernate 7.4 HHH-20943 / HHH-20911 (a page size ignored returns the whole history)',
            ],
        }),
        async ({ api, own, needs }) => {
            test.setTimeout(EVENT_DELIVERY_MS);
            await needs.platformTriggersFree(EVENT.registered);
            const ra = await own.raProfile('wf15-ra');
            const attr = await own.customAttribute('wf15-mark', { resources: ['certificates'] });
            const chain = await createOwnChain(api, own.spec, 'wf15', { event: EVENT.registered, executionItems: [setCustomAttributeAction(attr.attributeName, 'STRING', 'fired')] });
            const sent = await associateTriggers(api, own.spec, { event: EVENT.registered, resource: 'raProfiles', object: ra, triggers: [chain.trigger] });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            const scope = { resource: 'raProfiles' as const, objectUuid: ra.uuid };

            await test.step(`Register ${FIRINGS} placeholders (one firing each)`, async () => {
                for (let i = 0; i < FIRINGS; i++) {
                    const r = await registerPlaceholder(api, own.spec, ra, `wf15-p${i}`);
                    expect(r.ref, `pre-registration ${i} was refused: ${r.status} ${r.text.slice(0, 300)}`).toBeTruthy();
                }
            });

            await test.step(`All ${FIRINGS} firings finished (asynchronous: polled), none Failed`, async () => {
                const page = await waitForFinishedFirings(api, { event: EVENT.registered, scope, pageSize: 50 }, FIRINGS, { timeoutMs: FIRINGS_FINISHED_WAIT_MS });
                expect(page.totalItems, 'every placeholder fired once in the scope').toBe(FIRINGS);
            });

            for (const pageSize of [1, 10, 31, 32, 50]) {
                await test.step(`Page size ${pageSize}: every page ≤ ${pageSize}, distinct firings, Σ items = ${FIRINGS}, newest first, none Failed`, async () => {
                    const pages = Math.ceil(FIRINGS / pageSize);
                    const seen: Firing[] = [];
                    for (let page = 1; page <= pages; page++) {
                        const r = await getFirings(api, { event: EVENT.registered, scope, page, pageSize });
                        expect(r.status, `page ${page} of size ${pageSize}: ${r.text.slice(0, 200)}`).toBe(200);
                        const got = r.page!;
                        expect(got.totalItems, 'the total does not depend on the page size').toBe(FIRINGS);
                        expect(got.items.length, `page ${page} holds at most ${pageSize} firings (a page size that is ignored returns everything)`).toBeLessThanOrEqual(pageSize);
                        if (page < pages) expect(got.items.length, `a full page ${page}`).toBe(pageSize);
                        for (const f of got.items) expect(f.objectHistories.items.length, 'objectsPagination defaults to 10 and is respected').toBeLessThanOrEqual(10);
                        seen.push(...got.items);
                    }
                    const ids = seen.map((f) => String(f.objectHistories.items[0]?.objectUuid ?? `${f.startedAt}`));
                    expect(new Set(ids).size, 'no firing repeats across pages (one placeholder per firing)').toBe(FIRINGS);
                    expect(seen, 'the pages add up to every firing').toHaveLength(FIRINGS);
                    expect(seen.reduce((n, f) => n + f.objectsEvaluated, 0), 'Σ objectsEvaluated = number of placeholders').toBe(FIRINGS);
                    expect(seen.every((f) => f.status === 'finished'), 'no firing Failed or still in progress').toBe(true);
                    const starts = seen.map((f) => Date.parse(f.startedAt));
                    expect(starts, 'newest first').toEqual([...starts].sort((a, b) => b - a));
                    const beyond = await getFirings(api, { event: EVENT.registered, scope, page: pages + 1, pageSize });
                    expect(beyond.status, 'a page beyond the last is not an error').toBe(200);
                    expect(beyond.page?.items, 'a page beyond the last is empty').toEqual([]);
                });
            }
        });
});
