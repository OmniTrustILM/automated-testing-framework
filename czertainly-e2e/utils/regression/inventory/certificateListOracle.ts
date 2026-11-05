/**
 * certificateListOracle — what the certificate list must show and send,
 * computed from the admin UI's display rules, never from what the page shows.
 */
import type { PlatformLabels } from './fieldLabels';
import { JsonObject } from '../json';
import { objectOf } from '../json';


export const STANDARD_COLUMNS: ReadonlyArray<{ id: string; heading: string }> = [
    { id: 'property:CERTIFICATE_STATE', heading: 'State' },
    { id: 'property:CERTIFICATE_VALIDATION_STATUS', heading: 'Validation' },
    { id: 'property:COMPLIANCE_STATUS', heading: 'Compliance' },
    { id: 'property:PRIVATE_KEY', heading: 'Has private key' },
    { id: 'property:COMMON_NAME', heading: 'Common Name' },
    { id: 'property:NOT_BEFORE', heading: 'Valid From' },
    { id: 'property:NOT_AFTER', heading: 'Expires At' },
    { id: 'property:GROUP_NAME', heading: 'Groups' },
    { id: 'property:RA_PROFILE_NAME', heading: 'RA Profile' },
    { id: 'property:OWNER', heading: 'Owner' },
    { id: 'property:SERIAL_NUMBER', heading: 'Serial number' },
    { id: 'property:SIGNATURE_ALGORITHM', heading: 'Signature Algorithm' },
    { id: 'property:PUBLIC_KEY_ALGORITHM', heading: 'Public Key Algorithm' },
    { id: 'property:ISSUER_COMMON_NAME', heading: 'Issuer Common Name' },
    { id: 'property:CERTIFICATE_TYPE', heading: 'Certificate Type' },
    { id: 'property:ARCHIVED', heading: 'Archived' },
];

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** `yyyy-MM-dd HH:mm:ss` in a time zone (the list formats with the browser's local getters, so the test passes the browser's zone). */
export function formatDateTime(iso: string, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(iso));
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export interface DisplayContext {
    timeZone: string;
    labels: PlatformLabels;
}

export type CellExpectation = { text: string } | { empty: true } | { contains: string[] };

/** The expected cell of a Standard column for a list row, derived from the display rules; a blank value renders the empty state. */
export function expectedCell(columnId: string, row: JsonObject, ctx: DisplayContext): CellExpectation {
    const text = (value: unknown): CellExpectation => (value === null || value === undefined || value === '' ? { empty: true } : { text: String(value) });
    switch (columnId) {
        case 'property:CERTIFICATE_STATE':
            return text(row.state ? capitalize(ctx.labels.display('CertificateState', String(row.state))) : undefined);
        case 'property:CERTIFICATE_VALIDATION_STATUS':
            return text(row.validationStatus ? capitalize(ctx.labels.display('CertificateValidationStatus', String(row.validationStatus))) : undefined);
        case 'property:COMPLIANCE_STATUS':
            return text(row.complianceStatus ? capitalize(ctx.labels.display('ComplianceStatus', String(row.complianceStatus))) : undefined);
        // The key icon with the sr-only text, or the empty state when no private key is available; never a "No" badge.
        case 'property:PRIVATE_KEY':
            return row.privateKeyAvailability ? { text: 'Private key available' } : { empty: true };
        case 'property:COMMON_NAME':
            return { text: String(row.commonName || '(empty)') };
        case 'property:NOT_BEFORE':
            return row.notBefore ? { text: formatDateTime(String(row.notBefore), ctx.timeZone) } : { empty: true };
        case 'property:NOT_AFTER':
            return row.notAfter ? { text: formatDateTime(String(row.notAfter), ctx.timeZone) } : { empty: true };
        case 'property:GROUP_NAME': {
            const groups = (row.groups ?? []) as Array<{ name?: string }>;
            if (groups.length === 0) return { empty: true };
            return groups.length === 1 ? { text: String(groups[0].name) } : { contains: [String(groups[0].name), `+${groups.length - 1}`] };
        }
        case 'property:RA_PROFILE_NAME':
            return row.raProfile ? { text: String(objectOf(row.raProfile).name ?? 'Unassigned') } : { empty: true };
        case 'property:OWNER':
            return text(row.owner);
        case 'property:SERIAL_NUMBER':
            return text(row.serialNumber);
        case 'property:SIGNATURE_ALGORITHM':
            return text(row.signatureAlgorithm);
        case 'property:PUBLIC_KEY_ALGORITHM':
            return text(row.publicKeyAlgorithm);
        case 'property:ISSUER_COMMON_NAME':
            return text(row.issuerCommonName);
        case 'property:CERTIFICATE_TYPE':
            return text(row.certificateType ? ctx.labels.display('CertificateType', String(row.certificateType)) : undefined);
        case 'property:ARCHIVED':
            return { text: row.archived ? 'Yes' : 'No' };
        default:
            throw new Error(`no display rule for column ${columnId}`);
    }
}

export const FORBIDDEN_RENDERED = /\b(?:null|undefined|NaN)\b|Invalid Date/;

export function forbiddenWordIn(text: string): string | undefined {
    const m = FORBIDDEN_RENDERED.exec(text);
    return m ? text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20) : undefined;
}


export function wireValue(value: unknown): undefined | string | string[] {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value.map((v) => String(v)) : String(value);
}

/**
 * The filters of an observed list request against the expected ones (arrays
 * item by item, numbers as text); returns the first difference or undefined.
 */
export function filtersDifference(actual: readonly JsonObject[] | undefined, expected: readonly JsonObject[]): string | undefined {
    const got = actual ?? [];
    if (got.length !== expected.length) return `${got.length} filter(s) sent, ${expected.length} expected: ${JSON.stringify(got)}`;
    for (const [i, want] of expected.entries()) {
        const have = got[i];
        for (const key of ['fieldSource', 'fieldIdentifier', 'condition'] as const) {
            if (have[key] !== want[key]) return `filter ${i + 1}: ${key} ${JSON.stringify(have[key])}, expected ${JSON.stringify(want[key])}`;
        }
        const a = JSON.stringify(wireValue(have.value));
        const b = JSON.stringify(wireValue(want.value));
        if (a !== b) return `filter ${i + 1}: value ${JSON.stringify(have.value)}, expected ${JSON.stringify(want.value)}`;
        if (want.value === undefined && 'value' in have) return `filter ${i + 1}: a value key was sent for a value-less condition`;
    }
    return undefined;
}
