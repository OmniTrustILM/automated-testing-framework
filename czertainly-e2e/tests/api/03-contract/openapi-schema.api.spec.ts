/**
 * API-GEN-23, 24, 25 — Responses against the published OpenAPI document. ilm#428, ilm#442.
 *
 * WHAT: 1. The detail, history and download (plus validate and chain on own objects) of eight certificates conform to the schema: a
 *          self-signed seed, a CA-issued seed, a seed with custom attributes, a group and an owner, the trusted CA seed, an own archived
 *          certificate and three existing certificates (read-only).
 *       2. The detail of up to three existing objects of each resource (authority, RA profile, ACME profile, credential, connector, group,
 *          key, discovery, custom attribute, OID entry) conforms; a credential's secret attribute carries no data; the own group and custom
 *          attribute of the seed conform; the current user's list views conform.
 *       3. Every list or search behind a sidebar page, and the dashboard statistics, match the schema and the page invariants (totalPages =
 *          ceil(totalItems / itemsPerPage), the requested page size echoed, every date-time carrying a zone designator).
 * WHY: the published OpenAPI document is the absolute oracle of the response shape (ilm#428: dates, enums, empty values); members the
 *      document does not declare are reported as an annotation, not failed. archived is a boolean flag, not a state; a SECRET attribute is
 *      serialised without data; a view's detail is the list item (there is no GET by uuid).
 * HOW: the document comes from REG_OPENAPI_FILE; without it every test skips with the named reason, never a pass. Existing objects are only
 *      read (side-effect GETs such as approvals are left out); own seeds are create-only with run-prefixed names and every create is
 *      recorded in the ledger before the first assertion. A resource that answers 404 or 403 on this build skips with the reason;
 *      an operation without a 200 JSON schema in the document skips.
 */
import { LONG_TEST_MS, WIDE_SWEEP_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { readJsonOk, send, searchPage, readAnswer } from '../../../utils/regression/inventory/searchApi';
import { buildFreshSeedB, certById } from '../../../utils/regression/inventory/seedFull';
import { setArchivedOwn } from '../../../utils/regression/inventory/seedOwnedObjects';
import { certificateSeedPlan } from '../../../utils/regression/inventory/seedRows';
import {
    dateTimeZoneProblems, describeViolations, isBase64, openapiSource, OpenApiValidator, pageProblems, SchemaUse,
} from '../../../utils/regression/inventory/openapiValidator';
import { hasRunFamilyPrefix } from '../../../utils/regression/run/runId';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { ApiAnswer } from '../../../utils/regression/apiReads';
import { JsonObject } from '../../../utils/regression/json';

const ISSUES = ['ilm#428', 'ilm#442'];

/**
 * The validator of the run's OpenAPI document. Every test declares the `openapi-document` need, which skips before the test starts when
 * there is none.
 */
function loadedDocument(): OpenApiValidator {
    const src = openapiSource();
    if ('skip' in src) throw new Error(src.skip);
    return new OpenApiValidator(src.doc);
}

const response = (path: string, method: 'get' | 'post' = 'get'): SchemaUse => ({ kind: 'response', path, method, status: '200' });

/** Validates a 200 body against `use`; adds the extra members as an annotation; returns the violations text (empty = conforming). */
function conformity(v: OpenApiValidator, testInfo: { annotations: Array<{ type: string; description?: string }> }, label: string, p: ApiAnswer, use: SchemaUse): string {
    if (p.status !== 200) return `${label}: answered ${p.status} ${p.text.slice(0, 160)}`;
    const violations = v.validate(use, p.json);
    const extra = v.extraMembers(use, p.json);
    if (extra.length) testInfo.annotations.push({ type: 'extra-members', description: `${label}: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` … ${extra.length - 8} more` : ''}` });
    const zones = dateTimeZoneProblems(p.json);
    return [describeViolations(label, violations), ...zones.map((z) => `${label}: a date-time without a zone designator at ${z}`)].filter(Boolean).join('\n');
}

test.describe('OpenAPI schema of the certificate detail', { tag: tags.api }, () => {
    type Variant = 'self-signed' | 'ca-issued' | 'attributes-group-owner' | 'ca' | 'archived' | 'existing-1' | 'existing-2' | 'existing-3';
    const VARIANTS: Array<{ id: Variant; what: string }> = [
        { id: 'self-signed', what: 'a self-signed seed (two groups, no owner)' },
        { id: 'ca-issued', what: 'a CA-issued seed' },
        { id: 'attributes-group-owner', what: 'a seed with custom attributes, a group and an owner' },
        { id: 'ca', what: 'the CA seed with the trusted-CA mark' },
        { id: 'archived', what: 'an own archived certificate' },
        { id: 'existing-1', what: 'an existing certificate (read-only)' },
        { id: 'existing-2', what: 'a second existing certificate (read-only)' },
        { id: 'existing-3', what: 'a third existing certificate (read-only)' },
    ];

    /** uuid of the certificate a variant names; `ownObject` = may take the side-effect GETs. */
    async function pick(api: GuardedApi, testInfo: Parameters<typeof certificateSeedPlan>[1], spec: string, variant: Variant): Promise<{ uuid: string; ownObject: boolean; commonName?: string } | undefined> {
        if (variant.startsWith('existing-')) {
            const page = await searchPage(api, { itemsPerPage: 25, pageNumber: 1, filters: [] });
            const existing = page.rows.filter((r) => !hasRunFamilyPrefix(String(r.commonName)));
            const row = existing[Number(variant.slice('existing-'.length)) - 1];
            return row ? { uuid: String(row.uuid), ownObject: false } : undefined;
        }
        if (variant === 'archived') {
            const b = await buildFreshSeedB(api, spec);
            const first = b.certificates[0];
            const res = await setArchivedOwn(api, { uuid: first.uuid, name: first.commonName, kind: 'own' }, true);
            expect(res.status, res.text.slice(0, 200)).toBeLessThan(300);
            return { uuid: first.uuid, ownObject: false, commonName: first.commonName };
        }
        const m = await certificateSeedPlan(api, testInfo, spec);
        const ids: Record<string, 'C03' | 'C11' | 'C01' | 'C24'> = { 'self-signed': 'C03', 'ca-issued': 'C11', 'attributes-group-owner': 'C01', ca: 'C24' };
        const c = certById(m, ids[variant]);
        return { uuid: c.uuid, ownObject: true, commonName: c.commonName };
    }

    const VARIANT_WORDS: Record<Variant, string> = {
        'self-signed': 'a self-signed seed', 'ca-issued': 'a CA-issued seed', 'attributes-group-owner': 'a seed with attributes and an owner',
        ca: 'the trusted CA seed', archived: 'an own archived certificate', 'existing-1': 'an existing certificate',
        'existing-2': 'a second existing certificate', 'existing-3': 'a third existing certificate',
    };
    for (const { id, what } of VARIANTS) {
        test(`detail, history and download of ${VARIANT_WORDS[id]} conform to the OpenAPI document`,
            testMeta({
                id: 'API-GEN-23', row: id, prio: 'P1', issue: ISSUES, needs: 'openapi-document',
                rule: ['ilm#428 (the published OpenAPI document is the absolute oracle of the response shape; extra members reported, not failed)', 'archived is a boolean flag, not a state; core CertificateDetailDto / CertificateEventHistoryDto / CertificateDownloadResponseDto', `the certificate detail, history and download JSON of ${what} conform to the OpenAPI document`, ...(id === 'archived' || id.startsWith('existing') ? [] : ['validate and chain too: own object'])],
            }),
            async ({ api, own }, testInfo) => {
                test.setTimeout(LONG_TEST_MS);
                const v = loadedDocument();
                const target = await pick(api, testInfo, own.spec, id);
                test.skip(!target, 'the tier holds fewer certificates than this row needs');
                const { uuid, ownObject, commonName } = target!;
                const problems: string[] = [];

                await test.step('The detail conforms and is the certificate asked for', async () => {
                    const detail = await send(api, 'GET', `/api/v1/certificates/${uuid}`);
                    problems.push(conformity(v, testInfo, 'detail', detail, response('/v1/certificates/{uuid}')));
                    if (detail.status === 200) {
                        const body = detail.json as JsonObject;
                        if (commonName) expect(body.commonName, 'the detail is the certificate asked for').toBe(commonName);
                        if (typeof body.certificateContent === 'string') expect(isBase64(body.certificateContent), 'certificateContent is base64').toBe(true);
                        if (id === 'archived') expect(body.archived, 'an archived certificate reads archived = true').toBe(true);
                    }
                });

                await test.step('The history and the download conform', async () => {
                    const history = await send(api, 'GET', `/api/v1/certificates/${uuid}/history`);
                    problems.push(conformity(v, testInfo, 'history', history, response('/v1/certificates/{uuid}/history')));

                    const download = await send(api, 'GET', `/api/v1/certificates/${uuid}/raw`, { params: { encoding: 'pem' } });
                    problems.push(conformity(v, testInfo, 'download (raw, pem)', download, response('/v1/certificates/{uuid}/{certificateFormat}')));
                    if (download.status === 200 && typeof (download.json as JsonObject)?.content === 'string') expect(isBase64((download.json as JsonObject).content as string), 'the download content is base64').toBe(true);
                });

                if (ownObject) {
                    const validate = await send(api, 'GET', `/api/v1/certificates/${uuid}/validate`);
                    problems.push(conformity(v, testInfo, 'validate', validate, response('/v1/certificates/{uuid}/validate')));
                    const chain = await send(api, 'GET', `/api/v1/certificates/${uuid}/chain`);
                    problems.push(conformity(v, testInfo, 'chain', chain, response('/v1/certificates/{uuid}/chain')));
                }
                expect(problems.filter(Boolean).join('\n'), 'responses that break the published schema').toBe('');
            });
    }
});

test.describe('OpenAPI schema of the detail resources', { tag: tags.api }, () => {
    interface Resource {
        name: string;
        /** How to list its objects (rows carry `uuid`). */
        list: { method: 'GET' | 'POST'; url: string; body?: JsonObject; member?: string };
        /** Detail GETs per row: the OpenAPI path template and the concrete URL. */
        details: Array<{ path: string; url: (row: JsonObject) => string | undefined }>;
    }
    const SEARCH = { itemsPerPage: 10, pageNumber: 1, filters: [] };
    const RESOURCES: Resource[] = [
        { name: 'authority', list: { method: 'GET', url: '/api/v1/authorities' }, details: [{ path: '/v1/authorities/{uuid}', url: (r) => `/api/v1/authorities/${r.uuid}` }] },
        {
            name: 'raProfile',
            list: { method: 'GET', url: '/api/v1/raProfiles' },
            details: [
                { path: '/v1/raProfiles/{raProfileUuid}', url: (r) => `/api/v1/raProfiles/${r.uuid}` },
                { path: '/v1/authorities/{authorityUuid}/raProfiles/{raProfileUuid}', url: (r) => (r.authorityInstanceUuid ? `/api/v1/authorities/${r.authorityInstanceUuid}/raProfiles/${r.uuid}` : undefined) },
            ],
        },
        { name: 'acmeProfile', list: { method: 'GET', url: '/api/v1/acmeProfiles' }, details: [{ path: '/v1/acmeProfiles/{uuid}', url: (r) => `/api/v1/acmeProfiles/${r.uuid}` }] },
        { name: 'credential', list: { method: 'GET', url: '/api/v1/credentials' }, details: [{ path: '/v1/credentials/{uuid}', url: (r) => `/api/v1/credentials/${r.uuid}` }] },
        { name: 'connector', list: { method: 'GET', url: '/api/v1/connectors' }, details: [{ path: '/v1/connectors/{uuid}', url: (r) => `/api/v1/connectors/${r.uuid}` }] },
        { name: 'group', list: { method: 'GET', url: '/api/v1/groups' }, details: [{ path: '/v1/groups/{uuid}', url: (r) => `/api/v1/groups/${r.uuid}` }] },
        { name: 'key', list: { method: 'POST', url: '/api/v1/keys', body: SEARCH, member: 'cryptographicKeys' }, details: [{ path: '/v1/keys/{uuid}', url: (r) => `/api/v1/keys/${r.uuid}` }] },
        { name: 'discovery', list: { method: 'POST', url: '/api/v1/discoveries/list', body: SEARCH, member: 'discoveries' }, details: [{ path: '/v1/discoveries/{uuid}', url: (r) => `/api/v1/discoveries/${r.uuid}` }] },
        { name: 'customAttribute', list: { method: 'GET', url: '/api/v1/attributes/custom' }, details: [{ path: '/v1/attributes/custom/{uuid}', url: (r) => `/api/v1/attributes/custom/${r.uuid}` }] },
        { name: 'oidEntry', list: { method: 'POST', url: '/api/v1/oids/list', body: SEARCH, member: 'items' }, details: [{ path: '/v1/oids/{oid}', url: (r) => (r.oid ? `/api/v1/oids/${encodeURIComponent(String(r.oid))}` : undefined) }] },
    ];

    async function rowsOfList(api: GuardedApi, l: Resource['list']): Promise<{ status: number; rows: JsonObject[]; text: string }> {
        const p = await send(api, l.method, l.url, l.body ? { data: l.body } : {});
        const json = p.json as JsonObject | JsonObject[] | undefined;
        const rows = Array.isArray(json) ? json : l.member && json && Array.isArray((json as JsonObject)[l.member]) ? ((json as JsonObject)[l.member] as JsonObject[]) : [];
        return { status: p.status, rows, text: p.text };
    }

    for (const r of RESOURCES) {
        test(`the existing ${r.name} detail conforms to the OpenAPI document`,
            testMeta({
                id: 'API-GEN-24', row: r.name, prio: 'P1', issue: ISSUES, needs: 'openapi-document',
                rule: ['ilm#428: the OpenAPI document is the oracle of the detail shape; read-only on existing objects', 'a SECRET attribute is serialised without data (ResponseAttributeSerializer)', 'the detail of up to 3 existing objects', ...(r.name === 'credential' ? ['the secret attribute is masked: no data'] : [])],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(WIDE_SWEEP_TEST_MS);
                const v = loadedDocument();
                const list = await rowsOfList(api, r.list);
                test.skip(list.status === 404 || list.status === 403, `${r.list.url} answers ${list.status} on this build: the resource is not served here`);
                expect(list.status, `${r.list.url}: ${list.text.slice(0, 160)}`).toBe(200);
                const existing = list.rows.filter((row) => !hasRunFamilyPrefix(String(row.name ?? row.commonName ?? ''))).slice(0, 3);
                test.skip(!existing.length, `the tier holds no existing ${r.name} object to read`);
                const problems: string[] = [];
                for (const [i, row] of existing.entries()) {
                    for (const d of r.details) {
                        const url = d.url(row);
                        if (!url) continue;
                        if (!v.has(response(d.path))) {
                            testInfo.annotations.push({ type: 'not-in-document', description: `GET ${d.path} has no 200 JSON schema in the document` });
                            continue;
                        }
                        const p = await send(api, 'GET', url);
                        problems.push(conformity(v, testInfo, `${r.name} #${i + 1} ${d.path}`, p, response(d.path)));
                        if (r.name === 'credential' && p.status === 200) {
                            // The secret masking: a SECRET attribute carries no `data` in any content item.
                            const leak = JSON.stringify((p.json as JsonObject).attributes ?? []).match(/"contentType":"secret"[^}]*"data"/);
                            expect(leak, 'a secret attribute of the credential carries no data').toBeNull();
                        }
                    }
                }
                expect(problems.filter(Boolean).join('\n'), `${r.name} details that break the published schema`).toBe('');
            });
    }

    test('the own group and custom attribute of the certificate seed conform to the OpenAPI document',
        testMeta({ id: 'API-GEN-24', row: 'own', prio: 'P1', issue: ISSUES, needs: 'openapi-document', rule: ['the list item has null customAttributes, the detail the array', 'with their custom attribute content'] }),
        async ({ api, own }, testInfo) => {
            const v = loadedDocument();
            const m = await certificateSeedPlan(api, testInfo, own.spec);
            const problems: string[] = [];
            const group = await send(api, 'GET', `/api/v1/groups/${m.groupUuids.a}`);
            problems.push(conformity(v, testInfo, 'own group', group, response('/v1/groups/{uuid}')));
            const attr = await send(api, 'GET', `/api/v1/attributes/custom/${m.attributeUuids.pick}`);
            problems.push(conformity(v, testInfo, 'own custom attribute (list, multi-select)', attr, response('/v1/attributes/custom/{uuid}')));
            expect(problems.filter(Boolean).join('\n')).toBe('');
        });

    test('the current user\'s list views conform to the OpenAPI document',
        testMeta({ id: 'API-GEN-24', row: 'listViews', prio: 'P1', issue: ISSUES, needs: 'openapi-document', rule: ['core#2034 (per-user saved views); the detail of a view is the list item (no GET by uuid)', 'GET /v1/listViews?resource=certificates'] }),
        async ({ api }, testInfo) => {
            const v = loadedDocument();
            const p = await send(api, 'GET', '/api/v1/listViews', { params: { resource: 'certificates' } });
            test.skip(p.status === 404, '/v1/listViews answers 404 on this build');
            const problems = conformity(v, testInfo, 'list views', p, response('/v1/listViews'));
            expect(problems, 'list views that break the published schema').toBe('');
        });
});

test.describe('OpenAPI schema of list and search responses', { tag: tags.api }, () => {
    interface Endpoint {
        name: string;
        method: 'GET' | 'POST';
        /** The OpenAPI path template. */
        path: string;
        url: string;
        params?: Record<string, string>;
    }
    const SEARCH_BODY = { itemsPerPage: 10, pageNumber: 1, filters: [] };
    // Lists behind a sidebar page (fe-administrator Sidebar) and the dashboard statistics. Side-effect GETs (approvals) are left out.
    const ENDPOINTS: Endpoint[] = [
        { name: 'certificates', method: 'POST', path: '/v1/certificates', url: '/api/v1/certificates' },
        { name: 'keys', method: 'POST', path: '/v1/keys', url: '/api/v1/keys' },
        { name: 'discoveries', method: 'POST', path: '/v1/discoveries/list', url: '/api/v1/discoveries/list' },
        { name: 'auditLogs', method: 'POST', path: '/v1/auditLogs', url: '/api/v1/auditLogs' },
        { name: 'oids', method: 'POST', path: '/v1/oids/list', url: '/api/v1/oids/list' },
        { name: 'locations', method: 'POST', path: '/v1/locations', url: '/api/v1/locations' },
        { name: 'secrets', method: 'POST', path: '/v1/secrets', url: '/api/v1/secrets' },
        { name: 'entities', method: 'POST', path: '/v1/entities/list', url: '/api/v1/entities/list' },
        { name: 'vaults', method: 'POST', path: '/v1/vaults/list', url: '/api/v1/vaults/list' },
        { name: 'vaultProfiles', method: 'POST', path: '/v1/vaultProfiles/list', url: '/api/v1/vaultProfiles/list' },
        { name: 'groups', method: 'GET', path: '/v1/groups', url: '/api/v1/groups' },
        { name: 'credentials', method: 'GET', path: '/v1/credentials', url: '/api/v1/credentials' },
        { name: 'authorities', method: 'GET', path: '/v1/authorities', url: '/api/v1/authorities' },
        { name: 'raProfiles', method: 'GET', path: '/v1/raProfiles', url: '/api/v1/raProfiles' },
        { name: 'acmeProfiles', method: 'GET', path: '/v1/acmeProfiles', url: '/api/v1/acmeProfiles' },
        { name: 'scepProfiles', method: 'GET', path: '/v1/scepProfiles', url: '/api/v1/scepProfiles' },
        { name: 'cmpProfiles', method: 'GET', path: '/v1/cmpProfiles', url: '/api/v1/cmpProfiles' },
        { name: 'connectors', method: 'GET', path: '/v1/connectors', url: '/api/v1/connectors' },
        { name: 'users', method: 'GET', path: '/v1/users', url: '/api/v1/users' },
        { name: 'roles', method: 'GET', path: '/v1/roles', url: '/api/v1/roles' },
        { name: 'listViews', method: 'GET', path: '/v1/listViews', url: '/api/v1/listViews', params: { resource: 'certificates' } },
        { name: 'customAttributes', method: 'GET', path: '/v1/attributes/custom', url: '/api/v1/attributes/custom' },
        { name: 'notificationInstances', method: 'GET', path: '/v1/notificationInstances', url: '/api/v1/notificationInstances' },
        { name: 'notificationProfiles', method: 'GET', path: '/v1/notificationProfiles', url: '/api/v1/notificationProfiles' },
        { name: 'complianceProfiles', method: 'GET', path: '/v1/complianceProfiles', url: '/api/v1/complianceProfiles' },
        { name: 'tokens', method: 'GET', path: '/v1/tokens', url: '/api/v1/tokens' },
        { name: 'tokenProfiles', method: 'GET', path: '/v1/tokenProfiles', url: '/api/v1/tokenProfiles' },
        { name: 'triggers', method: 'GET', path: '/v1/workflows/triggers', url: '/api/v1/workflows/triggers' },
        { name: 'statistics', method: 'GET', path: '/v1/statistics', url: '/api/v1/statistics' },
    ];

    for (const e of ENDPOINTS) {
        test(`${e.method} ${e.url} matches the OpenAPI document`,
            testMeta({
                id: 'API-GEN-25', row: e.name, prio: 'P1', issue: ISSUES, needs: 'openapi-document',
                rule: ['ilm#428 (dates, enums, empty values): the OpenAPI document is the oracle', 'totalPages = ceil(totalItems / itemsPerPage); statistics shape', 'page invariants; every date-time carries a zone designator'],
            }),
            async ({ api }, testInfo) => {
                const v = loadedDocument();
                const use = response(e.path, e.method === 'POST' ? 'post' : 'get');
                test.skip(!v.has(use), `the OpenAPI document has no 200 JSON schema for ${e.method} ${e.path}`);
                const p = e.method === 'POST' ? await send(api, 'POST', e.url, { data: SEARCH_BODY }) : e.params ? await send(api, 'GET', e.url, { params: e.params }) : await readAnswer(api, e.url);
                test.skip(p.status === 404 || p.status === 403, `${e.url} answers ${p.status} on this build / for this identity: not served here`);
                const problem = conformity(v, testInfo, e.name, p, use);
                const paging = p.status === 200 ? pageProblems(p.json).map((x) => `${e.name}: ${x}`) : [];
                if (e.method === 'POST' && p.status === 200) expect(readJsonOk<JsonObject>(p, e.name).itemsPerPage, 'the requested page size is echoed').toBe(10);
                expect([problem, ...paging].filter(Boolean).join('\n'), `${e.name} breaks the published schema or the page invariants`).toBe('');
            });
    }
});
