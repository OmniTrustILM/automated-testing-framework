/**
 * Unit tests for choosing a connector by URL.
 *
 * A connector registered as both v1 and v2 appears twice at one URL, and SMK-003 drives the form of
 * one version only. Taking the first match picked the other version on such an environment and failed
 * on a missing field, far from the cause.
 */
import { test, expect } from '@playwright/test';
import { ConnectorDto, connectorAt } from '../../utils/connectorUtils';

const URL = 'http://discovery.example:8080';
const connector = (name: string, url = URL): ConnectorDto =>
    ({ uuid: name, name, url, status: 'connected', authType: 'none' });

test('a single registration at the URL is used whatever its name', () => {
    const only = connector('Discovery');
    expect(connectorAt([only, connector('Other', 'http://other:8080')], URL, 'Something else')).toBe(only);
});

test('no registration at the URL gives undefined', () => {
    expect(connectorAt([connector('Other', 'http://other:8080')], URL, 'Discovery')).toBeUndefined();
});

test('with several registrations at the URL the named one is used', () => {
    const v1 = connector('Discovery');
    const v2 = connector('Discovery-v2');
    expect(connectorAt([v2, v1], URL, 'Discovery')).toBe(v1);
});

test('with several registrations and no matching name the choice is refused', () => {
    expect(() => connectorAt([connector('Discovery'), connector('Discovery-v2')], URL, 'Missing'))
        .toThrow(/2 connectors are registered at .*Discovery, Discovery-v2/);
});
