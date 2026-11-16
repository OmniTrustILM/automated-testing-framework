/**
 * REG-CERT-68 — the Create RA Profile form refuses an empty required connector attribute and creates nothing (ilm#428, ilm#442).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { chooseAuthorityWithRequiredAttribute, AuthorityChoice } from '../../../utils/regression/inventory/raProfileSchema';
import type { CreateRaProfileDialog, SubmitOutcome } from '../../../pages/CreateRaProfileDialog';
import { RaProfilePage } from '../../../pages/RaProfilePage';
import { answerFrom } from '../../../pages/ui/waitForResponse';
import { expectRefused } from '../../../utils/regression/errorContract';
import { apiJson } from '../../../utils/regression/apiReads';
import { findByName } from '../../../utils/regression/listReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import type { GuardedApi } from '../../../utils/regression/guard/types';

type Json = Record<string, any>;

const RULE = [
    'a required connector attribute left empty → 422 and the frontend shows the validation message; no profile is created',
    'ilm#428 step 5; core answers "Required attribute <name> not found." when an RA profile is created without a required connector attribute',
];

const SKIP_NO_AUTHORITY = 'no connected authority whose RA-profile schema declares a required attribute; the tier needs one (a connected authority with a required RA-profile attribute)';

/** The run's own authority when its RA-profile schema declares a required attribute, else the first connected one that does (reads only). */
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

            const required = await test.step('The Connector Attributes tab shows a required attribute (label ending " *")', async () => {
                const fields = await form.requiredFields();
                expect(fields.length, 'required connector attributes shown by the form').toBeGreaterThan(0);
                await form.assertNoRequiredFieldMessage();
                return fields;
            });
            const input = await test.step('Focus the first required input and leave it empty (a Select gives no blur)', async () => {
                for (const f of required) if ((await form.focusAndLeaveRequiredField(f.field)) === 'input') return f;
                return undefined;
            });

            let outcome: SubmitOutcome | undefined;
            try {
                outcome = await test.step('Create: the form holds the request back (disabled) — or sends it, and then core must refuse it', async () => form.submitIfEnabled());
            } finally {
                // A click without an answer may still have created the profile: it is recorded before the failure is raised.
                if (!outcome) await leftOver(api, own, name, authority!.uuid, 'the Create click got no answer; core may have created it');
            }

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
                await test.step('Create is disabled; the required attribute shows the validation message', async () => {
                    await form.assertCreateDisabled();
                    // Product behaviour, no frontend issue yet: a Select is never touched (no blur), so its "Required Field" never shows.
                    test.fail(!input, 'the form shows no "Required Field" for a Select-typed required attribute');
                    await form.assertRequiredAttributeError((input ?? required[0]).label);
                });
            }

            await test.step('Nothing was created: no RA profile of that name (ledger first if one exists)', async () => {
                const found = await leftOver(api, own, name, authority!.uuid, 'created by the UI form although a required connector attribute was empty');
                expect(found, 'RA profile created with a required attribute empty').toBeUndefined();
            });
            await form.cancel();
        });
});
