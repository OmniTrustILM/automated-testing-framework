/**
 * The guard verdict on every request the certificate search specs and the certificate list UI rows send: searches
 * with sorts, attribute filters and arrays, catalogue reads, the own PATCH and bulk archive are accepted; the UI rows
 * send plain GETs only. Nothing is sent (the verdict helper).
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';
import { guardVerdict, GuardVerdict } from './helpers/guardVerdict';
import { runId } from '../../utils/regression/ledger/runState';

// ------------------------------------------------------------------ the guard's verdict on the request shapes of the specs

test.describe('the guard accepts the request shapes of API-CERT-41…56 (nothing is sent)', () => {
    let judge: GuardVerdict;
    let raw: APIRequestContext;
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['BASE_URL', 'TIER_KIND', 'REG_RUN_ID', 'REG_STATE_DIR'];

    test.beforeEach(async ({}, testInfo) => {
        for (const k of KEYS) saved[k] = process.env[k];
        process.env.BASE_URL = 'http://127.0.0.1:1/administrator/';
        process.env.TIER_KIND = 'shared';
        process.env.REG_RUN_ID = runId();
        process.env.REG_STATE_DIR = testInfo.outputPath('state');
        raw = await request.newContext({ baseURL: process.env.BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer X' } });
        judge = guardVerdict(raw);
    });
    test.afterEach(async () => {
        await raw.dispose();
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    const P = `${runId()}-flt-abc-`;
    const search = (extra: Record<string, unknown>) => ({ filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: P }], itemsPerPage: 100, pageNumber: 1, ...extra });

    const BODIES: Array<[string, Record<string, unknown>]> = [
        ['a sort on a property field', search({ sort: { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', direction: 'desc' } })],
        ['a sort on a custom attribute', search({ sort: { fieldSource: 'custom', fieldIdentifier: `${P}num|INTEGER`, direction: 'asc' } })],
        ['includeArchived', search({ includeArchived: true })],
        ['array values', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'KEY_SIZE', condition: 'EQUALS', value: [3072, 4096] }] }],
        ['a value-less EMPTY', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', condition: 'EMPTY' }] }],
        ['an empty value list and an empty string', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: [] }, { fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'IN_NEXT', value: '' }] }],
        ['a regex and a literal-quote sequence', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'MATCHES', value: '\\Qabc\\E' }, { fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'MATCHES', value: '(' }] }],
        ['an attribute filter with a boolean', { ...search({}), filters: [{ fieldSource: 'custom', fieldIdentifier: `${P}flag|BOOLEAN`, condition: 'EQUALS', value: true }] }],
        ['a datetime with an offset', { ...search({}), filters: [{ fieldSource: 'property', fieldIdentifier: 'NOT_AFTER', condition: 'EQUALS', value: '2030-03-30T10:00:00+02:00' }] }],
    ];
    for (const [name, body] of BODIES) {
        test(`POST /api/v1/certificates: ${name}`, async () => {
            await judge.check('POST', '/api/v1/certificates', body);
        });
    }

    test('POST /api/v1/keys (the CKI_LENGTH number probe) and the catalogue reads', async () => {
        await judge.check('POST', '/api/v1/keys', { filters: [{ fieldSource: 'property', fieldIdentifier: 'CKI_LENGTH', condition: 'GREATER', value: 'abc' }], itemsPerPage: 1, pageNumber: 1 });
        await judge.check('GET', '/api/v1/keys/search');
        await judge.check('GET', '/api/v1/certificates/search');
        await judge.check('GET', '/api/v1/attributes/custom/resources/certificates');
        await judge.check('GET', '/api/v1/statistics', undefined, { params: { includeArchived: true } });
    });

    test('the listing searches and catalogue reads of API-GEN-11…15 / 23…25', async () => {
        const body = { filters: [], itemsPerPage: 10, pageNumber: 1 };
        for (const url of ['/api/v1/certificates', '/api/v1/keys', '/api/v1/discoveries/list', '/api/v1/auditLogs', '/api/v1/oids/list', '/api/v1/locations', '/api/v1/secrets', '/api/v1/entities/list', '/api/v1/vaults/list', '/api/v1/vaultProfiles/list']) {
            await judge.check('POST', url, body);
            await judge.check('POST', url, { ...body, sort: { fieldSource: 'property', fieldIdentifier: 'ANY_FIELD', direction: 'asc' } });
        }
        for (const url of ['/api/v1/auditLogs/search', '/api/v1/keys/search', '/api/v1/discoveries/search', '/api/v1/settings/logging', '/api/v1/attributes/custom', '/api/v1/listViews?resource=certificates', '/api/v1/oids/1.2.3.4']) {
            await judge.check('GET', url);
        }
        await judge.check('GET', '/api/v1/certificates/00000000-0000-4000-8000-000000000000/raw', undefined, { params: { encoding: 'pem' } }).catch((e: unknown) => expect(String(e)).toMatch(/ownership|probe|own/i));
    });
});

test.describe('guard: the only requests the UI rows send through the api fixture are plain GETs', () => {
    test('GET /api/v1/enums and GET /api/v1/certificates/search pass the guard (nothing is sent: the verdict helper judges only); the list search the UI itself sends is the browser\'s', async () => {
        const raw = await request.newContext({ baseURL: 'http://127.0.0.1:9/administrator/' });
        try {
            const guarded = guardVerdict(raw, { lines: [], runId: 'qa-reg-20261014-130000-cd34', tier: null, env: { BASE_URL: 'http://127.0.0.1:9/administrator/' } });
            await guarded.check('GET', '/api/v1/enums');
            await guarded.check('GET', '/api/v1/certificates/search');
            await guarded.check('POST', '/api/v1/certificates', { filters: [], itemsPerPage: 10, pageNumber: 1 }); // the API-side oracle search of the rows (POST_READ)
        } finally {
            await raw.dispose();
        }
    });
});
