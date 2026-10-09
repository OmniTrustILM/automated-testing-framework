/**
 * Unit tests for the parts of env.ts that compute a value rather than read one.
 *
 * SMK-005 derives the domain its HTTP-01 solver answers on from BASE_URL, and a wrong derivation
 * fails the smoke run minutes later as an unreachable challenge — far from the cause. Pinning it
 * here keeps that failure next to the code that produces it.
 */
import { test, expect } from '@playwright/test';
import { parentDomainOf } from '../../utils/env';

test('the solver domain is BASE_URL\'s host without its first label', () => {
    expect(parentDomainOf('https://fe-pr-1.preview.example.com/')).toBe('preview.example.com');
    expect(parentDomainOf('https://qa.example.com')).toBe('example.com');
});

test('port and path do not leak into the solver domain', () => {
    expect(parentDomainOf('https://env.example.com:8443/administrator/')).toBe('example.com');
});
