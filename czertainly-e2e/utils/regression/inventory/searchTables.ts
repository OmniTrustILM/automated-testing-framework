/**
 * searchTables — the expected row sets of the certificate filter rows, and the sort comparators.
 *
 * Each row names its expected result twice, so a wrong rule cannot agree with itself: `expect` (a predicate that states
 * the rule) and `expectedIds` (the same set written by hand, as ids or a count). A unit test checks they agree. A row
 * whose engine behaviour is a filed bug carries `bug`; a row without a written rule carries `pin` (a behaviour word or
 * an issue id).
 */
import type { Filter } from './searchApi';
import { propertyFilter, customAttributeFilter } from './searchApi';
import type { CertId, CertificateSeedPlan, CertificateSeedEntry } from './seedFull';
import { idsWhere } from './seedFull';
import { escapeRegExp } from '../text';

export interface FilterRow {
    /** Row id, e.g. `T-8`. */
    row: string;
    title: string;
    /** The filters of the row (the isolation filter is added by the caller unless `carriesIsolation`). */
    filters: (m: CertificateSeedPlan, ctx: RowContext) => Filter[];
    /** Expected seeds, computed by the rule's predicate. */
    expect: (m: CertificateSeedPlan) => CertId[];
    /** The set written down by hand (ids, or a count when only a count is stated); the unit test checks it against `expect`. */
    expectedIds: CertId[] | number;
    /** The row's own filters already narrow to the seed prefix: the isolation filter is still sent, harmless. */
    carriesIsolation?: boolean;
    /** Expected refusal: 422 and the text (RegExp or exact). Then `expect` / `expectedIds` are empty. */
    refusal?: { status: 422 | 400; text: RegExp };
    /** Known product bug the row's rule contradicts today: the test is `test.fail()` with this `@bug`. */
    bug?: string;
    /** Characterisation pin (no written rule): a behaviour word or an issue id; the pinned test is never P1. */
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
const ALL = (m: CertificateSeedPlan): CertId[] => m.certificates.map((c) => c.id);
const P = (m: CertificateSeedPlan, token: string): string => `${m.prefix}${token}`;
const t = (c: CertificateSeedEntry): string => c.commonName;

/** The notAfter of a seed (the expiry of seed Cnn), as the filter literal `yyyy-MM-ddTHH:mm:ss.SSSZ`. */
export const notAfterOf = (m: CertificateSeedPlan, id: CertId): string => new Date(m.certificates.find((c) => c.id === id)!.notAfter).toISOString();

// ------------------------------------------------------------------ Text — COMMON_NAME (REG-CERT-41, API-CERT-41)

const cn = (condition: string, value: (m: CertificateSeedPlan) => string | undefined): FilterRow['filters'] => (m) => [propertyFilter('COMMON_NAME', condition, value(m))];
const containsToken = (m: CertificateSeedPlan, word: string): CertId[] => idsWhere(m, (c) => c.token.includes(word));

export const TEXT_ROWS: readonly FilterRow[] = [
    { row: 'T-1', title: 'a name CONTAINS "web" filter returns the four seeds with web in the name', filters: cn('CONTAINS', () => 'web'), expect: (m) => containsToken(m, 'web'), expectedIds: ids('C01', 'C03', 'C06', 'C07') },
    { row: 'T-2', title: 'a name NOT_CONTAINS "web" filter returns the 20 seeds without web in the name', filters: cn('NOT_CONTAINS', () => 'web'), expect: (m) => idsWhere(m, (c) => !c.token.includes('web')), expectedIds: 20 },
    { row: 'T-3', title: 'a name EQUALS filter on the run\'s gamma-db name returns that one seed', filters: cn('EQUALS', (m) => P(m, 'gamma-db')), expect: (m) => idsWhere(m, (c) => t(c) === P(m, 'gamma-db')), expectedIds: ids('C05'), carriesIsolation: true },
    { row: 'T-4', title: 'a name NOT_EQUALS filter on the run\'s gamma-db name returns the other 23 seeds', filters: cn('NOT_EQUALS', (m) => P(m, 'gamma-db')), expect: (m) => idsWhere(m, (c) => t(c) !== P(m, 'gamma-db')), expectedIds: 23 },
    { row: 'T-5', title: 'a name EMPTY filter returns no seed', filters: cn('EMPTY', () => undefined), expect: () => [], expectedIds: 0 },
    { row: 'T-6', title: 'a name NOT_EMPTY filter returns all 24 seeds', filters: cn('NOT_EMPTY', () => undefined), expect: ALL, expectedIds: 24 },
    { row: 'T-7', title: 'a name STARTS_WITH filter on the run\'s alpha prefix returns the two alpha seeds', filters: cn('STARTS_WITH', (m) => P(m, 'alpha')), expect: (m) => idsWhere(m, (c) => t(c).startsWith(P(m, 'alpha'))), expectedIds: ids('C01', 'C02'), carriesIsolation: true },
    { row: 'T-8', title: 'a name ENDS_WITH "-web" filter returns the four web seeds', filters: cn('ENDS_WITH', () => '-web'), expect: (m) => idsWhere(m, (c) => t(c).endsWith('-web')), expectedIds: ids('C01', 'C03', 'C06', 'C07') },
    { row: 'T-9', title: 'a name MATCHES filter for the run\'s alpha or beta names returns those four seeds', filters: cn('MATCHES', (m) => `^${P(m, '')}(alpha|beta)-`), expect: (m) => idsWhere(m, (c) => new RegExp(`^${P(m, '')}(alpha|beta)-`).test(t(c))), expectedIds: ids('C01', 'C02', 'C03', 'C04'), carriesIsolation: true },
    { row: 'T-10', title: 'a name NOT_MATCHES "-web$" filter returns the 20 seeds not ending in -web', filters: cn('NOT_MATCHES', () => '-web$'), expect: (m) => idsWhere(m, (c) => !/-web$/.test(t(c))), expectedIds: 20 },
    { row: 'T-11', title: 'a name CONTAINS "delta" filter is case-sensitive and returns only delta-mail', filters: cn('CONTAINS', () => 'delta'), expect: (m) => idsWhere(m, (c) => t(c).includes('delta')), expectedIds: ids('C08'), pin: 'case-sensitive-contains' },
    { row: 'T-12', title: 'a name CONTAINS "Delta" filter is case-sensitive and returns only Delta-web', filters: cn('CONTAINS', () => 'Delta'), expect: (m) => idsWhere(m, (c) => t(c).includes('Delta')), expectedIds: ids('C07'), pin: 'case-sensitive-contains' },
    // The rule is a literal match (the wildcard trait is the open bug core#2505): C09 only / none.
    { row: 'T-13', title: 'a name CONTAINS "_" filter matches the underscore literally and returns only eps_01', filters: cn('CONTAINS', () => '_'), expect: (m) => idsWhere(m, (c) => t(c).includes('_')), expectedIds: ids('C09'), bug: 'core#2505' },
    { row: 'T-14', title: 'a name CONTAINS "%" filter matches the percent sign literally and returns no seed', filters: cn('CONTAINS', () => '%'), expect: (m) => idsWhere(m, (c) => t(c).includes('%')), expectedIds: 0, bug: 'core#2505' },
];

// ------------------------------------------------------------------ Date and datetime — NOT_AFTER / NOT_BEFORE (REG-CERT-42, API-CERT-42)

const na = (condition: string, id: CertId | ((m: CertificateSeedPlan) => string) | undefined): FilterRow['filters'] => (m) =>
    [propertyFilter('NOT_AFTER', condition, id === undefined ? undefined : typeof id === 'function' ? id(m) : notAfterOf(m, id))];
const naTime = (m: CertificateSeedPlan, id: CertId): number => new Date(m.certificates.find((c) => c.id === id)!.notAfter).getTime();
/** Seeds whose notAfter is within `days` of the clock (in the future), the IN_NEXT window. */
const inNext = (m: CertificateSeedPlan, days: number): CertId[] => {
    const now = new Date(m.clock).getTime();
    return idsWhere(m, (c) => new Date(c.notAfter).getTime() >= now && new Date(c.notAfter).getTime() <= now + days * 24 * 3600 * 1000);
};
const inPast = (m: CertificateSeedPlan, days: number): CertId[] => {
    const now = new Date(m.clock).getTime();
    return idsWhere(m, (c) => new Date(c.notAfter).getTime() <= now && new Date(c.notAfter).getTime() >= now - days * 24 * 3600 * 1000);
};
/** The wall digits of T(C03) with another offset (accepted and dropped today; pinned). */
const withOffset = (m: CertificateSeedPlan): string => `${notAfterOf(m, 'C03').slice(0, 19)}+02:00`;

export const DATE_ROWS: readonly FilterRow[] = [
    { row: 'D-1', title: 'NOT_AFTER EQUALS the 25-day seed\'s expiry to the second returns exactly that seed', filters: na('EQUALS', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() === naTime(m, 'C03')), expectedIds: ids('C03') },
    { row: 'D-2', title: 'NOT_AFTER EQUALS that expiry written with +02:00 returns the seed (the offset is dropped)', filters: na('EQUALS', withOffset), expect: () => ids('C03'), expectedIds: ids('C03'), pin: 'datetime-offset-dropped' },
    { row: 'D-4', title: 'NOT_AFTER NOT_EQUALS the 25-day seed\'s expiry returns the other 23 seeds', filters: na('NOT_EQUALS', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() !== naTime(m, 'C03')), expectedIds: 23 },
    { row: 'D-5', title: 'NOT_AFTER GREATER_OR_EQUAL the 120-day seed\'s expiry returns the 18 seeds from it on', filters: na('GREATER_OR_EQUAL', 'C06'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() >= naTime(m, 'C06')), expectedIds: 18 },
    { row: 'D-6', title: 'NOT_AFTER GREATER the 120-day seed\'s expiry returns the 17 seeds after it', filters: na('GREATER', 'C06'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() > naTime(m, 'C06')), expectedIds: 17 },
    { row: 'D-7', title: 'NOT_AFTER LESSER the 25-day seed\'s expiry returns the three seeds expiring earlier', filters: na('LESSER', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() < naTime(m, 'C03')), expectedIds: ids('C01', 'C02', 'C07') },
    { row: 'D-8', title: 'NOT_AFTER LESSER_OR_EQUAL the 25-day seed\'s expiry returns it and the three before it', filters: na('LESSER_OR_EQUAL', 'C03'), expect: (m) => idsWhere(m, (c) => new Date(c.notAfter).getTime() <= naTime(m, 'C03')), expectedIds: ids('C01', 'C02', 'C03', 'C07') },
    { row: 'D-10', title: 'NOT_AFTER EMPTY returns no seed', filters: na('EMPTY', undefined), expect: () => [], expectedIds: 0 },
    { row: 'D-11', title: 'NOT_AFTER NOT_EMPTY returns all 24 seeds', filters: na('NOT_EMPTY', undefined), expect: ALL, expectedIds: 24 },
    { row: 'D-12a', title: 'NOT_AFTER IN_NEXT P30D returns the three seeds expiring within 30 days', filters: na('IN_NEXT', () => 'P30D'), expect: (m) => inNext(m, 30), expectedIds: ids('C01', 'C02', 'C03') },
    { row: 'D-12b', title: 'NOT_AFTER IN_NEXT P50D returns the four seeds expiring within 50 days', filters: na('IN_NEXT', () => 'P50D'), expect: (m) => inNext(m, 50), expectedIds: ids('C01', 'C02', 'C03', 'C04') },
    { row: 'D-12c', title: 'NOT_AFTER IN_NEXT P90D returns the five seeds expiring within 90 days', filters: na('IN_NEXT', () => 'P90D'), expect: (m) => inNext(m, 90), expectedIds: ids('C01', 'C02', 'C03', 'C04', 'C05') },
    { row: 'D-12d', title: 'NOT_AFTER IN_NEXT P1D returns no seed', filters: na('IN_NEXT', () => 'P1D'), expect: (m) => inNext(m, 1), expectedIds: 0 },
    { row: 'D-13a', title: 'NOT_AFTER IN_PAST P2D returns the one seed that expired yesterday', filters: na('IN_PAST', () => 'P2D'), expect: (m) => inPast(m, 2), expectedIds: ids('C07') },
    { row: 'D-13b', title: 'NOT_AFTER IN_PAST P1Y returns the one expired seed', filters: na('IN_PAST', () => 'P1Y'), expect: (m) => inPast(m, 365), expectedIds: ids('C07') },
    { row: 'D-15a', title: 'NOT_BEFORE IN_NEXT P30D returns the one seed that becomes valid later', filters: (m) => [propertyFilter('NOT_BEFORE', 'IN_NEXT', 'P30D')], expect: (m) => idsWhere(m, (c) => { const now = new Date(m.clock).getTime(); const x = new Date(c.notBefore).getTime(); return x >= now && x <= now + 30 * 24 * 3600 * 1000; }), expectedIds: ids('C20') },
    { row: 'D-15b', title: 'NOT_BEFORE IN_PAST P60D returns the 22 seeds that became valid in the last 60 days', filters: (m) => [propertyFilter('NOT_BEFORE', 'IN_PAST', 'P60D')], expect: (m) => idsWhere(m, (c) => { const now = new Date(m.clock).getTime(); const x = new Date(c.notBefore).getTime(); return x <= now && x >= now - 60 * 24 * 3600 * 1000; }), expectedIds: 22 },
];

/** D-3: a datetime value without an offset, and a date-only value: 4xx expected, 500 today (core#2504). */
export const DATE_REFUSALS: ReadonlyArray<{ row: string; title: string; value: (m: CertificateSeedPlan) => string; bug: string }> = [
    { row: 'D-3a', title: 'NOT_AFTER EQUALS a value without an offset', value: (m) => notAfterOf(m, 'C03').slice(0, 19), bug: 'core#2504' },
    { row: 'D-3b', title: 'NOT_AFTER EQUALS a date-only value', value: (m) => notAfterOf(m, 'C03').slice(0, 10), bug: 'core#2504' },
];

/**
 * Bad durations: 422 `Filter field value … cannot be parsed to a Duration.` (the empty value may also answer the "requires at least one
 * value" text).
 */
export const DURATION_REFUSALS: ReadonlyArray<{ row: string; value: string; text: RegExp }> = [
    { row: 'D-14a', value: '30 days', text: /Filter field value 30 days cannot be parsed to a Duration\./ },
    { row: 'D-14b', value: '', text: /(cannot be parsed to a Duration\.|requires at least one value\.)/ },
    { row: 'D-14c', value: 'P', text: /Filter field value P cannot be parsed to a Duration\./ },
];

// ------------------------------------------------------------------ List and enum (REG-CERT-43, API-CERT-43)

export const LIST_ROWS: readonly FilterRow[] = [
    { row: 'L-1a', title: 'CERTIFICATE_STATE EQUALS issued returns all 24 seeds', filters: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['issued'])], expect: ALL, expectedIds: 24 },
    { row: 'L-1b', title: 'CERTIFICATE_STATE EQUALS issued or revoked returns all 24 seeds', filters: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['issued', 'revoked'])], expect: ALL, expectedIds: 24 },
    { row: 'L-1c', title: 'CERTIFICATE_STATE NOT_EQUALS issued returns no seed', filters: () => [propertyFilter('CERTIFICATE_STATE', 'NOT_EQUALS', ['issued'])], expect: () => [], expectedIds: 0 },
    { row: 'L-1d', title: 'CERTIFICATE_STATE EQUALS revoked returns no seed', filters: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['revoked'])], expect: () => [], expectedIds: 0 },
    { row: 'L-2a', title: 'CERTIFICATE_STATE EQUALS the label Issued instead of the code returns no seed and no error', filters: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['Issued'])], expect: () => [], expectedIds: 0 },
    { row: 'L-2b', title: 'CERTIFICATE_STATE EQUALS an unknown code returns no seed and no error', filters: () => [propertyFilter('CERTIFICATE_STATE', 'EQUALS', ['no-such-state'])], expect: () => [], expectedIds: 0 },
    { row: 'L-3a', title: 'KEY_SIZE EQUALS 3072 returns the two 3072-bit seeds', filters: () => [propertyFilter('KEY_SIZE', 'EQUALS', [3072])], expect: (m) => idsWhere(m, (c) => c.keyBits === 3072), expectedIds: ids('C05', 'C06') },
    { row: 'L-3b', title: 'KEY_SIZE EQUALS 3072 or 4096 returns the three seeds of those sizes', filters: () => [propertyFilter('KEY_SIZE', 'EQUALS', [3072, 4096])], expect: (m) => idsWhere(m, (c) => c.keyBits === 3072 || c.keyBits === 4096), expectedIds: ids('C05', 'C06', 'C08') },
    { row: 'L-3c', title: 'KEY_SIZE NOT_EQUALS 2048 returns the three seeds of other sizes', filters: () => [propertyFilter('KEY_SIZE', 'NOT_EQUALS', [2048])], expect: (m) => idsWhere(m, (c) => c.keyBits !== 2048), expectedIds: 3 },
    { row: 'L-3d', title: 'KEY_SIZE EQUALS 1234 returns no seed', filters: () => [propertyFilter('KEY_SIZE', 'EQUALS', [1234])], expect: () => [], expectedIds: 0 },
    { row: 'L-5a', title: 'SUBJECT_TYPE EQUALS rootCa returns only the CA seed', filters: () => [propertyFilter('SUBJECT_TYPE', 'EQUALS', ['rootCa'])], expect: (m) => idsWhere(m, (c) => c.ca && !c.issuedBy), expectedIds: ids('C24') },
    { row: 'L-5b', title: 'SUBJECT_TYPE EQUALS endEntity returns the three seeds the CA issued', filters: () => [propertyFilter('SUBJECT_TYPE', 'EQUALS', ['endEntity'])], expect: (m) => idsWhere(m, (c) => !c.ca && !!c.issuedBy), expectedIds: ids('C11', 'C12', 'C13') },
    { row: 'L-5c', title: 'SUBJECT_TYPE EQUALS rootCa or endEntity returns the CA and the three seeds it issued', filters: () => [propertyFilter('SUBJECT_TYPE', 'EQUALS', ['rootCa', 'endEntity'])], expect: (m) => idsWhere(m, (c) => (c.ca && !c.issuedBy) || (!c.ca && !!c.issuedBy)), expectedIds: ids('C11', 'C12', 'C13', 'C24') },
    { row: 'L-6a', title: 'SIGNATURE_ALGORITHM EQUALS the catalogue value for SHA-384 returns the one SHA-384 seed', filters: (_m, ctx) => [propertyFilter('SIGNATURE_ALGORITHM', 'EQUALS', [ctx.signatureSha384 ?? ''])], expect: (m) => idsWhere(m, (c) => c.hash === 'SHA-384'), expectedIds: ids('C09') },
    { row: 'L-6b', title: 'SIGNATURE_ALGORITHM EQUALS the catalogue value for SHA-512 returns the one SHA-512 seed', filters: (_m, ctx) => [propertyFilter('SIGNATURE_ALGORITHM', 'EQUALS', [ctx.signatureSha512 ?? ''])], expect: (m) => idsWhere(m, (c) => c.hash === 'SHA-512'), expectedIds: ids('C10') },
    { row: 'L-7', title: 'ISSUER_COMMON_NAME EQUALS the run\'s CA name returns the CA and the three seeds it issued', filters: (m) => [propertyFilter('ISSUER_COMMON_NAME', 'EQUALS', P(m, 'ca-root'))], expect: (m) => idsWhere(m, (c) => c.id === 'C24' || c.issuedBy === 'C24'), expectedIds: ids('C11', 'C12', 'C13', 'C24') },
    { row: 'L-8', title: 'PUBLIC_KEY_ALGORITHM EQUALS the catalogue value for RSA returns all 24 seeds', filters: (_m, ctx) => [propertyFilter('PUBLIC_KEY_ALGORITHM', 'EQUALS', [ctx.rsa ?? ''])], expect: ALL, expectedIds: 24 },
];

/** L-4: a condition the field does not advertise: 422 with the exact text. */
export const LIST_REFUSALS: ReadonlyArray<{ row: string; filter: Filter; text: RegExp }> = [
    {
        row: 'L-4',
        filter: propertyFilter('KEY_SIZE', 'GREATER', [2048]),
        text: /^Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY\.$/,
    },
];

// ------------------------------------------------------------------ Collection (groups) and owner (API-CERT-45)

const inGroup = (c: CertificateSeedEntry, g: 'a' | 'b'): boolean => c.groups.includes(g);
const gname = (m: CertificateSeedPlan, g: 'a' | 'b'): string => m.groups[g].name;

export const COLLECTION_ROWS: readonly FilterRow[] = [
    { row: 'G-1a', title: 'GROUP_NAME EQUALS the run\'s group a returns its six members', filters: (m) => [propertyFilter('GROUP_NAME', 'EQUALS', [gname(m, 'a')])], expect: (m) => idsWhere(m, (c) => inGroup(c, 'a')), expectedIds: 6 },
    { row: 'G-1b', title: 'GROUP_NAME NOT_EQUALS group a returns the 18 others, seeds without a group included', filters: (m) => [propertyFilter('GROUP_NAME', 'NOT_EQUALS', [gname(m, 'a')])], expect: (m) => idsWhere(m, (c) => !inGroup(c, 'a')), expectedIds: 18 },
    { row: 'G-2a', title: 'GROUP_NAME EQUALS group a or b returns the eight seeds in either group', filters: (m) => [propertyFilter('GROUP_NAME', 'EQUALS', [gname(m, 'a'), gname(m, 'b')])], expect: (m) => idsWhere(m, (c) => inGroup(c, 'a') || inGroup(c, 'b')), expectedIds: 8 },
    { row: 'G-2b', title: 'GROUP_NAME NOT_EQUALS group a or b returns the 16 seeds in neither group', filters: (m) => [propertyFilter('GROUP_NAME', 'NOT_EQUALS', [gname(m, 'a'), gname(m, 'b')])], expect: (m) => idsWhere(m, (c) => !inGroup(c, 'a') && !inGroup(c, 'b')), expectedIds: 16 },
    { row: 'G-3a', title: 'GROUP_NAME EMPTY returns the 16 seeds without a group', filters: () => [propertyFilter('GROUP_NAME', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.groups.length === 0), expectedIds: 16 },
    { row: 'G-3b', title: 'GROUP_NAME NOT_EMPTY returns the eight seeds that have a group', filters: () => [propertyFilter('GROUP_NAME', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.groups.length > 0), expectedIds: 8 },
    { row: 'G-4a', title: 'GROUP_NAME COUNT_EQUAL 2 returns the two seeds in both groups', filters: () => [propertyFilter('GROUP_NAME', 'COUNT_EQUAL', 2)], expect: (m) => idsWhere(m, (c) => c.groups.length === 2), expectedIds: ids('C03', 'C04') },
    { row: 'G-4b', title: 'GROUP_NAME COUNT_GREATER_THAN 1 returns the two seeds in both groups', filters: () => [propertyFilter('GROUP_NAME', 'COUNT_GREATER_THAN', 1)], expect: (m) => idsWhere(m, (c) => c.groups.length > 1), expectedIds: ids('C03', 'C04') },
    { row: 'G-4c', title: 'GROUP_NAME COUNT_LESS_THAN 1 returns the 16 seeds without a group', filters: () => [propertyFilter('GROUP_NAME', 'COUNT_LESS_THAN', 1)], expect: (m) => idsWhere(m, (c) => c.groups.length < 1), expectedIds: 16 },
    { row: 'G-4d', title: 'GROUP_NAME COUNT_NOT_EQUAL 0 returns the eight seeds that have a group', filters: () => [propertyFilter('GROUP_NAME', 'COUNT_NOT_EQUAL', 0)], expect: (m) => idsWhere(m, (c) => c.groups.length !== 0), expectedIds: 8 },
    // Other collection fields: no seed has a location or a predecessor / successor.
    { row: 'G-6a', title: 'CERT_LOCATION_NAME EMPTY returns all 24 seeds, none is in a location', filters: () => [propertyFilter('CERT_LOCATION_NAME', 'EMPTY')], expect: ALL, expectedIds: 24 },
    { row: 'G-6b', title: 'PRECEDING_CERTIFICATES COUNT_EQUAL 0 returns all 24 seeds', filters: () => [propertyFilter('PRECEDING_CERTIFICATES', 'COUNT_EQUAL', 0)], expect: ALL, expectedIds: 24 },
    { row: 'G-6c', title: 'SUCCEEDING_CERTIFICATES COUNT_GREATER_THAN 0 returns no seed', filters: () => [propertyFilter('SUCCEEDING_CERTIFICATES', 'COUNT_GREATER_THAN', 0)], expect: () => [], expectedIds: 0 },
    { row: 'O-1a', title: 'OWNER EMPTY returns the 22 seeds without an owner', filters: () => [propertyFilter('OWNER', 'EMPTY')], expect: (m) => idsWhere(m, (c) => !c.owner), expectedIds: 22 },
    { row: 'O-1b', title: 'OWNER NOT_EMPTY returns the two seeds with an owner', filters: () => [propertyFilter('OWNER', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.owner), expectedIds: 2 },
    { row: 'O-3', title: 'RA_PROFILE_NAME EMPTY returns all 24 seeds, none has an RA profile', filters: () => [propertyFilter('RA_PROFILE_NAME', 'EMPTY')], expect: ALL, expectedIds: 24 },
];

/**
 * O-2 ("OWNER NOT_CONTAINS zzz vs NOT_MATCHES ^zzz — the documented null asymmetry") cannot run on OWNER: OWNER is a LIST field
 * (core FilterField.java, SearchFieldTypeEnum.LIST), whose conditions are EQUALS / NOT_EQUALS / EMPTY / NOT_EMPTY — the string
 * conditions are refused 422 "Field OWNER does not support the … condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY."
 * (FilterPredicatesBuilder.requireAdvertisedCondition). The asymmetry (NOT_CONTAINS includes null columns, NOT_MATCHES excludes them,
 * the filter rules) needs a nullable STRING property field no seed can set; it is not asserted.
 */
export const OWNER_REFUSALS: ReadonlyArray<{ row: string; condition: string; value: string }> = [
    { row: 'O-2a', condition: 'NOT_CONTAINS', value: 'zzz' },
    { row: 'O-2b', condition: 'NOT_MATCHES', value: '^zzz' },
    { row: 'O-2c', condition: 'CONTAINS', value: 'zzz' },
];

/**
 * COUNT_* conditions with a non-integer value. The intended answer is the same for all four conditions: 422 "Filter field value <v> cannot
 * be parsed as an Integer." (core's own FilterPredicatesBuilderITest expects a ValidationException for COUNT_EQUAL / COUNT_NOT_EQUAL too).
 * Today the GREATER / LESS rows are green because those conditions parse the value, while EQUAL / NOT_EQUAL hand it to the query unparsed
 * and answer 500 (known bug core#2562, so the COUNT_EQUAL and COUNT_NOT_EQUAL string rows carry `bug` and the test calls `test.fail()`
 * right before the failing step). The JSON-number row (1.5 on COUNT_EQUAL): the number is compared with the group count without conversion
 * and answers 500 as well; whatever the refusal text should be, a refusal is a 4xx and never a 5xx, so it asserts that (`anyRefusal`) and
 * has no text.
 */
export interface CountRefusal {
    row: string;
    condition: string;
    value: unknown;
    /** The refusal text for a 422; absent on an `anyRefusal` row. */
    text?: RegExp;
    /** The known bug (`<repo>#<n>`): the test is `test.fail()` before the failing step. */
    bug?: string;
    /** Asserts only "a 4xx, never a 5xx" (no text): the number case, whose refusal text is not specified. */
    anyRefusal?: true;
    /** The priority when it is not P1 (the number case was a P2 pin and stays in the P2 selection). */
    prio?: 'P2';
}

export const COUNT_REFUSALS: ReadonlyArray<CountRefusal> = [
    { row: 'G-5a', condition: 'COUNT_GREATER_THAN', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./ },
    { row: 'G-5b', condition: 'COUNT_GREATER_THAN', value: '1.5', text: /Filter field value 1\.5 cannot be parsed as an Integer\./ },
    { row: 'G-5c', condition: 'COUNT_LESS_THAN', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./ },
    { row: 'G-5d', condition: 'COUNT_EQUAL', value: 'x', text: /Filter field value x cannot be parsed as an Integer\./, bug: 'core#2562' },
    { row: 'G-5e', condition: 'COUNT_NOT_EQUAL', value: '1.5', text: /Filter field value 1\.5 cannot be parsed as an Integer\./, bug: 'core#2562' },
    { row: 'G-5f', condition: 'COUNT_EQUAL', value: 1.5, bug: 'core#2562', anyRefusal: true, prio: 'P2' },
];

/**
 * Pin: a negative JSON number (-1) on COUNT_EQUAL answers 200 with no seed today (no group count can equal it). Whether it
 * should become a 422 is open; the pin flips when core decides. (The non-whole 1.5 is the JSON-number row of `COUNT_REFUSALS`.)
 */
export const COUNT_PINS: ReadonlyArray<{ row: string; condition: string; value: number }> = [
    { row: 'G-5g', condition: 'COUNT_EQUAL', value: -1 },
];

// ------------------------------------------------------------------ Custom attributes (API-CERT-46, REG-CERT-44)

type AttrKey = 'txt' | 'num' | 'day' | 'flag' | 'pick';
const ca = (m: CertificateSeedPlan, key: AttrKey, condition: string, value?: unknown): Filter => customAttributeFilter(m.attributes[key].identifier, condition, value);
const txtOf = (c: CertificateSeedEntry): string | null => c.txt;

export const ATTRIBUTE_ROWS: readonly FilterRow[] = [
    { row: 'A-1a', title: 'a txt CONTAINS "red" filter returns the three seeds with red in the text', filters: (m) => [ca(m, 'txt', 'CONTAINS', 'red')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').includes('red')), expectedIds: ids('C01', 'C02', 'C06') },
    { row: 'A-1b', title: 'a txt NOT_CONTAINS "red" filter is case-sensitive and returns 21 seeds, empty ones included', filters: (m) => [ca(m, 'txt', 'NOT_CONTAINS', 'red')], expect: (m) => idsWhere(m, (c) => !(txtOf(c) ?? '').includes('red')), expectedIds: 21 },
    { row: 'A-2a', title: 'a txt EQUALS "red" filter returns the two seeds whose text is exactly red', filters: (m) => [ca(m, 'txt', 'EQUALS', 'red')], expect: (m) => idsWhere(m, (c) => c.txt === 'red'), expectedIds: ids('C01', 'C02') },
    { row: 'A-2b', title: 'a txt NOT_EQUALS "red" filter returns the other 22 seeds', filters: (m) => [ca(m, 'txt', 'NOT_EQUALS', 'red')], expect: (m) => idsWhere(m, (c) => c.txt !== 'red'), expectedIds: 22 },
    { row: 'A-3a', title: 'a txt STARTS_WITH "re" filter returns the three seeds whose text starts with re', filters: (m) => [ca(m, 'txt', 'STARTS_WITH', 're')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').startsWith('re')), expectedIds: ids('C01', 'C02', 'C06') },
    { row: 'A-3b', title: 'a txt ENDS_WITH "blue" filter returns the two seeds whose text ends with blue', filters: (m) => [ca(m, 'txt', 'ENDS_WITH', 'blue')], expect: (m) => idsWhere(m, (c) => (txtOf(c) ?? '').endsWith('blue')), expectedIds: ids('C05', 'C06') },
    { row: 'A-3c', title: 'a txt MATCHES "^re.*" filter returns the three seeds whose text starts with re', filters: (m) => [ca(m, 'txt', 'MATCHES', '^re.*')], expect: (m) => idsWhere(m, (c) => /^re.*/.test(txtOf(c) ?? '\u0000')), expectedIds: ids('C01', 'C02', 'C06') },
    { row: 'A-4a', title: 'a txt EMPTY filter returns the 17 seeds without a text value', filters: (m) => [ca(m, 'txt', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.txt === null), expectedIds: 17 },
    { row: 'A-4b', title: 'a txt NOT_EMPTY filter returns the seven seeds with a text value', filters: (m) => [ca(m, 'txt', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.txt !== null), expectedIds: 7 },
    { row: 'A-5a', title: 'a num EQUALS 30 filter returns the one seed with 30', filters: (m) => [ca(m, 'num', 'EQUALS', '30')], expect: (m) => idsWhere(m, (c) => c.num === 30), expectedIds: ids('C03') },
    { row: 'A-5b', title: 'a num EQUALS 0 filter returns the one seed with 0', filters: (m) => [ca(m, 'num', 'EQUALS', '0')], expect: (m) => idsWhere(m, (c) => c.num === 0), expectedIds: ids('C08') },
    { row: 'A-5c', title: 'a num EQUALS -5 filter returns the one seed with -5', filters: (m) => [ca(m, 'num', 'EQUALS', '-5')], expect: (m) => idsWhere(m, (c) => c.num === -5), expectedIds: ids('C07') },
    { row: 'A-5d', title: 'a num NOT_EQUALS 30 filter returns the other 23 seeds', filters: (m) => [ca(m, 'num', 'NOT_EQUALS', '30')], expect: (m) => idsWhere(m, (c) => c.num !== 30), expectedIds: 23 },
    { row: 'A-6a', title: 'a num GREATER 60 filter returns the two seeds above 60', filters: (m) => [ca(m, 'num', 'GREATER', '60')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num > 60), expectedIds: ids('C09', 'C10') },
    { row: 'A-6b', title: 'a num GREATER_OR_EQUAL 60 filter returns the three seeds from 60 up', filters: (m) => [ca(m, 'num', 'GREATER_OR_EQUAL', '60')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num >= 60), expectedIds: ids('C06', 'C09', 'C10') },
    { row: 'A-6c', title: 'a num LESSER 0 filter returns the one negative seed', filters: (m) => [ca(m, 'num', 'LESSER', '0')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num < 0), expectedIds: ids('C07') },
    { row: 'A-6d', title: 'a num LESSER_OR_EQUAL 0 filter returns the two seeds at or below 0', filters: (m) => [ca(m, 'num', 'LESSER_OR_EQUAL', '0')], expect: (m) => idsWhere(m, (c) => c.num !== null && c.num <= 0), expectedIds: ids('C07', 'C08') },
    { row: 'A-7a', title: 'a num EMPTY filter returns the 14 seeds without a number', filters: (m) => [ca(m, 'num', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.num === null), expectedIds: 14 },
    { row: 'A-7b', title: 'a num NOT_EMPTY filter returns the ten seeds with a number', filters: (m) => [ca(m, 'num', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.num !== null), expectedIds: 10 },
    { row: 'A-8a', title: 'a day EQUALS filter on one seed\'s date returns the two seeds on that date', filters: (m) => [ca(m, 'day', 'EQUALS', dayOf(m, 'C03'))], expect: (m) => idsWhere(m, (c) => c.day === dayOf(m, 'C03')), expectedIds: ids('C03', 'C04') },
    { row: 'A-8b', title: 'a day GREATER filter on an earlier seed\'s date returns the three seeds after it', filters: (m) => [ca(m, 'day', 'GREATER', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day > dayOf(m, 'C02')), expectedIds: ids('C03', 'C04', 'C05') },
    { row: 'A-8c', title: 'a day GREATER_OR_EQUAL filter on the 20 February date returns the four seeds from that date on', filters: (m) => [ca(m, 'day', 'GREATER_OR_EQUAL', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day >= dayOf(m, 'C02')), expectedIds: ids('C02', 'C03', 'C04', 'C05') },
    { row: 'A-8d', title: 'a day LESSER filter on the 20 February date returns the one seed before that date', filters: (m) => [ca(m, 'day', 'LESSER', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day < dayOf(m, 'C02')), expectedIds: ids('C01') },
    { row: 'A-8e', title: 'a day LESSER_OR_EQUAL filter on the 20 February date returns its seed and the one before it', filters: (m) => [ca(m, 'day', 'LESSER_OR_EQUAL', dayOf(m, 'C02'))], expect: (m) => idsWhere(m, (c) => c.day !== null && c.day <= dayOf(m, 'C02')), expectedIds: ids('C01', 'C02') },
    { row: 'A-9a', title: 'a day NOT_EQUALS filter on one seed\'s date returns the other 22 seeds', filters: (m) => [ca(m, 'day', 'NOT_EQUALS', dayOf(m, 'C03'))], expect: (m) => idsWhere(m, (c) => c.day !== dayOf(m, 'C03')), expectedIds: 22 },
    { row: 'A-9b', title: 'a day EMPTY filter returns the 19 seeds without a date', filters: (m) => [ca(m, 'day', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.day === null), expectedIds: 19 },
    { row: 'A-9c', title: 'a day NOT_EMPTY filter returns the five seeds with a date', filters: (m) => [ca(m, 'day', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.day !== null), expectedIds: 5 },
    { row: 'A-9d', title: 'a day IN_NEXT P36500D filter returns all five dated seeds, all in the future', filters: (m) => [ca(m, 'day', 'IN_NEXT', 'P36500D')], expect: (m) => idsWhere(m, (c) => c.day !== null), expectedIds: 5 },
    { row: 'A-9e', title: 'a day IN_PAST P36500D filter returns no seed', filters: (m) => [ca(m, 'day', 'IN_PAST', 'P36500D')], expect: () => [], expectedIds: 0 },
    { row: 'A-10a', title: 'a flag EQUALS true filter returns the three seeds flagged true', filters: (m) => [ca(m, 'flag', 'EQUALS', true)], expect: (m) => idsWhere(m, (c) => c.flag === true), expectedIds: ids('C01', 'C02', 'C05') },
    { row: 'A-10b', title: 'a flag EQUALS false filter returns the two seeds flagged false', filters: (m) => [ca(m, 'flag', 'EQUALS', false)], expect: (m) => idsWhere(m, (c) => c.flag === false), expectedIds: ids('C03', 'C04') },
    { row: 'A-10c', title: 'a flag NOT_EQUALS true filter returns the other 21 seeds, those without a flag included', filters: (m) => [ca(m, 'flag', 'NOT_EQUALS', true)], expect: (m) => idsWhere(m, (c) => c.flag !== true), expectedIds: 21 },
    { row: 'A-10d', title: 'a flag EMPTY filter returns the 19 seeds without a flag', filters: (m) => [ca(m, 'flag', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.flag === null), expectedIds: 19 },
    { row: 'A-11a', title: 'a pick EQUALS "a" filter returns the three seeds that picked a', filters: (m) => [ca(m, 'pick', 'EQUALS', ['a'])], expect: (m) => idsWhere(m, (c) => !!c.pick?.includes('a')), expectedIds: ids('C01', 'C02', 'C05') },
    { row: 'A-11b', title: 'a pick EQUALS "b" or "c" filter returns the four seeds that picked b or c', filters: (m) => [ca(m, 'pick', 'EQUALS', ['b', 'c'])], expect: (m) => idsWhere(m, (c) => !!c.pick?.some((p) => p === 'b' || p === 'c')), expectedIds: ids('C02', 'C03', 'C04', 'C05') },
    { row: 'A-12a', title: 'a pick NOT_EQUALS "a" filter returns the 21 others, seeds without a value included', filters: (m) => [ca(m, 'pick', 'NOT_EQUALS', ['a'])], expect: (m) => idsWhere(m, (c) => !c.pick?.includes('a')), expectedIds: 21 },
    { row: 'A-12b', title: 'a pick NOT_EQUALS "a" or "b" filter returns the 20 seeds that picked neither', filters: (m) => [ca(m, 'pick', 'NOT_EQUALS', ['a', 'b'])], expect: (m) => idsWhere(m, (c) => !c.pick?.some((p) => p === 'a' || p === 'b')), expectedIds: 20 },
    { row: 'A-12c', title: 'a pick EMPTY filter returns only the 19 seeds without a value', filters: (m) => [ca(m, 'pick', 'EMPTY')], expect: (m) => idsWhere(m, (c) => c.pick === null), expectedIds: 19 },
    { row: 'A-12d', title: 'a pick NOT_EMPTY filter returns the five seeds with a value', filters: (m) => [ca(m, 'pick', 'NOT_EMPTY')], expect: (m) => idsWhere(m, (c) => c.pick !== null), expectedIds: 5 },
];

const dayOf = (m: CertificateSeedPlan, id: CertId): string => {
    const d = m.certificates.find((c) => c.id === id)!.day;
    if (!d) throw new Error(`${id} has no day value`);
    return d;
};

/** Attribute-filter edges. The first is a 422, the second 200 with no rows, the third is accepted today (pinned). */
export const ATTRIBUTE_EDGES = {
    withoutSuffix: (m: CertificateSeedPlan): Filter => customAttributeFilter(m.attributes.txt.name, 'CONTAINS', 'red'),
    withoutSuffixText: (m: CertificateSeedPlan): RegExp => new RegExp(`^Filter field identifier ${escapeRegExp(m.attributes.txt.name)} does not name an attribute\\.$`),
    unknown: (): Filter => customAttributeFilter('qa-no-such-attribute|STRING', 'EQUALS', 'x'),
};

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
 * The sort key of a seed for a field and direction, or null (rows without a value sort LAST in both directions).
 * A multi-valued field sorts by its smallest value ascending and its largest descending.
 */
export function sortKey(m: CertificateSeedPlan, c: CertificateSeedEntry, field: SortField, dir: 'asc' | 'desc'): string | number | null {
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
 * the first observation (the uuid tie-break): compare group by group, as sets, and check stability separately.
 */
export function expectedOrderGroups(m: CertificateSeedPlan, field: SortField, dir: 'asc' | 'desc'): CertId[][] {
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
 * tie-break is `asc` whatever the sort direction (core SortOrderBuilder.tieBreak: `criteriaBuilder.asc(uuid)`;
 * "ordered nulls last in both directions, then by uuid", core#2394) — answered from the code. Postgres
 * orders uuids bytewise, which for lower-case canonical text equals string comparison.
 */
export function expectedUuidOrder(m: Omit<CertificateSeedPlan, 'certificates'> & { certificates: Array<CertificateSeedEntry & { uuid: string }> }, field: SortField, dir: 'asc' | 'desc'): string[] {
    const uuidOf = new Map<CertId, string>(m.certificates.map((c) => [c.id, c.uuid] as [CertId, string]));
    return expectedOrderGroups(m as CertificateSeedPlan, field, dir).flatMap((g) => g.map((id) => uuidOf.get(id)!).sort());
}

/**
 * Does an actual id sequence follow the groups (each group's members contiguous, in group order, as sets)? Returns the problem or
 * undefined.
 */
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
