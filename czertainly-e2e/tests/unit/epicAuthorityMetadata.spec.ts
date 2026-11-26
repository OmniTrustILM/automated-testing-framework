/**
 * epicAuthorityMetadata — the RFC 7638 thumbprint, the metadata reader and the ACME authority request attributes of the Epic ilm#658 tests.
 */
import { expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import {
    ACCOUNT_THUMBPRINT, ACCOUNT_URL, acmeAuthorityAttributes, attributeValue, jwkThumbprint, metadataCount, metadataValues, newAccountKeyPem,
} from '../../utils/epicAuthorityMetadata';

/** The RSA key of RFC 7638, section 3.1, and its thumbprint. */
const RFC7638_KEY = {
    kty: 'RSA',
    e: 'AQAB',
    n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
};
const RFC7638_THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

test('the thumbprint matches the RFC 7638 example', () => {
    expect(jwkThumbprint({ key: RFC7638_KEY, format: 'jwk' })).toBe(RFC7638_THUMBPRINT);
});

test('a new account key is EC P-256, and its private and public forms have one thumbprint', () => {
    const pem = newAccountKeyPem();
    const key = crypto.createPrivateKey(pem);
    expect(key.asymmetricKeyType).toBe('ec');
    expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    const publicPem = crypto.createPublicKey(pem).export({ format: 'pem', type: 'spki' }).toString();
    expect(jwkThumbprint(pem)).toBe(jwkThumbprint(publicPem));
    expect(jwkThumbprint(pem)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint(newAccountKeyPem())).not.toBe(jwkThumbprint(pem));
});

test('the metadata reader takes the values of one connector and counts items by name', () => {
    const item = (name: string, data: string) => ({ name, content: [{ contentType: 'string', data }] });
    const detail = {
        metadata: [
            { connectorUuid: 'c-1', items: [item(ACCOUNT_URL, 'https://ca/acct/1'), item(ACCOUNT_THUMBPRINT, 'tp')] },
            { connectorUuid: 'c-2', items: [item(ACCOUNT_URL, 'https://other/acct/2')] },
        ],
    };
    expect(metadataValues(detail, 'c-1')).toEqual({ [ACCOUNT_URL]: 'https://ca/acct/1', [ACCOUNT_THUMBPRINT]: 'tp' });
    expect(metadataValues(detail, 'c-3')).toEqual({});
    expect(metadataValues({}, 'c-1')).toEqual({});
    expect(metadataCount(detail, ACCOUNT_URL)).toBe(2);
    expect(metadataCount({ metadata: null }, ACCOUNT_URL)).toBe(0);
});

test('the authority attributes carry the directory, the account key secret and the agreed terms', () => {
    const attributes = acmeAuthorityAttributes('https://ca/directory', { uuid: 's-1', name: 'key-1' });
    expect(attributes.map((a) => a.name)).toEqual(['data_directoryUrl', 'data_accountKey', 'data_termsOfServiceAgreed']);
    const detail = { attributes };
    expect(attributeValue(detail, 'data_directoryUrl')).toBe('https://ca/directory');
    expect(attributeValue(detail, 'data_accountKey')).toEqual({ uuid: 's-1', name: 'key-1', resource: 'secrets' });
    expect(attributeValue(detail, 'data_termsOfServiceAgreed')).toBe(true);
    expect(attributeValue(detail, 'data_missing')).toBeUndefined();
});
