/**
 * ownObjects — the own-object creators and ledger steps of one test, bound to that test's ledger id: creators for groups,
 * roles, users, RA profiles, custom attributes and certificates, plus `record`, `probe` and friends. Each writes the ledger line before
 * anything is asserted.
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

/** What `own.record` reads of a UI create: the answer of `submit…` plus the request body that carries the name. */
export interface RecordableAnswer extends UiCreateAnswer {
    body?: Record<string, unknown>;
}

export interface RecordOptions {
    name?: string;
    note?: string;
    parents?: LedgerLine['parents'];
}

function nameOfRequest(answer: { body?: Record<string, unknown> }): string | undefined {
    const body = answer.body ?? {};
    const name = typeof body.name === 'string' ? body.name : body.username;
    return typeof name === 'string' && name ? name : undefined;
}

/** What `own.probe` reads of an answer that was expected to be a refusal: an API answer (`json.uuid` of a 2xx) or a form answer (`uuid`). */
export interface ProbeAnswer {
    status: number;
    uuid?: string;
    json?: unknown;
    text?: string;
    serverAt?: Date;
    body?: Record<string, unknown>;
}

export interface ProbeOptions extends RecordOptions {}

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

const NO_NAME = '(no name)';

function creators(api: GuardedApi, spec: string, skip: Skip) {
    return {
        group: (suffix: string, options?: Parameters<typeof createOwnGroup>[3]) => createOwnGroup(api, spec, suffix, options),
        role: (suffix: string, options?: Parameters<typeof createOwnRole>[3]) => createOwnRole(api, spec, suffix, options),
        user: (suffix: string, options?: Parameters<typeof createOwnUser>[3]) => createOwnUser(api, spec, suffix, options),
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
    readonly spec: string;
    /**
     * The ledger line of an object a UI form created: call it right after `submit…`, before anything asserts. Throws when the platform
     * refused (an accepted duplicate is recorded first) or answered without an id.
     */
    record(type: RegisteredType, answer: RecordableAnswer, options?: RecordOptions): OwnRef;
    /** Records every certificate of this run-prefixed common name not yet on the ledger (a protocol or UI create whose answer has no uuid). */
    recordNamed(name: string, note: string): Promise<string[]>;
    deleted(type: RegisteredType, ref: OwnRef, note?: string): void;
    /**
     * The record step of a create expected to be REFUSED: an accepted one is an object this run made, so it is ledgered before the refusal
     * is asserted. Returns undefined when refused as expected; without a name it gets a placeholder without the run prefix (never deleted).
     */
    probe(type: RegisteredType, answer: ProbeAnswer, options?: ProbeOptions): OwnRef | undefined;
    /**
     * Records and proves live every object of `type` named exactly `name` that a refused create left behind; only a name with this run's id
     * prefix is adopted. Reads, then records: nothing is created.
     */
    adoptNamed(type: RegisteredType, name: string, options?: { note?: string; parents?: LedgerLine['parents'] }): Promise<OwnRef[]>;
    /** The dedicated second-identity user, own and recorded; a left-behind user that is not this run's skips the test. */
    restrictedUser(): Promise<OwnRef>;
    derivedKey(certificate: string | { uuid: string; createdAfter?: string }, createdAfter?: string): Promise<void>;
    /** Records every certificate of this run-prefixed common name made after `createdAfter`, and their keys. */
    issuedNamed(commonName: string, createdAfter: string | undefined, note: string): Promise<string[]>;
    acmeAccount(accountUrl: string, acmeProfile: OwnRef): Promise<OwnRef>;
    runAuthority(): string | undefined;
};

export function ownObjects(api: GuardedApi, spec: string, skip: Skip): OwnObjects {
    return {
        spec,
        ...creators(api, spec, skip),
        record(type, answer, options = {}) {
            const name = options.name ?? nameOfRequest(answer);
            if (!name) {
                // On the tier from the moment the platform answered: recorded
                // first under a placeholder without the run prefix (never deleted).
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
