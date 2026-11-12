/**
 * tokenActivation — the activation request of an own v1 token.
 *
 * WHAT: `activationAttributesFor` fills the token code of the live activation definitions with the code the token was created with, and
 *       leaves optional attributes out.
 * WHY: a v1 token is activated with the code it was created with; a request that carries another value, or an optional attribute the
 *      connector never asked for, is refused or ignored and the v1 key row fails for the wrong reason.
 * HOW: pure; the definitions are the shape the connector answers.
 */
import { expect, test } from '@playwright/test';
import { activationAttributesFor } from '../../utils/regression/platform/tokens';
import { SCP_ATTR } from '../../utils/regression/platform/cryptoAlgorithmCases';

test('activationAttributesFor puts the creation code into the token code attribute as a secret and skips optional attributes', () => {
    const defs = [
        { uuid: SCP_ATTR.tokenCode.uuid, name: SCP_ATTR.tokenCode.name, type: 'data', contentType: 'secret', properties: { required: true } },
        { uuid: '00000000-0000-4000-8000-000000000009', name: 'data_optional', type: 'data', contentType: 'string', properties: { required: false } },
    ];
    const attributes = activationAttributesFor(defs, 'code-1');
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatchObject({ name: SCP_ATTR.tokenCode.name, uuid: SCP_ATTR.tokenCode.uuid, contentType: 'secret', content: [{ data: { secret: 'code-1' } }] });
});
