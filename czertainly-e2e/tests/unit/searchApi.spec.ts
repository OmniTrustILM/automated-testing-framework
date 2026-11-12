/**
 * Unit tests of utils/regression/inventory/searchApi.ts: the absolute condition sets of the field types, the
 * catalogue field checks, and the catalogue, row and filter helpers. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import { ALL_CONDITIONS, CONDITION_KINDS, CONDITION_SETS, fieldsOf, findField, isolation, propertyFilter, rowsOf, uuidSet } from '../../utils/regression/inventory/searchApi';

// ------------------------------------------------------------------ pure: searchApi

test('the absolute condition sets: string 10, number 8, date / datetime 10, list 4, boolean 4 (core SearchFieldTypeEnum), the special kinds', () => {
    expect(CONDITION_SETS.string).toHaveLength(10);
    expect(CONDITION_SETS.number).toHaveLength(8);
    expect(CONDITION_SETS.date).toHaveLength(10);
    expect(CONDITION_SETS.datetime).toHaveLength(10);
    expect(CONDITION_SETS.list).toHaveLength(4);
    expect(CONDITION_SETS.boolean).toHaveLength(4);
    expect(CONDITION_KINDS.collection).toHaveLength(8);
    expect(CONDITION_KINDS.expectedBoolean).toEqual(['EQUALS', 'NOT_EQUALS']);
    for (const set of [...Object.values(CONDITION_SETS), ...Object.values(CONDITION_KINDS)]) {
        for (const c of set) expect(ALL_CONDITIONS).toContain(c);
        expect(new Set(set).size).toBe(set.length);
    }
});

test('catalogue and row helpers: fieldsOf / findField / rowsOf / uuidSet / filter builders', () => {
    const catalogue = [
        { filterFieldSource: 'property' as const, searchFieldData: [{ fieldIdentifier: 'COMMON_NAME', fieldLabel: 'Common Name', type: 'string' as const, conditions: [] }] },
        { filterFieldSource: 'custom' as const, searchFieldData: [{ fieldIdentifier: 'x|STRING', fieldLabel: 'X', type: 'string' as const, conditions: [] }] },
    ];
    expect(fieldsOf(catalogue, 'custom').map((f) => f.fieldIdentifier)).toEqual(['x|STRING']);
    expect(findField(catalogue, 'COMMON_NAME')?.fieldLabel).toBe('Common Name');
    expect(findField(catalogue, 'COMMON_NAME', 'custom')).toBeUndefined();
    expect(rowsOf({ certificates: [{ uuid: 'b' }, { uuid: 'a' }], totalItems: 2 })).toEqual([{ uuid: 'b' }, { uuid: 'a' }]);
    expect(rowsOf([{ uuid: 'a' }])).toEqual([{ uuid: 'a' }]);
    expect(uuidSet([{ uuid: 'b' }, { uuid: 'a' }])).toEqual(['a', 'b']);
    expect(propertyFilter('COMMON_NAME', 'EMPTY')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EMPTY' });
    expect(isolation('p-')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: 'p-' });
});
