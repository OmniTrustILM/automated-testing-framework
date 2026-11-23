/**
 * epicDelegation — the token-leak detector of the Epic ilm#486 tests must see a full token and a bare signature.
 */
import { expect, test } from '@playwright/test';
import { leaksToken, newSigner } from '../../utils/epicDelegation';

const signer = newSigner('https://leak.example.test', 'leak');
const first = signer.token('leak-user');
const second = signer.token('leak-user', { client_id: 'actor' });

test('leaksToken finds a full token anywhere in the value', () => {
    expect(leaksToken({ items: [{ message: `got ${first}` }] }, [first])).toBe(true);
});

test('leaksToken finds the signature alone, without header and payload', () => {
    expect(leaksToken(['x', { detail: first.split('.')[2] }], [first])).toBe(true);
});

test('leaksToken checks every issued token, not only the first', () => {
    expect(leaksToken({ header: `Bearer ${second}` }, [first, second])).toBe(true);
});

test('leaksToken passes data that holds none of the tokens, also their header and payload only', () => {
    const [header, payload] = first.split('.');
    expect(leaksToken({ items: [{ id: 1, actor: { name: 'leak-user' } }], redacted: `${header}.${payload}` }, [first, second])).toBe(false);
});
