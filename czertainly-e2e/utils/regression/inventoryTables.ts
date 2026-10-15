/**
 * inventoryTables — the expected row sets of the inventory filter rows over SEED-A, and the sort comparators (inventory-api
 * plan §2.2 "Filter matrix executed by the tests": T-*, D-*, L-*, G-*, O-*, A-*; "Sort oracles (Cmp)").
 *
 * Double entry, on purpose: every row has `expect` (COMPUTED from the seed plan by a predicate that states the rule in code)
 * and `plan` (the set the plan document writes down). tests/unit/inventory-core.spec.ts asserts `expect` = `plan` on a
 * manifest built from the plan alone, so a mistake in the plan or in the predicate shows up offline, before a tier is
 * involved. The tests then compare the engine's answer with `expect` (ids → uuids through the manifest).
 *
 * The row sets are the REFERENCE MODEL of the rules (rules §2.2 / §2.3), not "what the engine returns today": a row whose
 * engine behaviour is a known bug carries `bug`, a row with no written rule carries `pin`.
 */
import type { Filter } from './inventoryApi';
import { prop, custom } from './inventoryApi';
import type { CertId, SeedAPlan, SeedACert } from './inventorySeedFull';
import { idsWhere } from './inventorySeedFull';

export interface FilterRow {
    /** Plan row id, e.g. `T-8`. */
    row: string;
    title: string;
    /** The filters of the row (the isolation filter is added by the caller unless `carriesIsolation`). */
    filters: (m: SeedAPlan, ctx: RowContext) => Filter[];
    /** Expected seeds, computed by the rule's predicate. */
    expect: (m: SeedAPlan) => CertId[];
    /** The set the plan writes down (ids, or a count when the plan gives only a count). */
    plan: CertId[] | number;
    /** The row's own filters already narrow to the seed prefix (T-3, T-7, T-9, T-12…): the isolation filter is still sent, harmless. */
    carriesIsolation?: boolean;
    /** Expected refusal: 422 and the text (RegExp or exact). Then `expect` / `plan` are empty. */
    refusal?: { status: 422 | 400; text: RegExp };
    /** Known product bug the row's rule contradicts today: the test is `test.fail()` with this `@bug`. */
    bug?: string;
    /** Characterisation pin (no written rule): the question id; the pinned test is never P1. */
    pin?: string;
    /** `includeArchived` to send. */
    includeArchived?: boolean;
}

/** Catalogue-derived values some rows need (the signature algorithm codes, the RSA public-key code). */
export interface RowContext {
    signatureSha384?: string;
    signatureSha512?: string;
    rsa?: string;
}

const ids = (...list: CertId[]): CertId[] => list;
const range = (from: number, to: number): CertId[] => Array.from({ length: to - from + 1 }, (_, i) => `C${String(from + i).padStart(2, '0')}` as CertId);
const ALL = (m: SeedAPlan): CertId[] => m.certificates.map((c) => c.id);
const not = (m: SeedAPlan, set: readonly CertId[]): CertId[] => ALL(m).filter((id) => !set.includes(id));
const P = (m: SeedAPlan, token: string): string => `${m.prefix}${token}`;
const t = (c: SeedACert): string => c.commonName;

/** The notAfter of a seed (the `T(Cnn)` of the plan), as the filter literal `yyyy-MM-ddTHH:mm:ss.SSSZ`. */
export const notAfterOf = (m: SeedAPlan, id: CertId): string => new Date(m.certificates.find((c) => c.id === id)!.notAfter).toISOString();
export const notBeforeOf = (m: SeedAPlan, id: CertId): string => new Date(m.certificates.find((c) => c.id === id)!.notBefore).toISOString();

// ------------------------------------------------------------------ Text — COMMON_NAME (REG-CERT-41, API-CERT-41)

const cn = (condition: string, value: (m: SeedAPlan) => string | undefined): FilterRow['filters'] => (m) => [prop('COMMON_NAME', condition, value(m))];
const containsToken = (m: SeedAPlan, word: string): CertId[] => idsWhere(m, (c) => c.token.includes(word));

export const TEXT_ROWS: readonly FilterRow[] = [
    { row: 'T-1', title: 'CONTAINS web', filters: cn('CONTAINS', () => 'web'), expect: (m) => containsToken(m, 'web'), plan: ids('C01', 'C03', 'C06', 'C07') },
    { row: 'T-2', title: 'NOT_CONTAINS web', filters: cn('NOT_CONTAINS', () => 'web'), expect: (m) => idsWhere(m, (c) => !c.token.includes('web')), plan: 20 },
    { row: 'T-3', title: 'EQUALS <P>gamma-db', filters: cn('EQUALS', (m) => P(m, 'gamma-db')), expect: (m) => idsWhere(m, (c) => t(c) === P(m, 'gamma-db')), plan: ids('C05'), carriesIsolation: true },
    { row: 'T-4', title: 'NOT_EQUALS <P>gamma-db', filters: cn('NOT_EQUALS', (m) => P(m, 'gamma-db')), expect: (m) => idsWhere(m, (c) => t(c) !== P(m, 'gamma-db')), plan: 23 },
    { row: 'T-5', title: 'EMPTY', filters: cn('EMPTY', () => undefined), expect: () => [], plan: 0 },
    { row: 'T-6', title: 'NOT_EMPTY', filters: cn('NOT_EMPTY', () => undefined), expect: ALL, plan: 24 },
    { row: 'T-7', title: 'STARTS_WITH <P>alpha', filters: cn('STARTS_WITH', (m) => P(m, 'alpha')), expect: (m) => idsWhere(m, (c) => t(c).startsWith(P(m, 'alpha'))), plan: ids('C01', 'C02'), carriesIsolation: true },
    { row: 'T-8', title: 'ENDS_WITH -web', filters: cn('ENDS_WITH', () => '-web'), expect: (m) => idsWhere(m, (c) => t(c).endsWith('-web')), plan: ids('C01', 'C03', 'C06', 'C07') },
    { row: 'T-9', title: 'MATCHES ^<P>(alpha|beta)-', filters: cn('MATCHES', (m) => `^${P(m, '')}(alpha|beta)-`), expect: (m) => idsWhere(m, (c) => new RegExp(`^${P(m, '')}(alpha|beta)-`).test(t(c))), plan: ids('C01', 'C02', 'C03', 'C04'), carriesIsolation: true },
    { row: 'T-10', title: 'NOT_MATCHES -web$', filters: cn('NOT_MATCHES', () => '-web$'), expect: (m) => idsWhere(m, (c) => !/-web$/.test(t(c))), plan: 20 },
    { row: 'T-11', title: 'CONTAINS delta (case-sensitive; core#712 open)', filters: cn('CONTAINS', () => 'delta'), expect: (m) => idsWhere(m, (c) => t(c).includes('delta')), plan: ids('C08'), pin: 'core712' },
    { row: 'T-12', title: 'CONTAINS Delta (case-sensitive; core#712 open)', filters: cn('CONTAINS', () => 'Delta'), expect: (m) => idsWhere(m, (c) => t(c).includes('Delta')), plan: ids('C07'), pin: 'core712' },
    // The rule is a literal match (rules §2.2 r15 notes the wildcard trait as the open bug core#2505): C09 only / none.
    { row: 'T-13', title: 'CONTAINS _ (literal match expected)', filters: cn('CONTAINS', () => '_'), expect: (m) => idsWhere(m, (c) => t(c).includes('_')), plan: ids('C09'), bug: 'core#2505' },
    { row: 'T-14', title: 'CONTAINS % (literal match expected)', filters: cn('CONTAINS', () => '%'), expect: (m) => idsWhere(m, (c) => t(c).includes('%')), plan: 0, bug: 'core#2505' },
];

// ------------------------------------------------------------------ Date and datetime — NOT_AFTER / NOT_BEFORE (REG-CERT-42, API-CERT-42)

const na = (condition: string, id: CertId | ((m: SeedAPlan) => string) | undefined): FilterRow['filters'] => (m) =>
    [prop('NOT_AFTER', condition, id === undefined ? undefined : typeof id === 'function' ? id(m) : notAfterOf(m, id))];
const naTime = (m: SeedAPlan, id: CertId): number => new Date(m.certificates.find((c) => c.id === id)!.notAfter).getTime();
/** Seeds whose notAfter is within `days` of the clock (in the future), the IN_NEXT window. */
const inNext = (m: SeedAPlan, days: number): CertId[] => {
    const now = new Date(m.clock).getTime();
    return idsWhere(m, (c) => new Date(c.notAfter).getTime() >= now && new Date(c.notAfter).getTime() <= now + days * 24 * 3600 * 1000);
};
const inPast = (m: SeedAPlan, days: number): CertId[] => {
    const now = new Date(m.clock).getTime();
    return idsWhere(m, (c) => new Date(c.notAfter).getTime() <= now && new Date(c.notAfter).getTime() >= now - days * 24 * 3600 * 1000);
};
/** The wall digits of T(C03) with another offset (accepted and dropped today: `@pin:Q4`). */
const withOffset = (m: SeedAPlan): string => `${notAfterOf(m, 'C03').slice(0, 19)}+02:00`;

export const DATE_ROWS: readonly FilterRow[] = [
    { row: 'D-1', title: 'NOT_AFTER EQUALS T(C03) (exact second)', filters: na('EQUALS', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() === naTime(m, 'C03')), plan: ids('C03') },
    { row: 'D-2', title: 'NOT_AFTER EQUALS T(C03) written with +02:00 (offset accepted and dropped today)', filters: na('EQUALS', withOffset), expect: () => ids('C03'), plan: ids('C03'), pin: 'Q4' },
    { row: 'D-4', title: 'NOT_AFTER NOT_EQUALS T(C03)', filters: na('NOT_EQUALS', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() !== naTime(m, 'C03')), plan: 23 },
    { row: 'D-5', title: 'NOT_AFTER GREATER_OR_EQUAL T(C06)', filters: na('GREATER_OR_EQUAL', 'C06'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() >= naTime(m, 'C06')), plan: 18 },
    { row: 'D-6', title: 'NOT_AFTER GREATER T(C06)', filters: na('GREATER', 'C06'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() > naTime(m, 'C06')), plan: 17 },
    { row: 'D-7', title: 'NOT_AFTER LESSER T(C03)', filters: na('LESSER', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() < naTime(m, 'C03')), plan: ids('C01', 'C02', 'C07') },
    { row: 'D-8', title: 'NOT_AFTER LESSER_OR_EQUAL T(C03)', filters: na('LESSER_OR_EQUAL', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() <= naTime(m, 'C03')), plan: ids('C01', 'C02', 'C03', 'C07') },
    { row: 'D-10', title: 'NOT_AFTER EMPTY', filters: na('EMPTY', undefined), expect: () => [], plan: 0 },
    { row: 'D-11', title: 'NOT_AFTER NOT_EMPTY', filters: na('NOT_EMPTY', undefined), expect: ALL, plan: 24 },
    { row: 'D-12a', title: 'NOT_AFTER IN_NEXT P30D', filters: na('IN_NEXT', () => 'P30D'), expect: (m) => inNext(m, 30), plan: ids('C01', 'C02', 'C03') },
    { row: 'D-12b', title: 'NOT_AFTER IN_NEXT P50D', filters: na('IN_NEXT', () => 'P50D'), expect: (m) => inNext(m, 50), plan: ids('C01', 'C02', 'C03', 'C04') },
    { row: 'D-12c', title: 'NOT_AFTER IN_NEXT P90D', filters: na('IN_NEXT', () => 'P90D'), expect: (m) => inNext(m, 90), plan: ids('C01', 'C02', 'C03', 'C04', 'C05') },
    { row: 'D-12d', title: 'NOT_AFTER IN_NEXT P1D', filters: na('IN_NEXT', () => 'P1D'), expect: (m) => inNext(m, 1), plan: 0 },
    { row: 'D-13a', title: 'NOT_AFTER IN_PAST P2D', filters: na('IN_PAST', () => 'P2D'), expect: (m) => inPast(m, 2), plan: ids('C07') },
    { row: 'D-13b', title: 'NOT_AFTER IN_PAST P1Y', filters: na('IN_PAST', () => 'P1Y'), expect: (m) => inPast(m, 365), plan: ids('C07') },
    { row: 'D-15a', title: 'NOT_BEFORE IN_NEXT P30D', filters: (m) => [prop('NOT_BEFORE', 'IN_NEXT', 'P30D')], expect: (m) => idsWhere(m, (c) => { const now = new Date(m.clock).getTime(); const x = new Date(c.notBefore).getTime(); return x >= now && x <= now + 30 * 24 * 3600 * 1000; }), plan: ids('C20') },
    { row: 'D-15b', title: 'NOT_BEFORE IN_PAST P60D', filters: (m) => [prop('NOT_BEFORE', 'IN_PAST', 'P60D')], expect: (m) => idsWhere(m, (c) => { const now = new Date(m.clock).getTime(); const x = new Date(c.notBefore).getTime(); return x <= now && x >= now - 60 * 24 * 3600 * 1000; }), plan: 22 },
];

/** D-3: a datetime value without an offset, and a date-only value: 4xx expected, 500 today (core#2504). */
export const DATE_REFUSALS: ReadonlyArray<{ row: string; title: string; value: (m: SeedAPlan) => string; bug: string }> = [
    { row: 'D-3a', title: 'NOT_AFTER EQUALS a value without an offset', value: (m) => notAfterOf(m, 'C03').slice(0, 19), bug: 'core#2504' },
    { row: 'D-3b', title: 'NOT_AFTER EQUALS a date-only value', value: (m) => notAfterOf(m, 'C03').slice(0, 10), bug: 'core#2504' },
];

/** D-14: bad durations: 422 `Filter field value … cannot be parsed to a Duration.` (the empty value may also answer the "requires at least one value" text). */
export const DURATION_REFUSALS: ReadonlyArray<{ row: string; value: string; text: RegExp }> = [
    { row: 'D-14a', value: '30 days', text: /Filter field value 30 days cannot be parsed to a Duration\./ },
    { row: 'D-14b', value: '', text: /(cannot be parsed to a Duration\.|requires at least one value\.)/ },
    { row: 'D-14c', value: 'P', text: /Filter field value P cannot be parsed to a Duration\./ },
];

// ------------------------------------------------------------------ List and enum (REG-CERT-43, API-CERT-43)

export const LIST_ROWS: readonly FilterRow[] = [
    { row: 'L-1a', title: 'CERTIFICATE_STATE EQUALS issued', filters: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['issued'])], expect: ALL, plan: 24 },
    { row: 'L-1b', title: 'CERTIFICATE_STATE EQUALS [issued, revoked]', filters: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['issued', 'revoked'])], expect: ALL, plan: 24 },
    { row: 'L-1c', title: 'CERTIFICATE_STATE NOT_EQUALS issued', filters: () => [prop('CERTIFICATE_STATE', 'NOT_EQUALS', ['issued'])], expect: () => [], plan: 0 },
    { row: 'L-1d', title: 'CERTIFICATE_STATE EQUALS revoked', filters: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['revoked'])], expect: () => [], plan: 0 },
    { row: 'L-2a', title: 'CERTIFICATE_STATE EQUALS the label Issued (the code is compared: no rows, no error)', filters: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['Issued'])], expect: () => [], plan: 0 },
    { row: 'L-2b', title: 'CERTIFICATE_STATE EQUALS an unknown code (no rows, no error)', filters: () => [prop('CERTIFICATE_STATE', 'EQUALS', ['no-such-state'])], expect: () => [], plan: 0 },
    { row: 'L-3a', title: 'KEY_SIZE EQUALS 3072', filters: () => [prop('KEY_SIZE', 'EQUALS', [3072])], expect: (m) => idsWhere(m, (c) => c.keyBits === 3072), plan: ids('C05', 'C06') },
    { row: 'L-3b', title: 'KEY_SIZE EQUALS [3072, 4096]', filters: () => [prop('KEY_SIZE', 'EQUALS', [3072, 4096])], expect: (m) => idsWhere(m, (c) => c.keyBits === 3072 || c.keyBits === 4096), plan: ids('C05', 'C06', 'C08') },
    { row: 'L-3c', title: 'KEY_SIZE NOT_EQUALS 2048', filters: () => [prop('KEY_SIZE', 'NOT_EQUALS', [2048])], expect: (m) => idsWhere(m, (c) => c.keyBits !== 2048), plan: 3 },
    { row: 'L-3d', title: 'KEY_SIZE EQUALS 1234', filters: () => [prop('KEY_SIZE', 'EQUALS', [1234])], expect: () => [], plan: 0 },
    { row: 'L-5a', title: 'SUBJECT_TYPE EQUALS rootCa', filters: () => [prop('SUBJECT_TYPE', 'EQUALS', ['rootCa'])], expect: (m) => idsWhere(m, (c) => c.ca && !c.issuedBy), plan: ids('C24') },
    { row: 'L-5b', title: 'SUBJECT_TYPE EQUALS endEntity', filters: () => [prop('SUBJECT_TYPE', 'EQUALS', ['endEntity'])], expect: (m) => idsWhere(m, (c) => !c.ca && !!c.issuedBy), plan: ids('C11', 'C12', 'C13') },
    { row: 'L-5c', title: 'SUBJECT_TYPE EQUALS [rootCa, endEntity]', filters: () => [prop('SUBJECT_TYPE', 'EQUALS', ['rootCa', 'endEntity'])], expect: (m) => idsWhere(m, (c) => (c.ca && !c.issuedBy) || (!c.ca && !!c.issuedBy)), plan: ids('C11', 'C12', 'C13', 'C24') },
    { row: 'L-6a', title: 'SIGNATURE_ALGORITHM EQUALS the catalogue value for SHA-384', filters: (_m, ctx) => [prop('SIGNATURE_ALGORITHM', 'EQUALS', [ctx.signatureSha384 ?? ''])], expect: (m) => idsWhere(m, (c) => c.hash === 'SHA-384'), plan: ids('C09') },
    { row: 'L-6b', title: 'SIGNATURE_ALGORITHM EQUALS the catalogue value for SHA-512', filters: (_m, ctx) => [prop('SIGNATURE_ALGORITHM', 'EQUALS', [ctx.signatureSha512 ?? ''])], expect: (m) => idsWhere(m, (c) => c.hash === 'SHA-512'), plan: ids('C10') },
    { row: 'L-7', title: 'ISSUER_COMMON_NAME EQUALS <P>ca-root', filters: (m) => [prop('ISSUER_COMMON_NAME', 'EQUALS', P(m, 'ca-root'))], expect: (m) => idsWhere(m, (c) => c.id === 'C24' || c.issuedBy === 'C24'), plan: ids('C11', 'C12', 'C13', 'C24') },
    { row: 'L-8', title: 'PUBLIC_KEY_ALGORITHM EQUALS RSA (catalogue value)', filters: (_m, ctx) => [prop('PUBLIC_KEY_ALGORITHM', 'EQUALS', [ctx.rsa ?? ''])], expect: ALL, plan: 24 },
];

/** L-4: a condition the field does not advertise: 422 with the exact text (rules §1.3). */
export const LIST_REFUSALS: ReadonlyArray<{ row: string; filter: Filter; text: RegExp }> = [
    {
        row: 'L-4',
        filter: prop('KEY_SIZE', 'GREATER', [2048]),
        text: /^Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY\.$/,
    },
];

// ------------------------------------------------------------------ Collection (groups) and owner (API-CERT-45)

const inGroup = (c: SeedACert, g: 'a' | 'b'): boolean => c.groups.includes(g);
const gname = (m: SeedAPlan, g: 'a' | 'b'): string => m.groups[g].name;

export const COLLECTION_ROWS: readonly FilterRow[] = [
    { row: 'G-1a', title: 'GROUP_NAME EQUALS <P>grp-a', filters: (m) => [prop('GROUP_NAME', 'EQUALS', [gname(m, 'a')])], expect: (m) => idsWhere(m, (c) => inGroup(c, 'a')), plan: 6 },
    { row: 'G-1b', title: 'GROUP_NAME NOT_EQUALS <P>grp-a (complement, nulls included)', filters: (m) => [prop('GROUP_NAME', 'NOT_EQUALS', [gname(m, 'a')])], expect: (m) => idsWhere(m, (c) => !inGroup(c, 'a')), plan: 18 },
    { row: 'G-2a', title: 'GROUP_NAME EQUALS [a, b] (any of)', filters: (m) => [prop('GROUP_NAME', 'EQUALS', [gname(m, 'a'), gname(m, 'b')])], expect: (m) => idsWhere(m, (c) => inGroup(c, 'a') || inGroup(c, 'b')), plan: 8 },
    { row: 'G-2b', title: 'GROUP_NAME NOT_EQUALS [a, b] (none of)', filters: (m) => [prop('GROUP_NAME', 'NOT_EQUALS', [gname(m, 'a'), gname(m, 'b')])], expect: (m) => idsWhere(m, (c) => !inGroup(c, 'a') && !inGroup(c, 'b')), plan: 16 },
    { row: 'G-3a', title: 'GROUP_NAME EMPTY', filters: () => [prop('GROUP_NAME', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.groups.length === 0), plan: 16 },
    { row: 'G-3b', title: 'GROUP_NAME NOT_EMPTY', filters: () => [prop('GROUP_NAME', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.groups.length > 0), plan: 8 },
    { row: 'G-4a', title: 'GROUP_NAME COUNT_EQUAL 2', filters: () => [prop('GROUP_NAME', 'COUNT_EQUAL', 2)], expect: (m) => idsWhere(m, (c) => c.groups.length === 2), plan: ids('C03', 'C04') },
    { row: 'G-4b', title: 'GROUP_NAME COUNT_GREATER_THAN 1', filters: () => [prop('GROUP_NAME', 'COUNT_GREATER_THAN', 1)], expect: (m) => idsWhere(m, (c) => c.groups.length > 1), plan: ids('C03', 'C04') },
    { row: 'G-4c', title: 'GROUP_NAME COUNT_LESS_THAN 1', filters: () => [prop('GROUP_NAME', 'COUNT_LESS_THAN', 1)], expect: (m) => idsWhere(m, (c) => c.groups.length < 1), plan: 16 },
    { row: 'G-4d', title: 'GROUP_NAME COUNT_NOT_EQUAL 0', filters: () => [prop('GROUP_NAME', 'COUNT_NOT_EQUAL', 0)], expect: (m) => idsWhere(m, (c) => c.groups.length !== 0), plan: 8 },
    // Other collection fields: no seed has a location or a predecessor / successor.
    { row: 'G-6a', title: 'CERT_LOCATION_NAME EMPTY', filters: () => [prop('CERT_LOCATION_NAME', 'EMPTY')], expect: ALL, plan: 24 },
    { row: 'G-6b', title: 'PRECEDING_CERTIFICATES COUNT_EQUAL 0', filters: () => [prop('PRECEDING_CERTIFICATES', 'COUNT_EQUAL', 0)], expect: ALL, plan: 24 },
    { row: 'G-6c', title: 'SUCCEEDING_CERTIFICATES COUNT_GREATER_THAN 0', filters: () => [prop('SUCCEEDING_CERTIFICATES', 'COUNT_GREATER_THAN', 0)], expect: () => [], plan: 0 },
    { row: 'O-1a', title: 'OWNER EMPTY', filters: () => [prop('OWNER', 'EMPTY')], expect: (m) => idsWhere(m, (c) => !c.owner), plan: 22 },
    { row: 'O-1b', title: 'OWNER NOT_EMPTY', filters: () => [prop('OWNER', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.owner), plan: 2 },
    { row: 'O-3', title: 'RA_PROFILE_NAME EMPTY (no seed has an RA profile)', filters: () => [prop('RA_PROFILE_NAME', 'EMPTY')], expect: ALL, plan: 24 },
];

/**
 * O-2 (plan: "OWNER NOT_CONTAINS zzz vs NOT_MATCHES ^zzz — the documented null asymmetry") cannot run on OWNER: OWNER is a LIST field
 * (core FilterField.java:115, SearchFieldTypeEnum.LIST), whose conditions are EQUALS / NOT_EQUALS / EMPTY / NOT_EMPTY — the string
 * conditions are refused 422 "Field OWNER does not support the … condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY."
 * (FilterPredicatesBuilder.requireAdvertisedCondition). The asymmetry (NOT_CONTAINS includes null columns, NOT_MATCHES excludes them,
 * rules §2.2 r15) needs a nullable STRING property field no seed can set; it is not asserted. Plan deviation, reported.
 */
export const OWNER_REFUSALS: ReadonlyArray<{ row: string; condition: string; value: string }> = [
    { row: 'O-2a', condition: 'NOT_CONTAINS', value: 'zzz' },
    { row: 'O-2b', condition: 'NOT_MATCHES', value: '^zzz' },
    { row: 'O-2c', condition: 'CONTAINS', value: 'zzz' },
];

/**
 * G-5: COUNT_* with a non-integer value. The intended answer is the same for all four conditions: 422 "Filter field value <v> cannot be
 * parsed as an Integer." (core's own FilterPredicatesBuilderITest expects a ValidationException for COUNT_EQUAL / COUNT_NOT_EQUAL too).
 * Today GREATER / LESS parse the value (G-5a..c green) while EQUAL / NOT_EQUAL hand it to the query unparsed (G-5d / e answer 500:
 * suspected product defect). G-5d / e carry `unfiled: true`: asserted as written, NO test.fail and no @bug tag
 * (nothing is filed); they stay red until the defect is confirmed and filed or core is fixed, then take the @bug tag.
 */
export const COUNT_REFUSALS: ReadonlyArray<{ row: string; condition: string; value: unknown; text: RegExp; unfiled?: true }> = [
    { row: 'G-5a', condition: 'COUNT_GREATER_THAN', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./ },
    { row: 'G-5b', condition: 'COUNT_GREATER_THAN', value: '1.5', text: /Filter field value 1\.5 cannot be parsed as an Integer\./ },
    { row: 'G-5c', condition: 'COUNT_LESS_THAN', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./ },
    { row: 'G-5d', condition: 'COUNT_EQUAL', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./, unfiled: true },
    { row: 'G-5e', condition: 'COUNT_NOT_EQUAL', value: '1.5', text: /Filter field value 1\.5 cannot be parsed as an Integer\./, unfiled: true },
];

/**
 * G-5 pins: a JSON number that is not a whole count (1.5) or is negative (-1) on COUNT_EQUAL answers 200 with no seed today (no group
 * count can equal it). Whether 1.5 should become a 422 like the string "1.5" (C1) is open; the pin flips when core decides.
 */
export const COUNT_PINS: ReadonlyArray<{ row: string; condition: string; value: number }> = [
    { row: 'G-5f', condition: 'COUNT_EQUAL', value: 1.5 },
    { row: 'G-5g', condition: 'COUNT_EQUAL', value: -1 },
];

// ------------------------------------------------------------------ Custom attributes (API-CERT-46, REG-CERT-44)

type AttrKey = 'txt' | 'num' | 'day' | 'flag' | 'pick';
const ca = (m: SeedAPlan, key: AttrKey, condition: string, value?: unknown): Filter => custom(m.attributes[key].identifier, condition, value);
const txtOf = (c: SeedACert): string | null => c.txt;

export const ATTRIBUTE_ROWS: readonly FilterRow[] = [
    { row: 'A-1a', title: 'txt CONTAINS red', filters: (m) => [ca(m, 'txt', 'CONTAINS', 'red')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').includes('red')), plan: ids('C01', 'C02', 'C06') },
    { row: 'A-1b', title: 'txt NOT_CONTAINS red (case-sensitive; C03 holds Red; certificates without a value included)', filters: (m) => [ca(m, 'txt', 'NOT_CONTAINS', 'red')], expect: (m) => idsWhere(m, (c) => !(txtOf(c) ?? '').includes('red')), plan: 21 },
    { row: 'A-2a', title: 'txt EQUALS red', filters: (m) => [ca(m, 'txt', 'EQUALS', 'red')], expect: (m) => idsWhere(m, (c) => c.txt === 'red'), plan: ids('C01', 'C02') },
    { row: 'A-2b', title: 'txt NOT_EQUALS red', filters: (m) => [ca(m, 'txt', 'NOT_EQUALS', 'red')], expect: (m) => idsWhere(m, (c) => c.txt !== 'red'), plan: 22 },
    { row: 'A-3a', title: 'txt STARTS_WITH re', filters: (m) => [ca(m, 'txt', 'STARTS_WITH', 're')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').startsWith('re')), plan: ids('C01', 'C02', 'C06') },
    { row: 'A-3b', title: 'txt ENDS_WITH blue', filters: (m) => [ca(m, 'txt', 'ENDS_WITH', 'blue')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').endsWith('blue')), plan: ids('C05', 'C06') },
    { row: 'A-3c', title: 'txt MATCHES ^re.*', filters: (m) => [ca(m, 'txt', 'MATCHES', '^re.*')], expect: (m) => idsWhere(m, (c) => /^re.*/.test(txtOf(c) ?? '\u0000')), plan: ids('C01', 'C02', 'C06') },
    { row: 'A-4a', title: 'txt EMPTY', filters: (m) => [ca(m, 'txt', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.txt === null), plan: 17 },
    { row: 'A-4b', title: 'txt NOT_EMPTY', filters: (m) => [ca(m, 'txt', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.txt !== null), plan: 7 },
    { row: 'A-5a', title: 'num EQUALS 30', filters: (m) => [ca(m, 'num', 'EQUALS', '30')], expect: (m) => idsWhere(m, (c) => c.num === 30), plan: ids('C03') },
    { row: 'A-5b', title: 'num EQUALS 0', filters: (m) => [ca(m, 'num', 'EQUALS', '0')], expect: (m) => idsWhere(m, (c) => c.num === 0), plan: ids('C08') },
    { row: 'A-5c', title: 'num EQUALS -5', filters: (m) => [ca(m, 'num', 'EQUALS', '-5')], expect: (m) => idsWhere(m, (c) => c.num === -5), plan: ids('C07') },
    { row: 'A-5d', title: 'num NOT_EQUALS 30', filters: (m) => [ca(m, 'num', 'NOT_EQUALS', '30')], expect: (m) => idsWhere(m, (c) => c.num !== 30), plan: 23 },
    { row: 'A-6a', title: 'num GREATER 60', filters: (m) => [ca(m, 'num', 'GREATER', '60')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num > 60), plan: ids('C09', 'C10') },
    { row: 'A-6b', title: 'num GREATER_OR_EQUAL 60', filters: (m) => [ca(m, 'num', 'GREATER_OR_EQUAL', '60')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num >= 60), plan: ids('C06', 'C09', 'C10') },
    { row: 'A-6c', title: 'num LESSER 0', filters: (m) => [ca(m, 'num', 'LESSER', '0')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num < 0), plan: ids('C07') },
    { row: 'A-6d', title: 'num LESSER_OR_EQUAL 0', filters: (m) => [ca(m, 'num', 'LESSER_OR_EQUAL', '0')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num <= 0), plan: ids('C07', 'C08') },
    { row: 'A-7a', title: 'num EMPTY', filters: (m) => [ca(m, 'num', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.num === null), plan: 14 },
    { row: 'A-7b', title: 'num NOT_EMPTY', filters: (m) => [ca(m, 'num', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.num !== null), plan: 10 },
    { row: 'A-8a', title: 'day EQUALS the C03 date', filters: (m) => [ca(m, 'day', 'EQUALS', dayOf(m, 'C03'))], expect: (m) => idsWhere(m, (c) => c.day === dayOf(m, 'C03')), plan: ids('C03', 'C04') },
    { row: 'A-8b', title: 'day GREATER the C02 date', filters: (m) => [ca(m, 'day', 'GREATER', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day > dayOf(m, 'C02')), plan: ids('C03', 'C04', 'C05') },
    { row: 'A-8c', title: 'day GREATER_OR_EQUAL the C02 date', filters: (m) => [ca(m, 'day', 'GREATER_OR_EQUAL', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day >= dayOf(m, 'C02')), plan: ids('C02', 'C03', 'C04', 'C05') },
    { row: 'A-8d', title: 'day LESSER the C02 date', filters: (m) => [ca(m, 'day', 'LESSER', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day < dayOf(m, 'C02')), plan: ids('C01') },
    { row: 'A-8e', title: 'day LESSER_OR_EQUAL the C02 date', filters: (m) => [ca(m, 'day', 'LESSER_OR_EQUAL', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day <= dayOf(m, 'C02')), plan: ids('C01', 'C02') },
    { row: 'A-9a', title: 'day NOT_EQUALS the C03 date', filters: (m) => [ca(m, 'day', 'NOT_EQUALS', dayOf(m, 'C03'))], expect: (m) => idsWhere(m, (c) => c.day !== dayOf(m, 'C03')), plan: 22 },
    { row: 'A-9b', title: 'day EMPTY', filters: (m) => [ca(m, 'day', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.day === null), plan: 19 },
    { row: 'A-9c', title: 'day NOT_EMPTY', filters: (m) => [ca(m, 'day', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.day !== null), plan: 5 },
    { row: 'A-9d', title: 'day IN_NEXT P36500D (the five dates are in the future)', filters: (m) => [ca(m, 'day', 'IN_NEXT', 'P36500D')], expect: (m) => idsWhere(m, (c) => c.day !== null), plan: 5 },
    { row: 'A-9e', title: 'day IN_PAST P36500D', filters: (m) => [ca(m, 'day', 'IN_PAST', 'P36500D')], expect: () => [], plan: 0 },
    { row: 'A-10a', title: 'flag EQUALS true', filters: (m) => [ca(m, 'flag', 'EQUALS', true)], expect: (m) => idsWhere(m, (c) => c.flag === true), plan: ids('C01', 'C02', 'C05') },
    { row: 'A-10b', title: 'flag EQUALS false', filters: (m) => [ca(m, 'flag', 'EQUALS', false)], expect: (m) => idsWhere(m, (c) => c.flag === false), plan: ids('C03', 'C04') },
    { row: 'A-10c', title: 'flag NOT_EQUALS true', filters: (m) => [ca(m, 'flag', 'NOT_EQUALS', true)], expect: (m) => idsWhere(m, (c) => c.flag !== true), plan: 21 },
    { row: 'A-10d', title: 'flag EMPTY', filters: (m) => [ca(m, 'flag', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.flag === null), plan: 19 },
    { row: 'A-11a', title: 'pick EQUALS [a] (any of)', filters: (m) => [ca(m, 'pick', 'EQUALS', ['a'])], expect: (m) => idsWhere(m, (c) => !!c.pick?.includes('a')), plan: ids('C01', 'C02', 'C05') },
    { row: 'A-11b', title: 'pick EQUALS [b, c] (any of)', filters: (m) => [ca(m, 'pick', 'EQUALS', ['b', 'c'])], expect: (m) => idsWhere(m, (c) => !!c.pick?.some((p) => p === 'b' || p === 'c')), plan: ids('C02', 'C03', 'C04', 'C05') },
    { row: 'A-12a', title: 'pick NOT_EQUALS [a] (complement incl. certificates without a value; core#813)', filters: (m) => [ca(m, 'pick', 'NOT_EQUALS', ['a'])], expect: (m) => idsWhere(m, (c) => !c.pick?.includes('a')), plan: 21 },
    { row: 'A-12b', title: 'pick NOT_EQUALS [a, b] (none of; core#813)', filters: (m) => [ca(m, 'pick', 'NOT_EQUALS', ['a', 'b'])], expect: (m) => idsWhere(m, (c) => !c.pick?.some((p) => p === 'a' || p === 'b')), plan: 20 },
    { row: 'A-12c', title: 'pick EMPTY (core#741: EMPTY does not return everything)', filters: (m) => [ca(m, 'pick', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.pick === null), plan: 19 },
    { row: 'A-12d', title: 'pick NOT_EMPTY', filters: (m) => [ca(m, 'pick', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.pick !== null), plan: 5 },
];

const dayOf = (m: SeedAPlan, id: CertId): string => {
    const d = m.certificates.find((c) => c.id === id)!.day;
    if (!d) throw new Error(`${id} has no day value`);
    return d;
};

/** A-13: attribute-filter edges. The first is a 422, the second 200 with no rows, the third is accepted today (`@pin:Q5`). */
export const ATTRIBUTE_EDGES = {
    withoutSuffix: (m: SeedAPlan): Filter => custom(m.attributes.txt.name, 'CONTAINS', 'red'),
    withoutSuffixText: (m: SeedAPlan): RegExp => new RegExp(`^Filter field identifier ${escapeRe(m.attributes.txt.name)} does not name an attribute\\.$`),
    unknown: (): Filter => custom('qa-no-such-attribute|STRING', 'EQUALS', 'x'),
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every row table, for the generic consistency test and the catalogue-driven specs. */
export const ALL_ROW_TABLES: Readonly<Record<string, readonly FilterRow[]>> = {
    text: TEXT_ROWS,
    date: DATE_ROWS,
    list: LIST_ROWS,
    collection: COLLECTION_ROWS,
    attribute: ATTRIBUTE_ROWS,
};

// ------------------------------------------------------------------ sort comparators (Cmp oracles)

export type SortField = 'NOT_AFTER' | 'NOT_BEFORE' | 'GROUP_NAME' | 'OWNER' | 'num' | 'day' | 'txt' | 'pick';

/**
 * The sort key of a seed for a field and direction, or null (rows without a value sort LAST in both directions, rules §2.2
 * r22). A multi-valued field sorts by its smallest value ascending and its largest descending (r23).
 */
export function sortKey(m: SeedAPlan, c: SeedACert, field: SortField, dir: 'asc' | 'desc'): string | number | null {
    switch (field) {
        case 'NOT_AFTER':
            return new Date(c.notAfter).getTime();
        case 'NOT_BEFORE':
            return new Date(c.notBefore).getTime();
        case 'OWNER':
            return c.owner ? m.owner.username : null;
        case 'GROUP_NAME': {
            const names = c.groups.map((g) => m.groups[g].name).sort();
            return names.length ? (dir === 'asc' ? names[0] : names[names.length - 1]) : null;
        }
        case 'num':
            return c.num;
        case 'day':
            return c.day;
        case 'txt':
            return c.txt;
        case 'pick': {
            const v = c.pick ? [...c.pick].sort() : [];
            return v.length ? (dir === 'asc' ? v[0] : v[v.length - 1]) : null;
        }
    }
}

/**
 * The expected order as GROUPS of equal keys: non-null keys in the requested direction, then every seed without a value
 * as one last group (both directions). Inside a group the order is the engine's uuid tie-break, which the tests pin after
 * the first observation (plan Q-G): compare group by group, as sets, and check stability separately.
 */
export function expectedOrderGroups(m: SeedAPlan, field: SortField, dir: 'asc' | 'desc'): CertId[][] {
    const withKey = m.certificates.map((c) => ({ id: c.id, key: sortKey(m, c, field, dir) }));
    const present = withKey.filter((x) => x.key !== null) as Array<{ id: CertId; key: string | number }>;
    const absent = withKey.filter((x) => x.key === null).map((x) => x.id);
    const cmp = (a: string | number, b: string | number): number => (typeof a === 'number' && typeof b === 'number' ? a - b : a < b ? -1 : a > b ? 1 : 0);
    present.sort((x, y) => (dir === 'asc' ? cmp(x.key, y.key) : cmp(y.key, x.key)));
    const groups: CertId[][] = [];
    for (const x of present) {
        const last = groups[groups.length - 1];
        if (last && cmp(present.find((p) => p.id === last[0])!.key, x.key) === 0) last.push(x.id);
        else groups.push([x.id]);
    }
    if (absent.length) groups.push(absent);
    return groups;
}

/**
 * The strict expected uuid order: the groups of `expectedOrderGroups`, each group's members by uuid ASCENDING. The uuid
 * tie-break is `asc` whatever the sort direction (core SortOrderBuilder.tieBreak, :253-259: `criteriaBuilder.asc(uuid)`;
 * "ordered nulls last in both directions, then by uuid", core#2394) — plan question Q-G answered from the code. Postgres
 * orders uuids bytewise, which for lower-case canonical text equals string comparison.
 */
export function expectedUuidOrder(m: Omit<SeedAPlan, 'certificates'> & { certificates: Array<SeedACert & { uuid: string }> }, field: SortField, dir: 'asc' | 'desc'): string[] {
    const uuidOf = new Map<CertId, string>(m.certificates.map((c) => [c.id, c.uuid] as [CertId, string]));
    return expectedOrderGroups(m as SeedAPlan, field, dir).flatMap((g) => g.map((id) => uuidOf.get(id)!).sort());
}

/** Does an actual id sequence follow the groups (each group's members contiguous, in group order, as sets)? Returns the problem or undefined. */
export function orderProblem(actual: readonly CertId[], groups: readonly CertId[][]): string | undefined {
    let i = 0;
    for (const [n, g] of groups.entries()) {
        const slice = actual.slice(i, i + g.length);
        if ([...slice].sort().join(',') !== [...g].sort().join(',')) {
            return `group ${n + 1}: expected {${[...g].sort().join(', ')}} at positions ${i + 1}-${i + g.length}, got [${slice.join(', ')}]`;
        }
        i += g.length;
    }
    return i === actual.length ? undefined : `${actual.length - i} extra row(s) after the expected groups`;
}

/** ids 'C01'..'Cnn' — exported for the specs that need the full default order. */
export const idRange = range;
export { not as complementOf };
