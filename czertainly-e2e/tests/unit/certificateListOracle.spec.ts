/**
 * Unit tests of utils/regression/inventory/certificateListOracle.ts: the comparison of the request a filter sends,
 * and the display formatters of the certificate list (dates in the browser time zone, cell text, forbidden words).
 */
import { expect, test } from '@playwright/test';
import { PlatformLabels } from '../../utils/regression/inventory/fieldLabels';
import { filtersDifference, wireValue } from '../../utils/regression/inventory/certificateListOracle';
import { DisplayContext, FORBIDDEN_RENDERED, STANDARD_COLUMNS, forbiddenWordIn, formatDateTime, expectedCell } from '../../utils/regression/inventory/certificateListOracle';
import { FAKE_ENUMS, fakeData } from './helpers/fakeCertificateListApp';

const labels = new PlatformLabels(FAKE_ENUMS as never);

test.describe('request comparison', () => {
    const base = { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'CONTAINS', value: 'web' };

    test('wireValue: undefined stays, arrays item by item, numbers as text', () => {
        expect(wireValue(undefined)).toBeUndefined();
        expect(wireValue(null)).toBeUndefined();
        expect(wireValue([3072, 'a'])).toEqual(['3072', 'a']);
        expect(wireValue(60)).toBe('60');
    });

    test('filtersDifference: equal, and every kind of difference is named', () => {
        expect(filtersDifference([base], [base])).toBeUndefined();
        expect(filtersDifference([{ ...base, value: [3072] }], [{ ...base, value: ['3072'] }])).toBeUndefined();
        expect(filtersDifference(undefined, [base])).toMatch(/0 filter\(s\) sent, 1 expected/);
        expect(filtersDifference([{ ...base, condition: 'EQUALS' }], [base])).toMatch(/condition "EQUALS", expected "CONTAINS"/);
        expect(filtersDifference([{ ...base, value: 'api' }], [base])).toMatch(/value "api", expected "web"/);
        expect(filtersDifference([{ ...base, value: ['a', 'b'] }], [{ ...base, value: ['b', 'a'] }]), 'the order of a multi-select is the order of the picks').toMatch(/value/);
        const empty = { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EMPTY' };
        expect(filtersDifference([empty], [empty])).toBeUndefined();
        expect(filtersDifference([{ ...empty, value: null }], [empty])).toMatch(/a value key was sent/);
    });
});

test.describe('display formatters', () => {
    test('formatDateTime: yyyy-MM-dd HH:mm:ss in the zone, midnight is 00 (not 24)', () => {
        expect(formatDateTime('2026-10-14T10:00:00.000Z', 'UTC')).toBe('2026-10-14 10:00:00');
        expect(formatDateTime('2026-10-14T22:30:05.999Z', 'Europe/Prague')).toBe('2026-10-15 00:30:05');
        expect(formatDateTime('2026-01-01T00:00:00Z', 'UTC')).toBe('2026-01-01 00:00:00');
        expect(formatDateTime('2026-03-29T01:30:00Z', 'Europe/Prague')).toBe('2026-03-29 03:30:00'); // DST gap
    });

    test('formatDateTime equals the browser\'s local getters (the FE dateFormatter) in zones other than the runner\'s', async ({ browser }) => {
        const instants = ['2026-10-14T10:00:00Z', '2026-03-29T01:30:00Z', '2026-10-25T00:30:00Z', '2027-01-01T00:00:00Z', '2026-06-30T23:59:59Z', '2026-12-31T23:00:00Z'];
        for (const timeZone of ['UTC', 'Europe/Prague', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
            const context = await browser.newContext({ timezoneId: timeZone });
            try {
                const page = await context.newPage();
                const fromBrowser = await page.evaluate((list) => {
                    const pad = (n: number): string => ('0' + n).slice(-2);
                    return list.map((iso) => {
                        const d = new Date(iso); // utils/dateUtil.ts:41-57
                        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                    });
                }, instants);
                expect(instants.map((iso) => formatDateTime(iso, timeZone)), timeZone).toEqual(fromBrowser);
            } finally {
                await context.close();
            }
        }
    });

    const data = fakeData();
    const ctx: DisplayContext = { timeZone: 'UTC', labels };
    const row = (id: string) => data.rows.find((r) => r.commonName.endsWith(data.plan.certificates.find((c) => c.id === id)!.token))!;

    test('formatForDisplay: the 16 Standard columns of a grouped, owned and an ungrouped, ownerless certificate', () => {
        const owned = row('C01');
        const cell = (column: string, r = owned) => expectedCell(column, r, ctx);
        expect(cell('property:CERTIFICATE_STATE')).toEqual({ text: 'Issued' });
        expect(cell('property:CERTIFICATE_VALIDATION_STATUS')).toEqual({ text: 'Valid' });
        expect(cell('property:COMPLIANCE_STATUS')).toEqual({ text: 'Not checked' });
        expect(cell('property:PRIVATE_KEY'), 'no private key = the empty state, never a "No" badge').toEqual({ empty: true });
        expect(cell('property:COMMON_NAME')).toEqual({ text: owned.commonName });
        expect(cell('property:NOT_AFTER')).toEqual({ text: formatDateTime(String(owned.notAfter), 'UTC') });
        expect(cell('property:GROUP_NAME')).toEqual({ text: data.plan.groups.a.name });
        expect(cell('property:RA_PROFILE_NAME')).toEqual({ empty: true });
        expect(cell('property:OWNER')).toEqual({ text: data.plan.owner.username });
        expect(cell('property:SIGNATURE_ALGORITHM')).toEqual({ text: 'SHA256withRSA' });
        expect(cell('property:CERTIFICATE_TYPE')).toEqual({ text: 'X509' });
        expect(cell('property:ARCHIVED')).toEqual({ text: 'No' });
        const two = row('C03');
        expect(cell('property:GROUP_NAME', two)).toEqual({ contains: [data.plan.groups.a.name, '+1'] });
        const plain = row('C09'); // ungrouped, ownerless
        expect(cell('property:OWNER', plain)).toEqual({ empty: true });
        expect(cell('property:GROUP_NAME', plain)).toEqual({ empty: true });
        expect(cell('property:GROUP_NAME', row('C08')), 'one group: the name alone').toEqual({ text: data.plan.groups.b.name });
    });

    test('formatForDisplay: blank values are the empty state, an unknown column is an error, every Standard column has a rule', () => {
        const blank = { commonName: '', serialNumber: null, issuerCommonName: undefined, groups: [], notAfter: null, state: 'issued', validationStatus: 'valid', archived: true };
        expect(expectedCell('property:COMMON_NAME', blank, ctx)).toEqual({ text: '(empty)' });
        expect(expectedCell('property:SERIAL_NUMBER', blank, ctx)).toEqual({ empty: true });
        expect(expectedCell('property:ISSUER_COMMON_NAME', blank, ctx)).toEqual({ empty: true });
        expect(expectedCell('property:NOT_AFTER', blank, ctx)).toEqual({ empty: true });
        expect(expectedCell('property:GROUP_NAME', blank, ctx)).toEqual({ empty: true });
        expect(expectedCell('property:ARCHIVED', blank, ctx)).toEqual({ text: 'Yes' });
        expect(() => expectedCell('property:NOPE', blank, ctx)).toThrow(/no display rule/);
        for (const column of STANDARD_COLUMNS) expect(() => expectedCell(column.id, blank, ctx), column.id).not.toThrow();
    });

    test('forbidden words: null, undefined, NaN, Invalid Date as words; not inside other words', () => {
        expect(forbiddenWordIn('a null b')).toContain('null');
        expect(forbiddenWordIn('x undefined')).toContain('undefined');
        expect(forbiddenWordIn('NaN')).toBe('NaN');
        expect(forbiddenWordIn('2026-01-01 Invalid Date')).toContain('Invalid Date');
        expect(forbiddenWordIn('nullable annulled Nancy nan')).toBeUndefined();
        expect(FORBIDDEN_RENDERED.test('Issued No value')).toBe(false);
    });
});
