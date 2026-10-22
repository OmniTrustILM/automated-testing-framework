/**
 * ownObjects — the own-object creators and the ledger steps of one test, bound to that test's ledger id.
 *
 * WHAT: `ownObjects(api, spec, skip)` returns what a spec needs to make and record objects of its run: `own.group(suffix, options)`,
 * `own.role`, `own.user`, `own.raProfile`, `own.customAttribute` and `own.certificate.*` delegate to the `createOwn<Thing>`
 * helpers (create through the guard, ledger line written from the answer before anything is asserted); `own.record(type, answer)`
 * writes the ledger line of an object a UI form created, from the form's answer, before the page waits for a redirect;
 * `own.recordNamed(name, note)` is the by-name record of a create whose answer carries no uuid (a protocol or a UI flow that
 * made a certificate); `own.deleted(type, ref)` writes the `deleted` line of an own object the test itself removed.
 * WHY: the ledger `spec` of a line is the record of who made what, and it used to be a `const SPEC` that a spec could
 * let drift from its `testMeta` id; the record steps were typed by hand after every submit (a forgotten `if (answer.uuid)` is an
 * object on a shared tier that the teardown cannot name). Here the spec id is bound once and the record step is one call.
 * HOW: built by the `own` fixture of fixtures/regressionFixtures.ts with the test's `api` and `ledgerSpecOf(testInfo)`; a unit
 * test builds it directly. `skip` is `testInfo.skip` with `true` filled in: a creator that cannot make its object because the tier
 * has no CA skips the test with the helper's named reason. A new creator is one entry of `creators`.
 */
import type { GuardedApi } from './guard/types';
import { recordCertificatesNamed } from './issuedRecords';
import { OwnRef, recordDeleted, LedgerLine } from './ledger/ledger';
import { recordIfCreated, recordUiCreate, type UiCreateAnswer } from './ledger/uiCreates';
import { createOwnCustomAttribute } from './customAttributes';
import { issueOwnCertificate, uploadOwnCertificate, uploadOwnSelfSigned } from './ownCertificates';
import { createOwnGroup } from './ownGroups';
import { createOwnRaProfile, orSkipWithoutCa } from './ownRaProfiles';
import { createOwnRole } from './ownRoles';
import { createOwnUser } from './ownUsers';
import type { RegisteredType } from './resourceTypes';

/** What `own.record` reads of a UI create: the answer of `submit…` (a page object's `CreateAnswer` fits), with the request body that carries the name. */
export interface RecordableAnswer extends UiCreateAnswer {
    /** The JSON body of the create request; its `name` (a user's `username`) is the object's name unless `name` is given. */
    body?: Record<string, unknown>;
}

export interface RecordOptions {
    /** The object's name when the request body does not carry it. */
    name?: string;
    /** Why the object exists (a short note on the ledger line). */
    note?: string;
    /** The objects a later change or delete needs (`authority`, `raProfile`, a predecessor, …). */
    parents?: LedgerLine['parents'];
}

/** The name a create request gave its object: `name`, or `username` for a user. */
function nameOfRequest(answer: RecordableAnswer): string | undefined {
    const body = answer.body ?? {};
    const name = typeof body.name === 'string' ? body.name : body.username;
    return typeof name === 'string' && name ? name : undefined;
}

type Skip = (reason: string) => void;

/** The ledger name of an object whose request carried no name (no run prefix: reported by the teardown, never deleted). */
const NO_NAME = '(no name)';

/** The creators every test may use, bound to `(api, spec)`; each keeps the signature of its helper without `api` and `spec`. */
function creators(api: GuardedApi, spec: string, skip: Skip) {
    return {
        group: (suffix: string, options?: Parameters<typeof createOwnGroup>[3]) => createOwnGroup(api, spec, suffix, options),
        role: (suffix: string, options?: Parameters<typeof createOwnRole>[3]) => createOwnRole(api, spec, suffix, options),
        user: (suffix: string, options?: Parameters<typeof createOwnUser>[3]) => createOwnUser(api, spec, suffix, options),
        /** A new own RA profile on the first healthy CA, enabled; a tier without a CA skips the test with the named reason. */
        raProfile: (suffix: string) => orSkipWithoutCa(createOwnRaProfile(api, spec, suffix), skip),
        customAttribute: (suffix: string, options?: Parameters<typeof createOwnCustomAttribute>[3]) => createOwnCustomAttribute(api, spec, suffix, options),
        certificate: {
            issue: (ra: Parameters<typeof issueOwnCertificate>[1], options?: Parameters<typeof issueOwnCertificate>[3]) => issueOwnCertificate(api, ra, spec, options),
            upload: (pem: string, name: string, note?: string) => uploadOwnCertificate(api, pem, name, spec, note),
            uploadSelfSigned: (suffix?: string) => uploadOwnSelfSigned(api, spec, suffix),
        },
    };
}

export type OwnObjects = ReturnType<typeof creators> & {
    /** The ledger id every line of this test carries (`testMeta({ id })`, else the file name). */
    readonly spec: string;
    /**
     * The ledger line of an object a UI form created, written from the form's answer: call it right after the page object's `submit…`
     * and before anything waits for the redirect or asserts. Returns the own reference; throws when the platform refused (an accepted
     * duplicate is recorded first) or answered without an id.
     */
    record(type: RegisteredType, answer: RecordableAnswer, options?: RecordOptions): OwnRef;
    /** Records every certificate of this run-prefixed common name that is not on the ledger yet (a protocol or UI create whose answer has no uuid). */
    recordNamed(name: string, note: string): Promise<string[]>;
    /** The `deleted` line of an own object the test removed itself (the platform accepted the delete). */
    deleted(type: RegisteredType, ref: OwnRef, note?: string): void;
};

/** The own-object creators and ledger steps of one test (see the module header). */
export function ownObjects(api: GuardedApi, spec: string, skip: Skip): OwnObjects {
    return {
        spec,
        ...creators(api, spec, skip),
        record(type, answer, options = {}) {
            const name = options.name ?? nameOfRequest(answer);
            if (!name) {
                // The object is on the tier from the moment the platform answered: record it first, under a placeholder that carries no run
                // prefix (the teardown reports such a line and never deletes it), then tell the author to pass the name.
                recordIfCreated(type, answer, NO_NAME, spec, options.note, options.parents);
                throw new Error(`own.record(${type}): the create request carries no name; pass { name } so the ledger line can name the object (recorded as ${NO_NAME} when the answer had an id)`);
            }
            return recordUiCreate(type, answer, name, spec, options.note, options.parents);
        },
        recordNamed: (name, note) => recordCertificatesNamed(api, name, spec, note),
        deleted: (type, ref, note) => recordDeleted(type, ref, spec, note),
    };
}
