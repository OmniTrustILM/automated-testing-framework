/**
 * ownObjects — the own-object creators and the ledger steps of one test, bound to that test's ledger id.
 *
 * WHAT: `ownObjects(api, spec, skip)` returns what a spec needs to make and record objects of its run: `own.group(suffix, options)`,
 * `own.role`, `own.user`, `own.raProfile`, `own.customAttribute` and `own.certificate.*` delegate to the `createOwn<Thing>`
 * helpers (create through the guard, ledger line written from the answer before anything is asserted); `own.record(type, answer)`
 * writes the ledger line of an object a UI form created, from the form's answer, before the page waits for a redirect;
 * `own.recordNamed(name, note)` is the by-name record of a create whose answer carries no uuid (a protocol or a UI flow that
 * made a certificate); `own.deleted(type, ref)` writes the `deleted` line of an own object the test itself removed.
 * `own.probe(type, answer, …)` records a create that was expected to be refused but was accepted; `own.adoptNamed(type, name)`
 * records and live-proves the row a refused create left behind (a run-prefixed name only); `own.restrictedUser()` makes the
 * dedicated second-identity user (a left-behind one skips the test); `own.derivedKey`, `own.issuedNamed` and `own.acmeAccount`
 * record what a certificate issue or an ACME client made besides the certificate; `own.runAuthority()` is the run's own authority.
 * WHY: the ledger `spec` of a line is the record of who made what, and it used to be a `const SPEC` that a spec could
 * let drift from its `testMeta` id; the record steps were typed by hand after every submit (a forgotten `if (answer.uuid)` is an
 * object on a shared tier that the teardown cannot name). Here the spec id is bound once and the record step is one call.
 * HOW: built by the `own` fixture of fixtures/regressionFixtures.ts with the test's `api` and `ledgerSpecOf(testInfo)`; a unit
 * test builds it directly. `skip` is `testInfo.skip` with `true` filled in: a creator that cannot make its object because the tier
 * has no CA skips the test with the helper's named reason. A new creator is one entry of `creators`.
 */
import type { GuardedApi } from './guard/types';
import { recordAcmeAccount, recordCertificatesNamed, recordDerivedKeyOf, recordIssuedNamed } from './issuedRecords';
import { OwnRef, recordCreated, recordDeleted, LedgerLine } from './ledger/ledger';
import { LiveOwn } from './ledger/liveOwn';
import { checkOwnership } from './ledger/ownership';
import { readRunState, runId } from './ledger/runState';
import { lookupInList, recordIfCreated, recordUiCreate, type UiCreateAnswer } from './ledger/uiCreates';
import { createdUuid } from './ownCrud';
import { restrictedIdentity } from './rbac/identities';
import { ensureRestrictedUser, RestrictedUserNotOwn } from './rbac/permissionObjects';
import { createOwnCustomAttribute } from './customAttributes';
import { issueOwnCertificate, uploadOwnCertificate, uploadOwnSelfSigned } from './ownCertificates';
import { createOwnGroup } from './ownGroups';
import { createOwnRaProfile, orSkipWithoutCa } from './ownRaProfiles';
import { createOwnRole } from './ownRoles';
import { createOwnUser } from './ownUsers';
import type { RegisteredType } from './resourceTypes';

/**
 * What `own.record` reads of a UI create: the answer of `submit…` (a page object's `CreateAnswer` fits), with the request body that carries
 * the name.
 */
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
function nameOfRequest(answer: { body?: Record<string, unknown> }): string | undefined {
    const body = answer.body ?? {};
    const name = typeof body.name === 'string' ? body.name : body.username;
    return typeof name === 'string' && name ? name : undefined;
}

/**
 * What `own.probe` reads of an answer that was expected to be a refusal: an API answer (`json.uuid` of a 2xx) or a form answer (`uuid`).
 */
export interface ProbeAnswer {
    status: number;
    /** A form answer's uuid (recorded whatever the status says). */
    uuid?: string;
    /** An API answer's body: a 2xx with a canonical `uuid` is an accepted create. */
    json?: unknown;
    text?: string;
    /** The server clock of the answer (the Date header), kept on the ledger line. */
    serverAt?: Date;
    /** The JSON body of the request; its `name` (a user's `username`) is the object's name unless `name` is given. */
    body?: Record<string, unknown>;
}

export interface ProbeOptions extends RecordOptions {}

/** The ledger types `own.adoptNamed` can look a name up in, with the list URL and the member that carries the name. */
const ADOPTABLE: Readonly<Record<string, { list: string; key?: string }>> = {
    groups: { list: '/api/v1/groups' },
    roles: { list: '/api/v1/roles' },
    users: { list: '/api/v1/users', key: 'username' },
    credentials: { list: '/api/v1/credentials' },
    authorities: { list: '/api/v1/authorities' },
    raProfiles: { list: '/api/v1/raProfiles' },
    acmeProfiles: { list: '/api/v1/acmeProfiles' },
    scepProfiles: { list: '/api/v1/scepProfiles' },
    cmpProfiles: { list: '/api/v1/cmpProfiles' },
    tokens: { list: '/api/v1/tokens' },
    tokenProfiles: { list: '/api/v1/tokenProfiles' },
};

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
    /**
     * Records every certificate of this run-prefixed common name that is not on the ledger yet (a protocol or UI create whose answer has no
     * uuid).
     */
    recordNamed(name: string, note: string): Promise<string[]>;
    /** The `deleted` line of an own object the test removed itself (the platform accepted the delete). */
    deleted(type: RegisteredType, ref: OwnRef, note?: string): void;
    /**
     * The record step of a create that was expected to be REFUSED: an accepted one (a 2xx with a uuid, or a form answer that names one) is
     * an object this run made, so it goes on the ledger before the test asserts the refusal. Returns the reference, or undefined when the
     * platform refused as expected. Never throws on a status; an object already on the ledger is not recorded twice. The name is
     * `options.name`, else the request body's, else a placeholder without the run prefix (the teardown reports it and never deletes it).
     */
    probe(type: RegisteredType, answer: ProbeAnswer, options?: ProbeOptions): OwnRef | undefined;
    /**
     * The rows a refused create left behind: every object of `type` whose exact name is `name` is recorded and then proven live
     * (`LiveOwn.prove`: a ledger line of this run and a live name with the run prefix). Only a name that starts with this run's id is
     * adopted; any other name is refused before a read. A name already on the ledger is returned as it is. Reads, then records: nothing is
     * created. A type without a list URL here is an error.
     */
    adoptNamed(type: RegisteredType, name: string, options?: { note?: string; parents?: LedgerLine['parents'] }): Promise<OwnRef[]>;
    /**
     * The dedicated second-identity user (REG_RESTRICTED_USERNAME), own and recorded; a left-behind user that is not this run's skips
     * the test with the named reason. The login of that identity is still read with `restrictedIdentity()`.
     */
    restrictedUser(): Promise<OwnRef>;
    /** Records the key the platform linked to a certificate this run made (a derived line with the server-clock bound `createdAfter`). */
    derivedKey(certificate: string | { uuid: string; createdAfter?: string }, createdAfter?: string): Promise<void>;
    /**
     * Records every certificate of this run-prefixed common name made after `createdAfter`, and their keys (a protocol or a UI flow made
     * them).
     */
    issuedNamed(commonName: string, createdAfter: string | undefined, note: string): Promise<string[]>;
    /** Records the ACME account an ACME client registered (`accountUrl` from the new-account answer) under its ACME profile. */
    acmeAccount(accountUrl: string, acmeProfile: OwnRef): Promise<OwnRef>;
    /** The uuid of the run's own authority (the run state's, when the run made it), or undefined: an issue-only authority is not own. */
    runAuthority(): string | undefined;
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
        probe(type, answer, options = {}) {
            const uuid = answer.uuid ?? createdUuid({ status: answer.status, json: answer.json } as Parameters<typeof createdUuid>[0]);
            if (!uuid) return undefined;
            const name = options.name ?? nameOfRequest(answer) ?? NO_NAME;
            if (checkOwnership({ uuid }).own) return { uuid, name, kind: 'own' };
            const note = options.note ?? `a create that was expected to be refused was accepted (${answer.status})`;
            return recordCreated(type, { uuid, name }, { spec, note, ...(options.parents ? { parents: options.parents } : {}), ...(answer.serverAt ? { serverAt: answer.serverAt } : {}) });
        },
        async adoptNamed(type, name, options = {}) {
            if (!name.startsWith(`${runId()}-`) && !name.startsWith(`${runId()}.`)) throw new Error(`own.adoptNamed(${type}): the name does not start with this run's id, so it is never adopted`);
            const where = ADOPTABLE[type];
            if (!where) throw new Error(`own.adoptNamed: no list URL is known for the type ${type}`);
            const { rows } = await lookupInList(api, where.list, where.key ?? 'name')(name);
            const refs: OwnRef[] = [];
            for (const row of rows) {
                const ref = checkOwnership({ uuid: row.uuid }).own
                    ? ({ uuid: row.uuid, name, kind: 'own' } as OwnRef)
                    : recordCreated(type, { uuid: row.uuid, name }, { spec, note: options.note ?? `${type} a refused create left behind (found by name)`, ...(options.parents ? { parents: options.parents } : {}) });
                // Recorded first (it is on the tier), then proven: the live name must carry the run prefix too.
                await LiveOwn.prove(api, type, ref, 'own.adoptNamed');
                refs.push(ref);
            }
            return refs;
        },
        async restrictedUser() {
            const identity = restrictedIdentity();
            if (!identity) throw new Error('own.restrictedUser: no second identity is configured (REG_RESTRICTED_USERNAME / REG_RESTRICTED_PASSWORD); declare the second-identity need');
            try {
                return await ensureRestrictedUser(api, spec, identity);
            } catch (e) {
                if (e instanceof RestrictedUserNotOwn) skip(e.message);
                throw e;
            }
        },
        derivedKey: (certificate, createdAfter) =>
            typeof certificate === 'string' ? recordDerivedKeyOf(api, certificate, createdAfter, spec) : recordDerivedKeyOf(api, certificate.uuid, createdAfter ?? certificate.createdAfter, spec),
        issuedNamed: (commonName, createdAfter, note) => recordIssuedNamed(api, commonName, createdAfter, spec, note),
        acmeAccount: (accountUrl, acmeProfile) => recordAcmeAccount(api, accountUrl, acmeProfile, spec),
        runAuthority() {
            const authority = readRunState().authority;
            return authority?.kind === 'own' ? authority.uuid : undefined;
        },
    };
}
