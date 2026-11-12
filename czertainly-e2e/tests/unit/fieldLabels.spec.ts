/**
 * Unit tests of utils/regression/inventory/fieldLabels.ts: the field labels of the catalogue, the badge text of a
 * filter and the platform labels, on plain data and on the fake catalogue.
 */
import { expect, test } from '@playwright/test';
import { fieldLabelMap, PlatformLabels, badgeTextOf, expectedBadgeText, expectedFieldLabels, valueOptionLabel } from '../../utils/regression/inventory/fieldLabels';
import { fakeCatalogue, fakeData, FAKE_ENUMS } from './helpers/fakeCertificateListApp';

test('fieldLabelMap on the fake catalogue: every label is unique, so each is the catalogue label', () => {
    const catalogue = fakeCatalogue(fakeData());
    for (const group of catalogue) {
        const map = fieldLabelMap(group.searchFieldData, (c: string) => c);
        for (const f of group.searchFieldData) expect(map.get(f.fieldIdentifier)).toBe(f.fieldLabel);
    }
});

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
