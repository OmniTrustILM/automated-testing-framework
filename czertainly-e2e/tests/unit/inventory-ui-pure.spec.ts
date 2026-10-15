/**
 * Offline checks of the pure parts of the inventory UI page objects (ui-inventory agent): label maps, badge text, wire value
 * comparison, the display formatters (`formatDateTime`, `formatForDisplay`, forbidden words) and the platform labels. The date
 * formatter is also compared with the BROWSER's own local getters (the FE rule `dateFormatter`, utils/dateUtil.ts:41-57) in zones
 * that differ from the runner's.
 */
import { expect, request, test } from '@playwright/test';
import { guardApiForUnitTests } from '../../utils/regression/guardedApi';
import {
    PlatformLabels,
    badgeTextOf,
    expectedBadgeText,
    expectedFieldLabels,
    fieldLabelMap,
    filtersDifference,
    valueOptionLabel,
    wireValue,
} from '../../pages/FilterWidget';
import { DisplayContext, FORBIDDEN_RENDERED, STANDARD_COLUMNS, forbiddenWordIn, formatDateTime, formatForDisplay } from '../../pages/InventoryPage';
import { FAKE_ENUMS, fakeData } from './inventory-ui-app';

const labels = new PlatformLabels(FAKE_ENUMS as never);

test.describe('field labels and badge text', () => {
    const fields = [
        { fieldIdentifier: 'A|DATE', fieldLabel: 'Expiry', conditions: ['EQUALS'], attributeContentType: 'date' },
        { fieldIdentifier: 'B|STRING', fieldLabel: 'EXPIRY', conditions: ['EQUALS'], attributeContentType: 'string' },
        { fieldIdentifier: 'C|STRING', fieldLabel: 'Expiry', conditions: ['EQUALS'], attributeContentType: 'string' },
        { fieldIdentifier: 'D', fieldLabel: 'Only ordering', conditions: [] },
        { fieldIdentifier: 'E', fieldLabel: 'Unique', conditions: ['EQUALS'] },
    ];
    const typeLabel = (code: string): string => (code === 'date' ? 'Date' : 'Text');

    test('duplicate labels get the content type, labels still shared get the identifier, fields without conditions are left out (FilterWidget/index.tsx:82-108, 255-263)', () => {
        const map = fieldLabelMap(fields, typeLabel);
        expect(map.get('A|DATE')).toBe('Expiry (Date)');
        expect(map.get('B|STRING')).toBe('EXPIRY (Text) — B|STRING');
        expect(map.get('C|STRING')).toBe('Expiry (Text) — C|STRING');
        expect(map.get('E')).toBe('Unique');
        expect(expectedFieldLabels(fields, typeLabel)).toEqual(['Expiry (Date)', 'EXPIRY (Text) — B|STRING', 'Expiry (Text) — C|STRING', 'Unique']);
    });

    test('expectedBadgeText: lists join with OR, no value is an empty pair of quotes', () => {
        expect(expectedBadgeText({ source: 'Property', field: 'Common Name', condition: 'contains', value: 'web' })).toBe("Property 'Common Name' contains 'web'");
        expect(expectedBadgeText({ source: 'Property', field: 'Subject Type', condition: 'equals', value: ['Root CA', 'End Entity'] })).toBe("Property 'Subject Type' equals 'Root CA OR End Entity'");
        expect(expectedBadgeText({ source: 'Property', field: 'Expires At', condition: 'empty' })).toBe("Property 'Expires At' empty ''");
    });

    test('badgeTextOf: non-breaking spaces become spaces and the inner Remove badge text is dropped', () => {
        expect(badgeTextOf("Property 'Common Name' contains 'x'Remove badge")).toBe("Property 'Common Name' contains 'x'");
        expect(badgeTextOf("Property 'Common Name' contains 'x' Remove badge")).toBe("Property 'Common Name' contains 'x'");
    });

    test('valueOptionLabel: enum label, group name, plain value', () => {
        expect(valueOptionLabel(labels, { platformEnum: 'CertificateSubjectType' }, 'rootCa')).toBe('Root CA');
        expect(valueOptionLabel(labels, {}, { uuid: 'u', name: 'grp-a' })).toBe('grp-a');
        expect(valueOptionLabel(labels, {}, 3072)).toBe('3072');
    });
});

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

test.describe('platform labels', () => {
    test('label / display / condition / source; an unknown item is an error for label() and the code itself for display() (getEnumLabel)', () => {
        expect(labels.condition('STARTS_WITH')).toBe('starts with');
        expect(labels.source('custom')).toBe('Custom attribute');
        expect(labels.label('CertificateState', 'issued')).toBe('Issued');
        expect(labels.display('CertificateState', 'weird')).toBe('weird');
        expect(labels.display('NoSuchEnum', 'x')).toBe('x');
        expect(() => labels.label('CertificateState', 'weird')).toThrow(/no item "weird"/);
    });

    test('read(): one GET /api/v1/enums, a non-200 is an error', async () => {
        const calls: string[] = [];
        const ok = { get: async (url: string) => (calls.push(url), { ok: () => true, status: () => 200, json: async () => FAKE_ENUMS }) };
        expect((await PlatformLabels.read(ok as never)).condition('EQUALS')).toBe('equals');
        expect(calls).toEqual(['/api/v1/enums']);
        const bad = { get: async () => ({ ok: () => false, status: () => 401, json: async () => ({}) }) };
        await expect(PlatformLabels.read(bad as never)).rejects.toThrow(/answered 401/);
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
        const cell = (column: string, r = owned) => formatForDisplay(column, r, ctx);
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
        expect(formatForDisplay('property:COMMON_NAME', blank, ctx)).toEqual({ text: '(empty)' });
        expect(formatForDisplay('property:SERIAL_NUMBER', blank, ctx)).toEqual({ empty: true });
        expect(formatForDisplay('property:ISSUER_COMMON_NAME', blank, ctx)).toEqual({ empty: true });
        expect(formatForDisplay('property:NOT_AFTER', blank, ctx)).toEqual({ empty: true });
        expect(formatForDisplay('property:GROUP_NAME', blank, ctx)).toEqual({ empty: true });
        expect(formatForDisplay('property:ARCHIVED', blank, ctx)).toEqual({ text: 'Yes' });
        expect(() => formatForDisplay('property:NOPE', blank, ctx)).toThrow(/no display rule/);
        for (const column of STANDARD_COLUMNS) expect(() => formatForDisplay(column.id, blank, ctx), column.id).not.toThrow();
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

test.describe('guard: the only requests the UI rows send through the api fixture are plain GETs', () => {
    test('GET /api/v1/enums and GET /api/v1/certificates/search pass the guard (nothing is sent: api.check judges only); the list search the UI itself sends is the browser\'s', async () => {
        const raw = await request.newContext({ baseURL: 'http://127.0.0.1:9/administrator/' });
        try {
            const guarded = guardApiForUnitTests(raw, { lines: [], runId: 'qa-reg-20261014-130000-cd34', tier: null, env: { BASE_URL: 'http://127.0.0.1:9/administrator/' } });
            await guarded.check('GET', '/api/v1/enums');
            await guarded.check('GET', '/api/v1/certificates/search');
            await guarded.check('POST', '/api/v1/certificates', { filters: [], itemsPerPage: 10, pageNumber: 1 }); // the API-side oracle search of the rows (POST_READ)
        } finally {
            await raw.dispose();
        }
    });
});
