/**
 * fakeCertificateCore — a loopback fake of the certificate inventory API, just faithful enough to RUN the API-CERT-41…56 specs end
 * to end offline (their request shapes, the oracle tables, the sort / paging / refusal flows). It models the rules of the inventory-api
 * rules file (§1.3, §2.2, §2.3) — including today's known deviations (core#2505 wildcards, core#2504 500 on an offset-less datetime) —
 * so a spec that asserts the rule over a deviation shows up as the expected `test.fail`. It is NOT an oracle: the same understanding is
 * on both sides, so a green run proves the spec code runs and is internally consistent, never that the real core behaves so.
 *
 * Endpoints: attribute definitions (create / list / detail), groups, users, certificate upload / detail / PATCH, the certificate
 * catalogue and search (property + custom filters, sort, paging, includeArchived), the keys catalogue + search (CKI_LENGTH probe).
 */
import * as crypto from 'crypto';
import { describeCertificate } from '../../../utils/regression/inventoryPki';
import { Answer, Arrived } from './loopbackServer';

type Json = Record<string, any>;

interface Cert {
    uuid: string;
    seq: number;
    commonName: string;
    notBefore: string;
    notAfter: string;
    keyBits: number;
    hash: string;
    issuerCn: string;
    ca: boolean;
    selfSigned: boolean;
    fingerprint: string;
    groups: string[];
    owner: string | null;
    trustedCa: boolean;
    archived: boolean;
    attrs: Map<string, unknown[]>;
}

interface AttrDef {
    uuid: string;
    name: string;
    contentType: string;
    list: boolean;
    multiSelect: boolean;
}

const COLLECTION = new Set(['GROUP_NAME', 'CERT_LOCATION_NAME', 'PRECEDING_CERTIFICATES', 'SUCCEEDING_CERTIFICATES']);
const SETS: Record<string, string[]> = {
    string: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES'],
    number: ['EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'EMPTY', 'NOT_EMPTY'],
    date: ['EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'EMPTY', 'NOT_EMPTY', 'IN_NEXT', 'IN_PAST'],
    list: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
    boolean: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
};
const COUNTS = ['COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN'];

/** property field → type */
const PROPS: Record<string, { type: 'string' | 'list' | 'datetime' | 'boolean'; sortable: boolean; values?: () => unknown[] }> = {
    COMMON_NAME: { type: 'string', sortable: true },
    ISSUER_COMMON_NAME: { type: 'string', sortable: true },
    NOT_AFTER: { type: 'datetime', sortable: true },
    NOT_BEFORE: { type: 'datetime', sortable: true },
    CERTIFICATE_STATE: { type: 'list', sortable: true },
    KEY_SIZE: { type: 'list', sortable: true },
    SUBJECT_TYPE: { type: 'list', sortable: false },
    SIGNATURE_ALGORITHM: { type: 'list', sortable: true },
    PUBLIC_KEY_ALGORITHM: { type: 'list', sortable: true },
    GROUP_NAME: { type: 'list', sortable: true },
    OWNER: { type: 'list', sortable: true },
    RA_PROFILE_NAME: { type: 'list', sortable: true },
    CERT_LOCATION_NAME: { type: 'list', sortable: false },
    PRECEDING_CERTIFICATES: { type: 'list', sortable: false },
    SUCCEEDING_CERTIFICATES: { type: 'list', sortable: false },
    PRIVATE_KEY: { type: 'boolean', sortable: false },
    TRUSTED_CA: { type: 'boolean', sortable: true },
    ARCHIVED: { type: 'boolean', sortable: true },
};

const fail = (status: number, body: unknown): Answer => ({ status, body });
const refuse422 = (...messages: string[]): Answer => ({ status: 422, body: messages });

/** An ISO-8601 duration (the subset the specs use) in milliseconds; undefined when it does not parse. */
function durationMs(s: string): number | undefined {
    const m = /^P(?:(\d+)Y)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
    if (!m || s === 'P' || s.endsWith('T')) return undefined;
    const [y, d, h, mi, se] = [1, 2, 3, 4, 5].map((i) => Number(m[i] ?? 0));
    return (((y * 365 + d) * 24 + h) * 60 + mi) * 60_000 + se * 1000;
}

const likeToRegex = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');

export class FakeCertificateCore {
    private seq = 100;
    readonly certs = new Map<string, Cert>();
    readonly groups = new Map<string, { uuid: string; name: string }>();
    readonly users = new Map<string, { uuid: string; username: string }>();
    readonly attrs = new Map<string, AttrDef>();
    /** Statuses and counts a test can read. */
    readonly requests: string[] = [];

    private next(): string {
        this.seq += 1;
        return `cccccccc-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    }

    answer = (a: Arrived): Answer | undefined => {
        const [path, query = ''] = a.url.split('?');
        this.requests.push(`${a.method} ${path}`);
        let body: Json | undefined;
        if (a.body) {
            try {
                body = JSON.parse(a.body) as Json;
            } catch {
                return fail(400, { message: 'Unable to read HTTP message' });
            }
        }
        if (a.method === 'GET') return this.get(path, query);
        if (a.method === 'POST') return this.post(path, body ?? {});
        if (a.method === 'PATCH') return this.patch(path, body ?? {});
        return { status: 204 };
    };

    // ------------------------------------------------------------------ reads

    private get(path: string, query: string): Answer {
        if (/^\/api\/v1\/attributes\/custom\/resources\/[a-zA-Z]+$/.test(path)) return { status: 200, body: [...this.attrs.values()].map((d) => ({ uuid: d.uuid, name: d.name, contentType: d.contentType, properties: { required: false, list: d.list } })) };
        if (path === '/api/v1/attributes/custom') return { status: 200, body: [...this.attrs.values()].map((d) => ({ uuid: d.uuid, name: d.name, enabled: true })) };
        let m = /^\/api\/v1\/attributes\/custom\/([0-9a-f-]{36})$/.exec(path);
        if (m) return this.attrs.has(m[1]) ? { status: 200, body: { uuid: m[1], name: this.attrs.get(m[1])!.name } } : fail(404, { message: 'not found' });
        m = /^\/api\/v1\/groups\/([0-9a-f-]{36})$/.exec(path);
        if (m) return this.groups.has(m[1]) ? { status: 200, body: this.groups.get(m[1]) } : fail(404, { message: 'not found' });
        m = /^\/api\/v1\/users\/([0-9a-f-]{36})$/.exec(path);
        if (m) return this.users.has(m[1]) ? { status: 200, body: this.users.get(m[1]) } : fail(404, { message: 'not found' });
        m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path);
        if (m) {
            const c = this.certs.get(m[1]);
            return c ? { status: 200, body: this.detail(c) } : fail(404, { message: `Object of type 'Certificate' identified by ${m[1]} is not found.` });
        }
        if (path === '/api/v1/certificates/search') return { status: 200, body: this.catalogue() };
        if (path === '/api/v1/keys/search') {
            return { status: 200, body: [{ filterFieldSource: 'property', searchFieldData: [{ fieldIdentifier: 'CKI_LENGTH', fieldLabel: 'Length', type: 'number', conditions: SETS.number, multiValue: false, displayable: true, sortable: true }] }] };
        }
        return fail(404, { message: `no fake route GET ${path}${query ? `?${query}` : ''}` });
    }

    private detail(c: Cert): Json {
        return {
            uuid: c.uuid, commonName: c.commonName, fingerprint: c.fingerprint, notBefore: c.notBefore, notAfter: c.notAfter, archived: c.archived,
            signatureAlgorithm: c.hash.replace('SHA-', 'SHA') + 'withRSA', publicKeyAlgorithm: 'RSA', key: { uuid: `eeeeeeee-${c.uuid.slice(9)}` },
        };
    }

    private catalogue(): Json[] {
        const certs = [...this.certs.values()];
        const valuesOf = (f: string): unknown[] => {
            if (f === 'KEY_SIZE') return [...new Set(certs.map((c) => c.keyBits))];
            if (f === 'CERTIFICATE_STATE') return ['issued', 'revoked', 'failed'];
            if (f === 'SIGNATURE_ALGORITHM') return [...new Set(certs.map((c) => c.hash.replace('SHA-', 'SHA') + 'withRSA'))];
            if (f === 'PUBLIC_KEY_ALGORITHM') return ['RSA'];
            if (f === 'SUBJECT_TYPE') return ['rootCa', 'endEntity', 'selfSignedEndEntity', 'intermediateCa'];
            if (f === 'GROUP_NAME') return [...this.groups.values()].map((g) => g.name);
            if (f === 'OWNER') return [...this.users.values()].map((u) => u.username);
            return [];
        };
        const property = Object.entries(PROPS).map(([id, p]) => {
            const type = p.type === 'datetime' ? 'datetime' : p.type;
            const conditions = p.type === 'string' ? SETS.string : p.type === 'datetime' ? SETS.date : p.type === 'boolean' ? (id === 'PRIVATE_KEY' ? ['EQUALS', 'NOT_EQUALS'] : SETS.boolean) : [...SETS.list, ...(COLLECTION.has(id) ? COUNTS : [])];
            return { fieldIdentifier: id, fieldLabel: id, type, conditions, multiValue: p.type === 'list', displayable: true, sortable: p.sortable, value: valuesOf(id) };
        });
        const custom = [...this.attrs.values()].map((d) => {
            const type = d.list ? 'list' : d.contentType === 'integer' ? 'number' : d.contentType === 'date' ? 'date' : d.contentType === 'boolean' ? 'boolean' : 'string';
            const conditions = type === 'list' ? SETS.list : SETS[type];
            return { fieldIdentifier: `${d.name}|${d.contentType.toUpperCase()}`, fieldLabel: d.name, type, conditions, multiValue: d.multiSelect, attributeContentType: d.contentType, displayable: true, sortable: true };
        });
        return [{ filterFieldSource: 'property', searchFieldData: property }, ...(custom.length ? [{ filterFieldSource: 'custom', searchFieldData: custom }] : [])];
    }

    // ------------------------------------------------------------------ writes

    private post(path: string, body: Json): Answer {
        if (path === '/api/v1/attributes/custom') {
            const uuid = this.next();
            this.attrs.set(uuid, { uuid, name: body.name, contentType: body.contentType, list: !!body.list, multiSelect: !!body.multiSelect });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/groups') {
            if (!String(body.name ?? '').trim()) return refuse422('Name must not be empty');
            const uuid = this.next();
            this.groups.set(uuid, { uuid, name: body.name });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/users') {
            const uuid = this.next();
            this.users.set(uuid, { uuid, username: body.username });
            return { status: 200, body: { uuid } };
        }
        if (path === '/api/v1/certificates/upload') return this.upload(body);
        if (path === '/api/v1/certificates') return this.search(body);
        if (path === '/api/v1/keys') {
            const f = (body.filters ?? [])[0] as Json | undefined;
            if (f?.fieldIdentifier === 'CKI_LENGTH' && Number.isNaN(Number(f.value))) return refuse422(`Filter field value ${f.value} cannot be parsed as a Number.`);
            return { status: 200, body: { cryptographicKeys: [], itemsPerPage: 1, pageNumber: 1, totalItems: 0, totalPages: 0 } };
        }
        return fail(404, { message: `no fake route POST ${path}` });
    }

    private upload(body: Json): Answer {
        const pem = Buffer.from(String(body.certificate), 'base64').toString('utf8');
        const d = describeCertificate(pem);
        const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
        const uuid = this.next();
        const selfSigned = d.subject === d.issuer;
        const attrs = new Map<string, unknown[]>();
        for (const a of (body.customAttributes ?? []) as Json[]) attrs.set(String(a.uuid), (a.content ?? []).map((c: Json) => c.data));
        this.seq += 1;
        this.certs.set(uuid, {
            uuid, seq: this.seq, commonName: d.subject.replace(/^CN=/, ''), notBefore: d.notBefore.toISOString(), notAfter: d.notAfter.toISOString(), keyBits: d.keyBits,
            hash: d.hash, issuerCn: d.issuer.replace(/^CN=/, ''), ca: d.isCa, selfSigned, fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
            groups: [], owner: null, trustedCa: false, archived: false, attrs,
        });
        return { status: 200, body: { uuid } };
    }

    private patch(path: string, body: Json): Answer {
        const m = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path);
        const c = m ? this.certs.get(m[1]) : undefined;
        if (!c) return fail(404, { message: 'not found' });
        if (Array.isArray(body.groupUuids)) c.groups = [...new Set<string>(body.groupUuids)];
        if (typeof body.ownerUuid === 'string') c.owner = body.ownerUuid || null;
        if (typeof body.trustedCa === 'boolean') c.trustedCa = body.trustedCa;
        return { status: 204 };
    }

    // ------------------------------------------------------------------ the search engine

    private subjectType(c: Cert): string {
        return c.ca ? (c.selfSigned ? 'rootCa' : 'intermediateCa') : c.selfSigned ? 'selfSignedEndEntity' : 'endEntity';
    }

    private propValues(c: Cert, f: string): unknown[] {
        switch (f) {
            case 'COMMON_NAME': return [c.commonName];
            case 'ISSUER_COMMON_NAME': return [c.issuerCn];
            case 'NOT_AFTER': return [Date.parse(c.notAfter)];
            case 'NOT_BEFORE': return [Date.parse(c.notBefore)];
            case 'CERTIFICATE_STATE': return ['issued'];
            case 'KEY_SIZE': return [c.keyBits];
            case 'SUBJECT_TYPE': return [this.subjectType(c)];
            case 'SIGNATURE_ALGORITHM': return [c.hash.replace('SHA-', 'SHA') + 'withRSA'];
            case 'PUBLIC_KEY_ALGORITHM': return ['RSA'];
            case 'GROUP_NAME': return c.groups.map((g) => this.groups.get(g)!.name);
            case 'OWNER': return c.owner ? [this.users.get(c.owner)!.username] : [];
            case 'TRUSTED_CA': return [c.trustedCa];
            case 'ARCHIVED': return [c.archived];
            case 'PRIVATE_KEY': return [false];
            default: return [];
        }
    }

    private matches(c: Cert, f: Json): boolean | Answer {
        const src = f.fieldSource as string;
        const id = String(f.fieldIdentifier);
        const cond = String(f.condition);
        let values: unknown[];
        let type: string;
        let attrContent: string | undefined;
        let notExists = false;
        if (src === 'property') {
            const p = PROPS[id];
            if (!p) return fail(500, { message: 'Internal server error.' });
            type = p.type === 'datetime' ? 'date' : p.type;
            const allowed = id === 'PRIVATE_KEY' ? ['EQUALS', 'NOT_EQUALS'] : p.type === 'string' ? SETS.string : p.type === 'datetime' ? SETS.date : p.type === 'boolean' ? SETS.boolean : [...SETS.list, ...(COLLECTION.has(id) ? COUNTS : [])];
            if (!allowed.includes(cond)) return refuse422(`Field ${id} does not support the ${cond} condition; it supports ${allowed.join(', ')}.`);
            values = this.propValues(c, id);
        } else {
            const parts = id.split('|');
            if (parts.length < 2) return refuse422(`Filter field identifier ${id} does not name an attribute.`);
            const def = [...this.attrs.values()].find((d) => d.name === parts[0] && d.contentType.toUpperCase() === parts[1]);
            if (!def) return false;
            attrContent = def.contentType;
            type = def.list ? 'list' : def.contentType === 'integer' ? 'number' : def.contentType === 'date' ? 'date' : def.contentType === 'boolean' ? 'boolean' : 'string';
            if (!SETS[type].includes(cond)) return refuse422(`Field ${id} does not support the ${cond} condition; it supports ${SETS[type].join(', ')}.`);
            values = c.attrs.get(def.uuid) ?? [];
            notExists = ['NOT_EQUALS', 'NOT_CONTAINS', 'NOT_MATCHES', 'EMPTY'].includes(cond);
        }
        if (cond === 'EMPTY') return values.length === 0;
        if (cond === 'NOT_EMPTY') return values.length > 0;
        if (cond.startsWith('COUNT_')) {
            const n = values.length;
            const raw = f.value;
            if (cond === 'COUNT_GREATER_THAN' || cond === 'COUNT_LESS_THAN') {
                const k = Number(raw);
                if (!Number.isInteger(k) || String(raw).includes('.')) return refuse422(`Filter field value ${raw} cannot be parsed as an Integer.`);
                return cond === 'COUNT_GREATER_THAN' ? n > k : n < k;
            }
            // Today's core (suspected product defect): COUNT_EQUAL / COUNT_NOT_EQUAL do not parse a STRING value, so a non-integer string answers 500 instead of
            // the 422 above; a JSON number is compared as given (1.5 or -1 → 200 with no row, no count equals it).
            if (typeof raw === 'string' && !/^-?\d+$/.test(raw.trim())) return fail(500, { message: 'Internal server error' });
            return cond === 'COUNT_EQUAL' ? n === Number(raw) : n !== Number(raw);
        }
        const wanted: unknown[] = Array.isArray(f.value) ? f.value : f.value === undefined ? [] : [f.value];
        if (wanted.length === 0) {
            if (src === 'property') return refuse422(`Filter for field ${id} with operator ${cond} requires at least one value.`);
            return notExists ? !values.length : false;
        }
        const norm = (v: unknown): unknown => {
            if (type === 'date' && src === 'property') {
                const s = String(v);
                if (cond === 'IN_NEXT' || cond === 'IN_PAST') return s;
                if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) throw Object.assign(new Error('500'), { status: 500 }); // core#2504
                return Date.parse(s.replace(/[+-]\d{2}:\d{2}$/, 'Z')); // the offset is accepted and dropped (Q4)
            }
            if (type === 'number') {
                if (Number.isNaN(Number(v))) throw Object.assign(new Error('422'), { status: 422, text: `Filter field value ${String(v)} cannot be parsed as an Integer.` });
                return Number(v);
            }
            if (type === 'boolean') return String(v) === 'true';
            if (type === 'date') return String(v);
            if (type === 'list' && src === 'property') return typeof v === 'number' ? v : String(v);
            return typeof v === 'number' ? v : String(v);
        };
        let w: unknown[];
        try {
            if (cond === 'IN_NEXT' || cond === 'IN_PAST') {
                const ms = durationMs(String(wanted[0]));
                if (ms === undefined) return refuse422(`Filter field value ${String(wanted[0])} cannot be parsed to a Duration.`);
                const now = Date.now();
                const t = (v: unknown): number => (typeof v === 'number' ? v : Date.parse(String(v)));
                const hit = values.some((v) => (cond === 'IN_NEXT' ? t(v) >= now && t(v) <= now + ms : t(v) <= now && t(v) >= now - ms));
                return notExists ? !hit : hit;
            }
            w = wanted.map(norm);
        } catch (e) {
            const err = e as { status?: number; text?: string };
            if (err.status === 500) return fail(500, { message: 'Internal server error.' });
            if (err.status === 422) return refuse422(String(err.text));
            throw e;
        }
        const vals = values.map((v) => (type === 'date' && src !== 'property' ? String(v) : v));
        const str = (v: unknown): string => String(v);
        const any = (fn: (v: unknown, x: unknown) => boolean): boolean => vals.some((v) => w.some((x) => fn(v, x)));
        switch (cond) {
            case 'EQUALS': return any((v, x) => v === x || str(v) === str(x));
            case 'NOT_EQUALS': return !any((v, x) => v === x || str(v) === str(x));
            case 'CONTAINS': return any((v, x) => likeToRegex(`%${x}%`).test(str(v)));
            case 'NOT_CONTAINS': return !any((v, x) => likeToRegex(`%${x}%`).test(str(v)));
            case 'STARTS_WITH': return any((v, x) => likeToRegex(`${x}%`).test(str(v)));
            case 'ENDS_WITH': return any((v, x) => likeToRegex(`%${x}`).test(str(v)));
            case 'MATCHES':
            case 'NOT_MATCHES': {
                const pattern = str(w[0]);
                try {
                    new RegExp(pattern);
                } catch (e) {
                    return refuse422(`Input is not a valid regex: ${String(e).slice(0, 60)}`);
                }
                if (/\\[QRGhHzXV]/.test(pattern.replace(/\\\\/g, ''))) return refuse422('Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex');
                const hit = vals.some((v) => new RegExp(pattern).test(str(v)));
                if (cond === 'MATCHES') return hit;
                return src === 'property' ? vals.length > 0 && !hit : !hit;
            }
            case 'GREATER': return any((v, x) => (v as number | string) > (x as number | string));
            case 'GREATER_OR_EQUAL': return any((v, x) => (v as number | string) >= (x as number | string));
            case 'LESSER': return any((v, x) => (v as number | string) < (x as number | string));
            case 'LESSER_OR_EQUAL': return any((v, x) => (v as number | string) <= (x as number | string));
            default: return fail(500, { message: 'Internal server error.' });
        }
        void attrContent;
    }

    private sortKey(c: Cert, sort: Json, dir: 'asc' | 'desc'): string | number | null {
        const id = String(sort.fieldIdentifier);
        if (sort.fieldSource === 'property') {
            const v = this.propValues(c, id);
            if (!v.length) return null;
            const sorted = [...v].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
            return sorted[dir === 'asc' ? 0 : sorted.length - 1] as string | number;
        }
        const def = [...this.attrs.values()].find((d) => `${d.name}|${d.contentType.toUpperCase()}` === id);
        const v = def ? c.attrs.get(def.uuid) ?? [] : [];
        if (!v.length) return null;
        const sorted = [...v].sort((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
        return sorted[dir === 'asc' ? 0 : sorted.length - 1] as string | number;
    }

    private search(body: Json): Answer {
        const size = body.itemsPerPage === undefined ? 10 : body.itemsPerPage;
        const page = body.pageNumber === undefined ? 1 : body.pageNumber;
        if (typeof size !== 'number' || typeof page !== 'number') return fail(400, { message: 'Unable to read HTTP message' });
        if (size < 1 || page < 1) return fail(400, { message: 'The request could not be processed.' });
        const sort = body.sort as Json | undefined;
        if (sort) {
            const known = sort.fieldSource === 'property' ? PROPS[String(sort.fieldIdentifier)] : [...this.attrs.values()].some((d) => `${d.name}|${d.contentType.toUpperCase()}` === sort.fieldIdentifier);
            if (!known) return refuse422(`Unknown sort field identifier ${String(sort.fieldIdentifier)}.`);
            if (sort.fieldSource === 'property' && !PROPS[String(sort.fieldIdentifier)].sortable) return refuse422(`Field ${String(sort.fieldIdentifier)} cannot be used to order this listing.`);
        }
        let rows = [...this.certs.values()].filter((c) => body.includeArchived === true || !c.archived);
        for (const f of (body.filters ?? []) as Json[]) {
            const kept: Cert[] = [];
            for (const c of rows) {
                let r: boolean | Answer;
                try {
                    r = this.matches(c, f);
                } catch (e) {
                    return fail(500, { message: String(e) });
                }
                if (typeof r === 'object') return r;
                if (r) kept.push(c);
            }
            rows = kept;
        }
        if (sort) {
            const dir = sort.direction === 'desc' ? 'desc' : 'asc';
            rows.sort((a, b) => {
                const [x, y] = [this.sortKey(a, sort, dir), this.sortKey(b, sort, dir)];
                if (x === null || y === null) return x === y ? (a.uuid < b.uuid ? -1 : 1) : x === null ? 1 : -1;
                if (x === y) return a.uuid < b.uuid ? -1 : 1;
                return (dir === 'asc' ? 1 : -1) * (x < y ? -1 : 1);
            });
        } else {
            rows.sort((a, b) => b.seq - a.seq);
        }
        const total = rows.length;
        const slice = rows.slice((page - 1) * size, page * size);
        return { status: 200, body: { certificates: slice.map((c) => this.detail(c)), itemsPerPage: size, pageNumber: page, totalItems: total, totalPages: Math.ceil(total / size) } };
    }
}
