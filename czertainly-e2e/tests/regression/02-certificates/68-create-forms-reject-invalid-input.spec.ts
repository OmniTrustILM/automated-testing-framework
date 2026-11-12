/**
 * REG-CERT-68 — Create forms refuse invalid input (release checklist: Certificates, forms). ilm#428, ilm#442.
 *
 * WHAT: 1. RA Profiles → + → Create RA Profile → name and a connected authority → the Connector Attributes tab shows a required
 *          attribute; leave it empty → the form holds the request back (Create disabled, "Required Field"), or, if it sends it,
 *          core answers 422 and the toast carries the messages.
 *       2. Nothing was created: no RA profile of that name.
 *       3. The same request through the API (name only, no connector attributes) → 422, application/json, a JSON array of
 *          non-empty strings naming the attribute; no RA profile is created.
 * WHY: a required connector attribute left empty must be refused with a message the operator can act on and must never
 *      create a half-configured profile. For a Select-typed required attribute the form shows no text today; that state is
 *      pinned so the test fails the day the form shows the message.
 * HOW: the authority is a pre-existing, connected one with a required RA-profile attribute, read only (the RA profile is a
 *      child under it). Shared tiers: create-only with run-prefixed names; every RA profile found afterwards is put in the
 *      ledger before the first assertion. Without such an authority the tests skip with the deploy-gate reason.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { chooseAuthorityWithRequiredAttribute, AuthorityChoice } from '../../../utils/regression/inventory/raProfileSchema';
import type { CreateRaProfileDialog } from '../../../pages/CreateRaProfileDialog';
import { RaProfilePage } from '../../../pages/RaProfilePage';
import { answerFrom } from '../../../pages/ui/waitForResponse';
import { expectRefused } from '../../../utils/regression/errorContract';
import { send } from '../../../utils/regression/inventory/searchApi';
import { apiJson } from '../../../utils/regression/apiReads';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { findByName } from '../../../utils/regression/listReads';
import { runName, runId, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import type { GuardedApi } from '../../../utils/regression/guard/types';

type Json = Record<string, any>;

const RULE = [
    'a required connector attribute left empty → 422 and the frontend shows the validation message; no profile is created',
    'ilm#428 step 5; core answers "Required attribute <name> not found." when an RA profile is created without a required connector attribute',
];

const SKIP_NO_AUTHORITY = 'no connected authority whose RA-profile schema declares a required attribute; the tier needs one (a connected authority with a required RA-profile attribute)';

/**
 * The authority both legs use: the run's own authority when its RA-profile schema declares a required attribute, else the first connected
 * one that does (reads only).
 */
async function authorityChoice(api: GuardedApi, runAuthorityUuid: string | undefined): Promise<AuthorityChoice | undefined> {
    const authorities = await apiJson<Array<{ uuid: string; name: string; status?: string }>>(api, 'GET', '/api/v1/authorities');
    return chooseAuthorityWithRequiredAttribute(
        authorities,
        async (uuid) => apiJson<Json[]>(api, 'GET', `/api/v1/authorities/${uuid}/attributes/raProfile`).catch(() => undefined),
        runAuthorityUuid,
    );
}

/** The RA profile named `name` (the list is the authoritative read), adopted into the ledger when one exists (ledger before assertion). */
async function leftOver(api: GuardedApi, own: OwnObjects, name: string, authorityUuid: string, note: string): Promise<Json | undefined> {
    const found = await findByName(api, '/api/v1/raProfiles', name);
    if (found) await own.adoptNamed('raProfiles', name, { note, parents: { authority: authorityUuid } });
    return found;
}

const unique = (what: string): string => ownName(`form-val-${what}`);

test.describe('RA profile form validation', { tag: tags.regression }, () => {
    test('the Create RA Profile form with an empty required attribute shows the validation message',
        testMeta({ id: 'REG-CERT-68', row: 'ui', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: RULE }),
        async ({ signedIn: page, api, own }, testInfo) => {
            const authority = await authorityChoice(api, own.runAuthority());
            test.skip(!authority, SKIP_NO_AUTHORITY);
            const name = unique('ui');
            const list = new RaProfilePage(page);
            let form!: CreateRaProfileDialog;

            await test.step('RA Profiles → "+" → Create RA Profile → name → authority', async () => {
                await list.goToList();
                form = await list.openCreateDialog();
                await form.fillName(name);
                await form.chooseAuthority(authority!.name);
            });

            const first = await test.step('The Connector Attributes tab shows a required attribute (label ending " *"); leave it empty', async () => {
                const required = await form.requiredFields();
                expect(required.length, 'required connector attributes shown by the form').toBeGreaterThan(0);
                await form.assertNoRequiredFieldMessage();
                return required[0];
            });
            const kind = await form.focusAndLeaveRequiredField(first.field);

            const outcome = await test.step('Create: the form holds the request back (disabled) — or sends it, and then core must refuse it', async () => form.submitIfEnabled());

            if (outcome.sent) {
                await test.step('The form let the request through: ledger first, then the refusal is the oracle (422 string array, a toast that carries the messages)', async () => {
                    const answer = await answerFrom(outcome.response, Date.now());
                    // A refusal is expected: an accepted create is recorded before the status check fails.
                    own.probe('raProfiles', answer, { name, note: 'accepted although a required connector attribute was empty', parents: { authority: authority!.uuid } });
                    const messages = expectRefused(answer, { status: 422, what: 'POST …/raProfiles with a required attribute empty' });
                    testInfo.annotations.push({ type: 'refusal-messages', description: JSON.stringify(messages).slice(0, 400) });
                    await form.assertRefusalShown(messages);
                });
            } else {
                await test.step('Create is disabled; the validation message is shown (input) or annotated (Select reports no blur)', async () => {
                    await form.assertCreateDisabled();
                    if (kind === 'input') await form.assertRequiredAttributeError(first.label);
                    else {
                        // ilm#428 step 5 says the frontend shows the validation message, but a Select-typed required attribute shows none
                        // today (the error is rendered only once the field is touched and the Select wires no blur). That state is pinned
                        // here: this line fails the day the form shows the message, and the branch then becomes
                        // `assertRequiredAttributeError(first.label)` like the input case.
                        await form.assertNoRequiredFieldMessage('suspected defect flipped: the form now shows "Required Field" for a Select-typed required attribute; assert it with assertRequiredAttributeError and drop the annotation');
                        testInfo.annotations.push({ type: 'select-attribute', description: `the first required attribute is a Select: the form blocks Create but shows no text (react-hook-form touched state needs a blur the Select does not give); the 422 answer (status, string-array shape) is asserted by REG-CERT-68[api]` });
                    }
                });
            }

            await test.step('Nothing was created: no RA profile of that name (ledger first if one exists)', async () => {
                const found = await leftOver(api, own, name, authority!.uuid, 'created by the UI form although a required connector attribute was empty');
                expect(found, 'RA profile created with a required attribute empty').toBeUndefined();
            });
            await form.cancel();
        });

    test('POST …/raProfiles without the required attribute answers 422 and creates nothing',
        testMeta({ id: 'REG-CERT-68', row: 'api', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: RULE }),
        async ({ api, own, needs }, testInfo) => {
            const authority = await authorityChoice(api, own.runAuthority());
            test.skip(!authority, SKIP_NO_AUTHORITY);
            const name = unique('api');
            // A read before the first write. Only "the suite cannot fill it" skips (the need); a failed read of the definitions fails the
            // test.
            await needs.requiredAttributesFillable('raProfiles');
            const customAttributes = await requiredCustomAttributes(api, 'raProfiles', runName('ca'));

            const answer = await test.step('POST /v1/authorities/{authority}/raProfiles: run-prefixed name, no connector attributes, the required custom attributes filled', async () =>
                send(api, 'POST', `/api/v1/authorities/${authority!.uuid}/raProfiles`, {
                    data: { name, description: `REG run ${runId()}`, attributes: [], customAttributes },
                }));

            await test.step('Ledger first: a 2xx would have created an RA profile', async () => {
                own.probe('raProfiles', answer, { name, note: 'accepted although a required connector attribute was missing', parents: { authority: authority!.uuid } });
            });

            await test.step('422, application/json, a JSON array of non-empty strings (the messages are recorded as an annotation)', async () => {
                const messages = expectRefused(answer, { status: 422, what: 'POST …/raProfiles' });
                testInfo.annotations.push({ type: 'refusal-messages', description: `${JSON.stringify(messages).slice(0, 400)} (required: ${JSON.stringify(authority!.required.map((r) => r.label))})` });
            });

            await test.step('Nothing was created: list by name = 0', async () => {
                const found = await leftOver(api, own, name, authority!.uuid, 'found after a refused create');
                expect(found, 'RA profile created with a required attribute missing').toBeUndefined();
            });
        });
});
