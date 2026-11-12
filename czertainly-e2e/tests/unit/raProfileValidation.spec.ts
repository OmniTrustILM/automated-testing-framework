/**
 * Unit tests of utils/regression/inventory/raProfileValidation.ts: the attribute label core prints, the missing
 * and empty attribute arms, and the texts core answers for them. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import { authorityInterfaceOf, emptyAttributeCase, labelOf, missingAttributeCase, requestVersion, requiredAttributeNotFoundText, requiredAttributeNotSetText, requiredAttributeOracle } from '../../utils/regression/inventory/raProfileValidation';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const USERNAME_DEF = { uuid: U(1), name: 'username', type: 'data', contentType: 'string', properties: { label: 'Username', required: true } };

test('labelOf: the label core prints in "Required attribute <label> not found." (properties.label, else label, else name)', () => {
    expect(labelOf(USERNAME_DEF)).toBe('Username');
    expect(labelOf({ name: 'x', label: 'Top label' })).toBe('Top label');
    expect(labelOf({ name: 'only-name' })).toBe('only-name');
});

// ------------------------------------------------------------------ RA profile arms

test('requestVersion / missingArm / emptyArm: the required attribute is left out, or listed without content; the other attributes stay', () => {
    expect(requestVersion({ version: 3 })).toBe('v3');
    expect(requestVersion({ version: 'v3' })).toBe('v3');
    expect(requestVersion({ version: 2 })).toBe('v2');
    expect(requestVersion({})).toBe('v2');
    const target = { uuid: U(7), name: 'template', contentType: 'OBJECT', version: 2 };
    const base = [{ version: 'v2', uuid: U(8), name: 'other', contentType: 'string', content: [{ data: 'x' }] }, { version: 'v2', uuid: U(7), name: 'template', contentType: 'object', content: [{ data: { id: 1 } }] }];
    expect(missingAttributeCase(base, target).map((a) => a.name)).toEqual(['other']);
    expect(missingAttributeCase([], target)).toEqual([]);
    const empty = emptyAttributeCase(base, target);
    expect(empty.map((a) => a.name)).toEqual(['other', 'template']);
    expect(empty[1], 'listed, no content member, content type lower-cased').toEqual({ version: 'v2', uuid: U(7), name: 'template', contentType: 'object' });
    expect(base, 'the base attributes are not changed').toHaveLength(2);
});

test('the connector texts the rows expect (AttributeDefinitionUtils:388 and :397)', () => {
    expect(requiredAttributeNotFoundText('Username')).toBe('Required attribute Username not found.');
    expect(requiredAttributeNotSetText('Password')).toBe('Value of required attribute Password not set.');
});

test('authorityInterfaceOf: v3 only for a v3 connector interface; a legacy connector (null interface) relays like v2', () => {
    expect(authorityInterfaceOf({ connectorInterface: { version: 'v3' } })).toBe('v3');
    expect(authorityInterfaceOf({ connectorInterface: { version: 'V3' } })).toBe('v3');
    expect(authorityInterfaceOf({ connectorInterface: { version: 'v2' } })).toBe('v2');
    expect(authorityInterfaceOf({ connectorInterface: null })).toBe('v2');
    expect(authorityInterfaceOf({})).toBe('v2');
});

test('requiredAttributeOracle: the connector text and label for v2, core\'s attribute-engine text and name for v3', () => {
    const def = { name: 'data_certificateTemplate', properties: { label: 'Certificate template', required: true } };
    expect(requiredAttributeOracle('v2', def, 'missing')).toEqual({ text: 'Required attribute Certificate template not found.', names: 'Certificate template' });
    expect(requiredAttributeOracle('v2', def, 'empty')).toEqual({ text: 'Value of required attribute Certificate template not set.', names: 'Certificate template' });
    expect(requiredAttributeOracle('v3', def, 'missing')).toEqual({ text: 'Content for required Data attribute data_certificateTemplate is not provided.', names: 'data_certificateTemplate' });
    expect(requiredAttributeOracle('v3', def, 'empty')).toEqual({ text: 'Attribute is required and no content is sent', names: 'data_certificateTemplate' });
});
