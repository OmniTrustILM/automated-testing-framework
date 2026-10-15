/**
 * API-GEN-23, 24, 25 — responses against the published OpenAPI document (ilm#428 T4 steps 16–18, ilm#442 QA#1 / QA#4: the
 * absolute replacement of the baseline-vs-migrated JSON diff; inventory-api plan §3.3, §0.2).
 *
 *   API-GEN-23  the certificate detail (and history, download JSON, validate, chain) of the run's own seeds — self-signed, CA-issued,
 *               with attributes + group + owner, the CA, archived — plus 3 existing certificates read-only: required members, types,
 *               enums, date-time / uuid / int64 formats, nested objects, no null where the schema forbids it, `content` base64.
 *   API-GEN-24  the detail resources of the area (RA profile both ways, authority, ACME profile, credential, connector, group, key,
 *               discovery, custom attribute) and the list-view / OID lists: up to 3 existing objects each, read-only (+ the own group /
 *               attribute of SEED-A).
 *   API-GEN-25  every list and search response behind a sidebar page (about 25 endpoints) and `GET /v1/statistics`: the schema, the page
 *               invariants (totalPages = ceil(totalItems / itemsPerPage), items <= itemsPerPage), every date-time with a zone designator.
 *
 * The OpenAPI document is a LOCAL FILE (`REG_OPENAPI_FILE`, the published doc-openapi-ilm-core.json of the build under test): the core does
 * not serve it. Without it every test here skips with the named reason (inventoryOpenapi.ts `openapiSource`), never a pass. A resource the
 * document does not describe, an endpoint the build does not serve (404) or a tier with no object of a kind skips THAT row with its reason.
 * Extra members (present in the answer, absent from the schema) are annotated, not failed. Reads only; the side-effect GETs (validate, chain)
 * run on OWN certificates alone (apiRoutes.ts SIDE_EFFECT_GETS), the seed builds are create-only own objects.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { Json, okJson, readProbe, send, searchPage, Probe } from '../../utils/regression/inventoryApi';
import { buildFreshSeedB } from '../../utils/regression/inventorySeedFull';
import { setArchivedOwn } from '../../utils/regression/inventoryOwn';
import { certById } from '../../utils/regression/inventorySeedFull';
import { seedA } from '../../utils/regression/inventoryRows';
import {
    dateTimeZoneProblems, describeViolations, isBase64, openapiSource, OpenApiValidator, pageProblems, SchemaUse,
} from '../../utils/regression/inventoryOpenapi';
import { hasRunFamilyPrefix } from '../../utils/regression/runId';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const ISSUES = ['ilm#428', 'ilm#442'];

let validator: OpenApiValidator | undefined;

/** The validator of the run's OpenAPI document, or the named skip. Called first by every test. */
function documentOrSkip(): OpenApiValidator {
    const src = openapiSource();
    test.skip('skip' in src, 'skip' in src ? src.skip : '');
    if ('skip' in src) throw new Error(src.skip);
    validator ??= new OpenApiValidator(src.doc);
    return validator;
}

const response = (path: string, method: 'get' | 'post' = 'get'): SchemaUse => ({ kind: 'response', path, method, status: '200' });

/** Validates a 200 body against `use`; adds the extra members as an annotation; returns the violations text (empty = conforming). */
function conformity(v: OpenApiValidator, testInfo: { annotations: Array<{ type: string; description?: string }> }, label: string, p: Probe, use: SchemaUse): string {
    if (p.status !== 200) return `${label}: answered ${p.status} ${p.text.slice(0, 160)}`;
    const violations = v.validate(use, p.json);
    const extra = v.extraMembers(use, p.json);
    if (extra.length) testInfo.annotations.push({ type: 'extra-members', description: `${label}: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` … ${extra.length - 8} more` : ''}` });
    const zones = dateTimeZoneProblems(p.json);
    return [describeViolations(label, violations), ...zones.map((z) => `${label}: a date-time without a zone designator at ${z}`)].filter(Boolean).join('\n');
}

test.describe('API-GEN-23 OpenAPI schema validation: certificate detail', { tag: tags.api }, () => {
    type Variant = 'self-signed' | 'ca-issued' | 'attributes-group-owner' | 'ca' | 'archived' | 'existing-1' | 'existing-2' | 'existing-3';
    const VARIANTS: Array<{ id: Variant; what: string }> = [
        { id: 'self-signed', what: 'a self-signed seed (C03: two groups, no owner)' },
        { id: 'ca-issued', what: 'a CA-issued seed (C11)' },
        { id: 'attributes-group-owner', what: 'a seed with custom attributes, a group and an owner (C01)' },
        { id: 'ca', what: 'the CA seed with the trusted-CA mark (C24)' },
        { id: 'archived', what: 'an own archived certificate' },
        { id: 'existing-1', what: 'an existing certificate (read-only)' },
        { id: 'existing-2', what: 'a second existing certificate (read-only)' },
        { id: 'existing-3', what: 'a third existing certificate (read-only)' },
    ];

    /** uuid of the certificate a variant names; `own` = may take the side-effect GETs. */
    async function pick(api: GuardedApi, testInfo: Parameters<typeof seedA>[1], variant: Variant): Promise<{ uuid: string; own: boolean; commonName?: string } | undefined> {
        if (variant.startsWith('existing-')) {
            const page = await searchPage(api, { itemsPerPage: 25, pageNumber: 1, filters: [] });
            const existing = page.rows.filter((r) => !hasRunFamilyPrefix(String(r.commonName)));
            const row = existing[Number(variant.slice('existing-'.length)) - 1];
            return row ? { uuid: String(row.uuid), own: false } : undefined;
        }
        if (variant === 'archived') {
            const b = await buildFreshSeedB(api, 'API-GEN-23');
            const first = b.certificates[0];
            const res = await setArchivedOwn(api, { uuid: first.uuid, name: first.commonName, kind: 'own' }, true);
            expect(res.status, res.text.slice(0, 200)).toBeLessThan(300);
            return { uuid: first.uuid, own: false, commonName: first.commonName };
        }
        const m = await seedA(api, testInfo, 'API-GEN-23');
        const ids: Record<string, 'C03' | 'C11' | 'C01' | 'C24'> = { 'self-signed': 'C03', 'ca-issued': 'C11', 'attributes-group-owner': 'C01', ca: 'C24' };
        const c = certById(m, ids[variant]);
        return { uuid: c.uuid, own: true, commonName: c.commonName };
    }

    for (const { id, what } of VARIANTS) {
        test(`API-GEN-23[${id}]: the certificate detail, history and download JSON of ${what} conform to the OpenAPI document${id === 'archived' || id.startsWith('existing') ? '' : ' (validate and chain too: own object)'}`,
            meta({
                id: 'API-GEN-23', prio: 'P1', issue: ISSUES,
                rule: ['ledger API-GEN-23 / ilm#428 T4#16 (the published OpenAPI document is the absolute oracle of the response shape; extra members reported, not failed)', 'inventory-api §2.2 r1–r3 (shape), §5.2 r1 (archived is a boolean flag, not a state); core CertificateDetailDto / CertificateEventHistoryDto / CertificateDownloadResponseDto'],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(300_000);
                const v = documentOrSkip();
                const target = await pick(api, testInfo, id);
                test.skip(!target, 'the tier holds fewer certificates than this row needs');
                const { uuid, own, commonName } = target!;
                const problems: string[] = [];

                const detail = await send(api, 'GET', `/api/v1/certificates/${uuid}`);
                problems.push(conformity(v, testInfo, 'detail', detail, response('/v1/certificates/{uuid}')));
                if (detail.status === 200) {
                    const body = detail.json as Json;
                    if (commonName) expect(body.commonName, 'the detail is the certificate asked for').toBe(commonName);
                    if (typeof body.certificateContent === 'string') expect(isBase64(body.certificateContent), 'certificateContent is base64').toBe(true);
                    if (id === 'archived') expect(body.archived, 'an archived certificate reads archived = true').toBe(true);
                }

                const history = await send(api, 'GET', `/api/v1/certificates/${uuid}/history`);
                problems.push(conformity(v, testInfo, 'history', history, response('/v1/certificates/{uuid}/history')));

                const download = await send(api, 'GET', `/api/v1/certificates/${uuid}/raw`, { params: { encoding: 'pem' } });
                problems.push(conformity(v, testInfo, 'download (raw, pem)', download, response('/v1/certificates/{uuid}/{certificateFormat}')));
                if (download.status === 200 && typeof (download.json as Json)?.content === 'string') expect(isBase64((download.json as Json).content), 'the download content is base64').toBe(true);

                if (own) {
                    const validate = await send(api, 'GET', `/api/v1/certificates/${uuid}/validate`);
                    problems.push(conformity(v, testInfo, 'validate', validate, response('/v1/certificates/{uuid}/validate')));
                    const chain = await send(api, 'GET', `/api/v1/certificates/${uuid}/chain`);
                    problems.push(conformity(v, testInfo, 'chain', chain, response('/v1/certificates/{uuid}/chain')));
                }
                expect(problems.filter(Boolean).join('\n'), 'responses that break the published schema').toBe('');
            });
    }
});

test.describe('API-GEN-24 OpenAPI schema validation: detail resources', { tag: tags.api }, () => {
    interface Resource {
        name: string;
        /** How to list its objects (rows carry `uuid`). */
        list: { method: 'GET' | 'POST'; url: string; body?: Json; member?: string };
        /** Detail GETs per row: the OpenAPI path template and the concrete URL. */
        details: Array<{ path: string; url: (row: Json) => string | undefined }>;
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

    async function rowsOfList(api: GuardedApi, l: Resource['list']): Promise<{ status: number; rows: Json[]; text: string }> {
        const p = await send(api, l.method, l.url, l.body ? { data: l.body } : {});
        const json = p.json as Json | Json[] | undefined;
        const rows = Array.isArray(json) ? json : l.member && json && Array.isArray((json as Json)[l.member]) ? ((json as Json)[l.member] as Json[]) : [];
        return { status: p.status, rows, text: p.text };
    }

    for (const r of RESOURCES) {
        test(`API-GEN-24[${r.name}]: the detail of up to 3 existing ${r.name} objects conforms to the OpenAPI document${r.name === 'credential' ? ' (the secret attribute is masked: no data)' : ''}`,
            meta({
                id: 'API-GEN-24', prio: 'P1', issue: ISSUES,
                rule: ['ledger API-GEN-24 / ilm#428 T4#17 (QA#1): the OpenAPI document is the oracle of the detail shape; read-only on existing objects', 'inventory-api §9.2 r4 (a SECRET attribute is serialised without data, ResponseAttributeSerializer)'],
            }),
            async ({ api }, testInfo) => {
                test.setTimeout(240_000);
                const v = documentOrSkip();
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
                            // The secret masking (rules §9.2 r4): a SECRET attribute carries no `data` in any content item.
                            const leak = JSON.stringify((p.json as Json).attributes ?? []).match(/"contentType":"secret"[^}]*"data"/);
                            expect(leak, 'a secret attribute of the credential carries no data').toBeNull();
                        }
                    }
                }
                expect(problems.filter(Boolean).join('\n'), `${r.name} details that break the published schema`).toBe('');
            });
    }

    test('API-GEN-24[own]: the own group and custom attribute of SEED-A (with their custom attribute content) conform to the OpenAPI document',
        meta({ id: 'API-GEN-24', prio: 'P1', issue: ISSUES, rule: ['ledger API-GEN-24 ("+ own"); rules §10.2 r10 (the list item has null customAttributes, the detail the array)'] }),
        async ({ api }, testInfo) => {
            const v = documentOrSkip();
            const m = await seedA(api, testInfo, 'API-GEN-24');
            const problems: string[] = [];
            const group = await send(api, 'GET', `/api/v1/groups/${m.groupUuids.a}`);
            problems.push(conformity(v, testInfo, 'own group', group, response('/v1/groups/{uuid}')));
            const attr = await send(api, 'GET', `/api/v1/attributes/custom/${m.attributeUuids.pick}`);
            problems.push(conformity(v, testInfo, 'own custom attribute (list, multi-select)', attr, response('/v1/attributes/custom/{uuid}')));
            expect(problems.filter(Boolean).join('\n')).toBe('');
        });

    test('API-GEN-24[listViews]: the current user\'s list views (GET /v1/listViews?resource=certificates) conform to the OpenAPI document',
        meta({ id: 'API-GEN-24', prio: 'P1', issue: ISSUES, rule: ['ledger API-GEN-24 (list view); core#2034 (per-user saved views); the detail of a view is the list item (no GET by uuid)'] }),
        async ({ api }, testInfo) => {
            const v = documentOrSkip();
            const p = await send(api, 'GET', '/api/v1/listViews', { params: { resource: 'certificates' } });
            test.skip(p.status === 404, '/v1/listViews answers 404 on this build');
            const problems = conformity(v, testInfo, 'list views', p, response('/v1/listViews'));
            expect(problems, 'list views that break the published schema').toBe('');
        });
});

test.describe('API-GEN-25 OpenAPI schema validation: list and search responses', { tag: tags.api }, () => {
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
        test(`API-GEN-25[${e.name}]: ${e.method} ${e.url} conforms to the OpenAPI document; page invariants; every date-time carries a zone designator`,
            meta({
                id: 'API-GEN-25', prio: 'P1', issue: ISSUES,
                rule: ['ledger API-GEN-25 / ilm#428 T4#18, T4#2 (dates, enums, empty values); QA#4 (absolute): the OpenAPI document is the oracle', 'inventory-api §2.2 r2 (totalPages = ceil(totalItems / itemsPerPage)), §8.2 r1, r7 (statistics shape)'],
            }),
            async ({ api }, testInfo) => {
                const v = documentOrSkip();
                const use = response(e.path, e.method === 'POST' ? 'post' : 'get');
                test.skip(!v.has(use), `the OpenAPI document has no 200 JSON schema for ${e.method} ${e.path}`);
                const p = e.method === 'POST' ? await send(api, 'POST', e.url, { data: SEARCH_BODY }) : e.params ? await send(api, 'GET', e.url, { params: e.params }) : await readProbe(api, e.url);
                test.skip(p.status === 404 || p.status === 403, `${e.url} answers ${p.status} on this build / for this identity: not served here`);
                const problem = conformity(v, testInfo, e.name, p, use);
                const paging = p.status === 200 ? pageProblems(p.json).map((x) => `${e.name}: ${x}`) : [];
                if (e.method === 'POST' && p.status === 200) expect(okJson<Json>(p, e.name).itemsPerPage, 'the requested page size is echoed').toBe(10);
                expect([problem, ...paging].filter(Boolean).join('\n'), `${e.name} breaks the published schema or the page invariants`).toBe('');
            });
    }
});
