/**
 * fakeCertificateListApp — a stand-in of the admin UI certificate list with a fake list API.
 *
 * Provides the DOM contract FilterWidget and CertificateListPage rely on (test ids, roles, header ids and aria-sort,
 * portalled selects, the date picker, badges, the empty cell, the pager, the bulk toolbar), served with a fake list API
 * over the seed plan's certificates. A browser context routes the page and the list API to in-memory data (`fakeData`).
 *
 * It proves the page objects' logic (choose, add, badge, remove, sort, page) offline, not the product; the filter tables
 * are proven elsewhere (the table unit tests and the live rows).
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { SEED_A_DEFAULT_ORDER, CertificateSeedPlan, planCertificateSeed } from '../../../utils/regression/inventory/seedFull';
import type { CatalogueGroup } from '../../../utils/regression/inventory/searchApi';
import { JsonObject } from '../../../utils/regression/json';
import { satisfiesFilter } from '../../../utils/regression/inventory/oracles/values';
import type { Scalar } from '../../../utils/regression/inventory/oracles/values';

export const BASE = 'http://127.0.0.1:9';

// ------------------------------------------------------------------ data

export interface FakeRow extends JsonObject {
    uuid: string;
    commonName: string;
}

export interface FakeData {
    plan: CertificateSeedPlan;
    clock: Date;
    /** The list API rows in default order (created descending: C23 … C01, C24). */
    rows: FakeRow[];
}

export function fakeData(clock: Date = new Date('2026-10-14T10:00:00Z')): FakeData {
    const plan = planCertificateSeed(clock, (suffix) => `qa-reg-fake-${suffix}`, 'stamp');
    const byId = new Map(plan.certificates.map((c) => [c.id, c]));
    const rows: FakeRow[] = SEED_A_DEFAULT_ORDER.map((id) => {
        const c = byId.get(id)!;
        const issuer = c.issuedBy ? byId.get(c.issuedBy)!.commonName : c.commonName;
        const uuidOf = (certId: string): string => `00000000-0000-4000-8000-0000000000${certId.slice(1)}`;
        const expired = Date.parse(c.notAfter) < clock.getTime();
        const notYet = Date.parse(c.notBefore) > clock.getTime();
        return {
            uuid: uuidOf(id),
            commonName: c.commonName,
            serialNumber: `0${id.slice(1)}ab`,
            issuerCommonName: issuer,
            // an issued seed links its issuer's row, as the FE does (certificateTableHelpers.tsx:65-70)
            ...(c.issuedBy ? { issuerCertificateUuid: uuidOf(c.issuedBy) } : {}),
            notBefore: c.notBefore,
            notAfter: c.notAfter,
            publicKeyAlgorithm: 'RSA',
            signatureAlgorithm: `${c.hash.replace('-', '')}withRSA`,
            state: 'issued',
            validationStatus: expired ? 'expired' : notYet ? 'inactive' : 'valid',
            complianceStatus: 'notChecked',
            groups: c.groups.map((g) => ({ uuid: `g-${g}`, name: plan.groups[g].name })),
            owner: c.owner ? plan.owner.username : undefined,
            ownerUuid: c.owner ? 'owner-uuid' : undefined,
            certificateType: 'x509',
            privateKeyAvailability: false,
            archived: false,
            keySize: c.keyBits,
            subjectType: c.ca && !c.issuedBy ? 'rootCa' : c.issuedBy ? 'endEntity' : 'selfSignedEndEntity',
        };
    });
    return { plan, clock, rows };
}

export const FAKE_ENUMS = {
    FilterFieldSource: { property: { code: 'property', label: 'Property' }, custom: { code: 'custom', label: 'Custom attribute' } },
    FilterConditionOperator: Object.fromEntries(
        [
            ['EQUALS', 'equals'], ['NOT_EQUALS', 'not equals'], ['GREATER', 'greater than'], ['GREATER_OR_EQUAL', 'greater than or equal'],
            ['LESSER', 'lesser than'], ['LESSER_OR_EQUAL', 'lesser than or equal'], ['CONTAINS', 'contains'], ['NOT_CONTAINS', 'not contains'],
            ['STARTS_WITH', 'starts with'], ['ENDS_WITH', 'ends with'], ['EMPTY', 'empty'], ['NOT_EMPTY', 'not empty'], ['IN_NEXT', 'in next'],
            ['IN_PAST', 'in past'], ['MATCHES', 'matches regex'], ['NOT_MATCHES', 'not matches regex'], ['COUNT_EQUAL', 'count equals'],
            ['COUNT_NOT_EQUAL', 'count not equals'], ['COUNT_GREATER_THAN', 'count greater than'], ['COUNT_LESS_THAN', 'count less than'],
        ].map(([code, label]) => [code, { code, label }]),
    ),
    CertificateState: { issued: { code: 'issued', label: 'Issued' }, revoked: { code: 'revoked', label: 'Revoked' } },
    CertificateValidationStatus: { valid: { code: 'valid', label: 'Valid' }, expired: { code: 'expired', label: 'Expired' }, inactive: { code: 'inactive', label: 'Inactive' } },
    ComplianceStatus: { notChecked: { code: 'notChecked', label: 'Not checked' } },
    CertificateType: { x509: { code: 'x509', label: 'X509' } },
    CertificateSubjectType: { rootCa: { code: 'rootCa', label: 'Root CA' }, endEntity: { code: 'endEntity', label: 'End Entity' } },
    AttributeContentType: { date: { code: 'date', label: 'Date' }, string: { code: 'string', label: 'Text' }, boolean: { code: 'boolean', label: 'Boolean' } },
};

const STRING = ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES'];
const NUMBER = ['EQUALS', 'NOT_EQUALS', 'GREATER', 'GREATER_OR_EQUAL', 'LESSER', 'LESSER_OR_EQUAL', 'EMPTY', 'NOT_EMPTY'];
const DATE = [...NUMBER, 'IN_NEXT', 'IN_PAST'];
const LIST = ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'];
const COLLECTION = [...LIST, 'COUNT_EQUAL', 'COUNT_NOT_EQUAL', 'COUNT_GREATER_THAN', 'COUNT_LESS_THAN'];

export function fakeCatalogue(data: FakeData): CatalogueGroup[] {
    const field = (fieldIdentifier: string, fieldLabel: string, type: string, conditions: string[], extra: JsonObject = {}): JsonObject => ({
        fieldIdentifier, fieldLabel, type, conditions, multiValue: false, displayable: true, sortable: true, ...extra,
    });
    return ([
        {
            filterFieldSource: 'property',
            searchFieldData: [
                field('COMMON_NAME', 'Common Name', 'string', STRING),
                field('NOT_BEFORE', 'Valid From', 'datetime', DATE),
                field('NOT_AFTER', 'Expires At', 'datetime', DATE),
                field('CERTIFICATE_STATE', 'Certificate State', 'list', LIST, { multiValue: true, platformEnum: 'CertificateState', value: ['issued', 'revoked'] }),
                field('GROUP_NAME', 'Groups', 'list', COLLECTION, { multiValue: true, value: Object.values(data.plan.groups).map((g) => ({ uuid: `g-${g.name}`, name: g.name })) }),
                field('OWNER', 'Owner', 'list', LIST, { multiValue: true, value: [data.plan.owner.username] }),
                field('PRIVATE_KEY', 'Has private key', 'boolean', ['EQUALS', 'NOT_EQUALS'], { sortable: false }),
                field('SUBJECT_TYPE', 'Subject Type', 'list', LIST, { multiValue: true, sortable: false, displayable: false, platformEnum: 'CertificateSubjectType', value: ['rootCa', 'endEntity'] }),
                field('KEY_SIZE', 'Key Size', 'list', LIST, { multiValue: true, value: [2048, 3072, 4096] }),
                field('NO_CONDITIONS', 'Ordering only', 'string', [], {}),
            ],
        },
        {
            filterFieldSource: 'custom',
            searchFieldData: [
                field(data.plan.attributes.day.identifier, data.plan.attributes.day.label, 'date', DATE, { attributeContentType: 'date' }),
                field(data.plan.attributes.flag.identifier, data.plan.attributes.flag.label, 'boolean', LIST, { attributeContentType: 'boolean' }),
            ],
        },
    ] as unknown) as CatalogueGroup[];
}

// ------------------------------------------------------------------ the fake list API

const durationMs = (iso: string): number => {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
    if (!m) throw new Error(`bad duration ${iso}`);
    return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0)) * 1000;
};

/**
 * The conditions the fake models per field: anything else throws, so a test that needs a condition the fake never
 * implemented fails loudly instead of getting an answer nobody derived.
 */
const MODELLED: Record<string, readonly string[]> = {
    COMMON_NAME: ['CONTAINS', 'NOT_CONTAINS', 'EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY', 'STARTS_WITH', 'ENDS_WITH', 'MATCHES', 'NOT_MATCHES'],
    NOT_AFTER: ['GREATER_OR_EQUAL', 'LESSER', 'EQUALS', 'EMPTY', 'NOT_EMPTY', 'IN_NEXT', 'IN_PAST'],
    NOT_BEFORE: ['GREATER_OR_EQUAL', 'LESSER', 'EQUALS', 'EMPTY', 'NOT_EMPTY', 'IN_NEXT', 'IN_PAST'],
    CERTIFICATE_STATE: ['EQUALS', 'NOT_EQUALS'],
    KEY_SIZE: ['EQUALS', 'NOT_EQUALS'],
    SUBJECT_TYPE: ['EQUALS', 'NOT_EQUALS'],
    GROUP_NAME: ['EQUALS', 'NOT_EQUALS', 'EMPTY', 'NOT_EMPTY'],
};

/** The fake's routing of a filter to the one evaluator of the filter semantics (`satisfiesFilter`); only the time windows are its own. */
function matchesFilter(row: FakeRow, f: JsonObject, now: number): boolean {
    const condition = String(f.condition);
    if (!MODELLED[String(f.fieldIdentifier)]?.includes(condition)) throw new Error(`the fake list API does not model ${f.fieldIdentifier} ${f.condition}`);
    const holds = (values: Scalar[], value: unknown = f.value, caseSensitive = true): boolean => satisfiesFilter(values, condition, value, { caseSensitive });
    switch (f.fieldIdentifier) {
        case 'COMMON_NAME': {
            const v = String(row.commonName);
            if (condition === 'MATCHES') return new RegExp(String(f.value)).test(v);
            if (condition === 'NOT_MATCHES') return !new RegExp(String(f.value)).test(v);
            return holds(v === '' ? [] : [v]);
        }
        case 'NOT_AFTER':
        case 'NOT_BEFORE': {
            const t = Date.parse(String(row[f.fieldIdentifier === 'NOT_AFTER' ? 'notAfter' : 'notBefore']));
            if (condition === 'IN_NEXT') return t >= now && t <= now + durationMs(f.value as string);
            if (condition === 'IN_PAST') return t <= now && t >= now - durationMs(f.value as string);
            return holds(Number.isNaN(t) ? [] : [t], condition === 'EMPTY' || condition === 'NOT_EMPTY' ? undefined : Date.parse(f.value as string));
        }
        case 'CERTIFICATE_STATE':
            return holds([String(row.state)]);
        case 'KEY_SIZE':
        case 'SUBJECT_TYPE':
            return holds([String(row[f.fieldIdentifier === 'KEY_SIZE' ? 'keySize' : 'subjectType'])]);
        case 'GROUP_NAME':
            return holds((row.groups as Array<{ name: string }>).map((g) => g.name));
    }
    throw new Error(`the fake list API does not model ${f.fieldIdentifier} ${f.condition}`);
}

const sortKeyOf = (row: FakeRow, field: string, direction: 'asc' | 'desc'): string | number | null => {
    if (field === 'NOT_AFTER') return Date.parse(String(row.notAfter));
    if (field === 'NOT_BEFORE') return Date.parse(String(row.notBefore));
    if (field === 'OWNER') return (row.owner ?? null) as string | null;
    if (field === 'GROUP_NAME') {
        const names = (row.groups as Array<{ name: string }>).map((g) => g.name).sort();
        return names.length ? (direction === 'asc' ? names[0] : names[names.length - 1]) : null;
    }
    if (field === 'COMMON_NAME') return String(row.commonName);
    throw new Error(`the fake list API cannot sort by ${field}`);
};

/**
 * The list answer for a request body: filters ANDed, sort (empty last both ways, uuid tie-break), paging; default order = created
 * descending.
 */
export function listAnswer(data: FakeData, body: JsonObject): { status: number; json: unknown } {
    const now = data.clock.getTime();
    let rows = [...data.rows];
    try {
        for (const f of (body.filters ?? []) as JsonObject[]) {
            if (f.fieldIdentifier === 'COMMON_NAME' && f.condition === 'EQUALS' && f.value === '__refuse__') return { status: 422, json: ['Input is not a valid value (refused by the fake)'] };
            rows = rows.filter((row) => matchesFilter(row, f, now));
        }
    } catch (error) {
        return { status: 422, json: [String((error as Error).message)] };
    }
    if (body.sort) {
        const { fieldIdentifier, direction } = body.sort as { fieldIdentifier: string; direction: 'asc' | 'desc' };
        const keyed = rows.map((row) => ({ row, key: sortKeyOf(row, fieldIdentifier, direction) }));
        const present = keyed.filter((k) => k.key !== null);
        const absent = keyed.filter((k) => k.key === null);
        const cmp = (a: { row: FakeRow; key: string | number | null }, b: { row: FakeRow; key: string | number | null }): number => {
            const sign = a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0;
            return (direction === 'asc' ? sign : -sign) || a.row.uuid.localeCompare(b.row.uuid);
        };
        rows = [...present.sort(cmp), ...absent.sort((a, b) => a.row.uuid.localeCompare(b.row.uuid))].map((k) => k.row);
    }
    const size = Number(body.itemsPerPage ?? 10);
    const pageNumber = Number(body.pageNumber ?? 1);
    return {
        status: 200,
        json: {
            certificates: rows.slice((pageNumber - 1) * size, pageNumber * size),
            itemsPerPage: size,
            pageNumber,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / size),
        },
    };
}

// ------------------------------------------------------------------ serving

export interface Served {
    page: Page;
    context: BrowserContext;
    data: FakeData;
    /** Every certificate list request body the fake received, in order. */
    listRequests: JsonObject[];
    /** Replaces the rows the fake serves (e.g. to plant a `null` word in a name). */
    setRows(rows: FakeRow[]): void;
    close(): Promise<void>;
}

export async function serveInventory(browser: Browser, opts: { data?: FakeData; slowListMs?: number; timezoneId?: string } = {}): Promise<Served> {
    const data = opts.data ?? fakeData();
    const listRequests: JsonObject[] = [];
    const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}) });
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === '/api/v1/enums' && method === 'GET') return route.fulfill({ json: FAKE_ENUMS });
        if (url.pathname === '/api/v1/certificates/search' && method === 'GET') return route.fulfill({ json: fakeCatalogue(data) });
        if (url.pathname === '/api/v1/certificates' && method === 'POST') {
            const body = JSON.parse(route.request().postData() ?? '{}') as JsonObject;
            listRequests.push(body);
            if (opts.slowListMs) await new Promise((resolve) => setTimeout(resolve, opts.slowListMs));
            const answer = listAnswer(data, body);
            return route.fulfill({ status: answer.status, json: answer.json });
        }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: APP_HTML });
        return route.fulfill({ status: 404, body: 'not found' });
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/`);
    return {
        page,
        context,
        data,
        listRequests,
        setRows: (rows) => void (data.rows = rows),
        close: () => context.close(),
    };
}

// ------------------------------------------------------------------ the app (vanilla JS)

const APP_CSS = `
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.uppercase{text-transform:uppercase}
.fixed{position:fixed;top:60px;left:60px;z-index:9999;background:#fff;border:1px solid #ccc;width:320px}
[data-testid=widget-busy-overlay]{position:absolute;inset:0}
`;

const APP_JS = String.raw`
(function () {
  var ENUMS = null, CAT = null;
  var S = { filters: [], draft: { source: null, field: null, cond: null, value: undefined }, badge: -1, sort: null, page: 1, size: 10, archived: false,
    checked: [], rows: [], total: 0, totalPages: 0, loading: true, loaded: false, openSelect: null, menu: null, cal: null, alerts: [], alertId: 0 };
  var root = document.getElementById('root');
  var portal = document.getElementById('portal');
  var toasts = document.getElementById('toasts');
  var selects = {};
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var COLUMNS = [
    ['CERTIFICATE_STATE','State'],['CERTIFICATE_VALIDATION_STATUS','Validation'],['COMPLIANCE_STATUS','Compliance'],['PRIVATE_KEY','Has private key'],
    ['COMMON_NAME','Common Name'],['NOT_BEFORE','Valid From'],['NOT_AFTER','Expires At'],['GROUP_NAME','Groups'],['RA_PROFILE_NAME','RA Profile'],['OWNER','Owner'],
    ['SERIAL_NUMBER','Serial number'],['SIGNATURE_ALGORITHM','Signature Algorithm'],['PUBLIC_KEY_ALGORITHM','Public Key Algorithm'],
    ['ISSUER_COMMON_NAME','Issuer Common Name'],['CERTIFICATE_TYPE','Certificate Type'],['ARCHIVED','Archived']
  ];

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === false || v === null || v === undefined) return;
      if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]).flat(Infinity);
      kids.forEach(function (kid) { if (kid === null || kid === undefined || kid === false) return; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); });
    }
    return el;
  }
  function label(en, code) { return ENUMS[en] && ENUMS[en][code] ? ENUMS[en][code].label : code; }
  function pad(n) { return ('0' + n).slice(-2); }
  function fmtLocal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function isoFromInput(s) {
    var re = /(\d{1,10})\s*([dhms])/gi, m, d = 0, hh = 0, mi = 0, se = 0;
    while ((m = re.exec(s))) { var n = parseInt(m[1], 10), u = m[2].toLowerCase(); if (u === 'd') d += n; if (u === 'h') hh += n; if (u === 'm') mi += n; if (u === 's') se += n; }
    var time = (hh ? hh + 'H' : '') + (mi ? mi + 'M' : '') + (se ? se + 'S' : '');
    var r = 'P' + (d ? d + 'D' : '') + (time ? 'T' + time : '');
    return r === 'P' ? 'PT0S' : r;
  }
  function inputFromIso(s) {
    var out = [];
    var d = /(\d+)D/.exec(s), hh = /(\d+)H/.exec(s), mi = /(\d+)M/.exec(s), se = /(\d+)S/.exec(s);
    if (d) out.push(d[1] + 'd'); if (hh) out.push(hh[1] + 'h'); if (mi) out.push(mi[1] + 'm'); if (se) out.push(se[1] + 's');
    return out.join(' ');
  }
  function validDuration(v) { return !v || !v.trim() || /^(\d{1,10}\s*[dhms]\s*)+$/.test(v.trim()); }

  function currentGroup() { return CAT.filter(function (g) { return g.filterFieldSource === S.draft.source; })[0]; }
  function currentField() { var g = currentGroup(); return g && g.searchFieldData.filter(function (f) { return f.fieldIdentifier === S.draft.field; })[0]; }
  function isDateType(t) { return t === 'date' || t === 'datetime'; }
  function isInterval(c) { return c === 'IN_NEXT' || c === 'IN_PAST'; }
  function noValue(c) { return c === 'EMPTY' || c === 'NOT_EMPTY'; }

  function addDisabled() {
    if (!S.draft.field || !S.draft.cond) return true;
    if (isInterval(S.draft.cond) && !validDuration(S.draft.value)) return true;
    if (!noValue(S.draft.cond) && (S.draft.value == null || S.draft.value === '' )) return true;
    if (!noValue(S.draft.cond) && Array.isArray(S.draft.value) && !S.draft.value.length) return true;
    return false;
  }

  function select(o) {
    selects[o.id] = o;
    var text = o.display;
    return h('div', { 'data-testid': 'select-' + o.id },
      o.label ? h('label', { for: o.id }, o.label) : null,
      h('button', { type: 'button', 'data-testid': 'select-' + o.id + '-trigger', 'aria-haspopup': 'listbox', disabled: !!o.disabled,
        onclick: function () { S.openSelect = S.openSelect === o.id ? null : o.id; renderPortal(); } }, text || ''),
      h('select', { id: o.id, 'aria-hidden': 'true', class: 'sr-only', 'data-testid': 'select-' + o.id + '-input' }));
  }
  function renderPortal() {
    portal.replaceChildren();
    if (S.menu) {
      var col = S.menu;
      var sortable = !!sortableOf(col);
      var items = [h('div', { role: 'menuitem', 'data-testid': 'column-header-menu-property:' + col + '-sort-asc', 'aria-disabled': sortable ? null : 'true',
        onclick: function () { if (sortable) { S.menu = null; applySort(col, 'asc'); } } }, 'Sort ascending'),
        h('div', { role: 'menuitem', 'data-testid': 'column-header-menu-property:' + col + '-sort-desc', 'aria-disabled': sortable ? null : 'true',
        onclick: function () { if (sortable) { S.menu = null; applySort(col, 'desc'); } } }, 'Sort descending')];
      if (!sortable) items.push(h('div', { 'data-testid': 'column-header-menu-property:' + col + '-sort-unavailable' }, 'This field cannot be used for ordering.'));
      portal.append(h('div', { role: 'menu', 'data-testid': 'column-header-menu-property:' + col }, items));
    }
    var cfg = S.openSelect && selects[S.openSelect];
    if (cfg) {
      var opts = cfg.options.length ? cfg.options.map(function (opt) {
        return h('div', { role: 'option', 'data-value': String(opt.value), 'aria-selected': cfg.isSelected(opt) ? 'true' : 'false',
          onclick: function () { cfg.onPick(opt); if (!cfg.multi) S.openSelect = null; render(); } }, opt.label);
      }) : [h('div', {}, 'No options')];
      portal.append(h('div', { role: 'dialog', 'data-testid': 'select-' + S.openSelect + '-content' }, h('div', { role: 'listbox' }, opts)));
    }
    // The real picker portals its calendar straight into <body> (createPortal(..., document.body)): a body child, not inside a wrapper.
    document.querySelectorAll('body > [data-calendar]').forEach(function (el) { el.remove(); });
    if (S.cal) { var cal = calendar(); cal.setAttribute('data-calendar', ''); document.body.append(cal); }
    renderToasts();
  }
  function renderToasts() {
    toasts.replaceChildren();
    S.alerts.forEach(function (a) { toasts.append(h('div', { 'data-testid': 'alert-' + a.id, role: 'alert' }, h('span', { 'data-testid': 'alert-message-' + a.id }, a.text))); });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (S.openSelect || S.menu) { S.openSelect = null; S.menu = null; renderPortal(); } }
  });

  // ---- date picker (components/DatePicker)
  function openCalendar(timePicker) {
    var now = new Date();
    S.cal = { month: now.getMonth(), year: now.getFullYear(), time: { h: 0, m: 0, s: 0 }, sel: null, timePicker: timePicker };
    renderPortal();
  }
  function calendar() {
    var c = S.cal;
    var dim = new Date(c.year, c.month + 1, 0).getDate();
    var first = new Date(c.year, c.month, 1).getDay(); first = first === 0 ? 6 : first - 1;
    var cells = [];
    for (var i = 0; i < first; i++) cells.push({ d: 1, cur: false });
    for (var d = 1; d <= dim; d++) cells.push({ d: d, cur: true });
    while (cells.length < 42) cells.push({ d: cells.length % 7 + 1, cur: false });
    var rows = [];
    for (var r = 0; r < 6; r++) rows.push(h('div', {}, cells.slice(r * 7, r * 7 + 7).map(function (cell) {
      return h('button', { type: 'button', disabled: !cell.cur, onclick: function () { if (cell.cur) selectDay(cell.d); } }, String(cell.d));
    })));
    var body = [
      h('div', {}, h('button', { type: 'button', 'aria-label': 'Previous', onclick: function () { c.month--; if (c.month < 0) { c.month = 11; c.year--; } renderPortal(); } }, '<'),
        h('span', {}, MONTHS[c.month]), h('span', {}, '/'), h('span', {}, String(c.year)),
        h('button', { type: 'button', 'aria-label': 'Next', onclick: function () { c.month++; if (c.month > 11) { c.month = 0; c.year++; } renderPortal(); } }, '>')),
      h('div', {}, ['Mo','Tu','We','Th','Fr','Sa','Su'].map(function (w) { return h('span', {}, w); })),
      rows
    ];
    if (c.timePicker) {
      var timeInput = function (key, id) { return h('input', { type: 'number', id: id, value: String(c.time[key]), oninput: function (e) { c.time[key] = Math.max(0, parseInt(e.target.value, 10) || 0); emitDate(); } }); };
      body.push(h('div', {}, h('label', { for: 'datepicker-time-hours' }, 'Time:'), timeInput('h', 'datepicker-time-hours'), timeInput('m'), timeInput('s'),
        h('button', { type: 'button', onclick: function () { S.cal = null; renderPortal(); } }, 'Cancel'),
        h('button', { type: 'button', onclick: function () { S.cal = null; render(); } }, 'Confirm')));
    }
    return h('div', { class: 'fixed' }, body);
  }
  function selectDay(day) {
    S.cal.sel = new Date(S.cal.year, S.cal.month, day);
    emitDate();
    if (!S.cal.timePicker) { S.cal = null; render(); } else renderPortal();
  }
  function emitDate() {
    var c = S.cal; if (!c || !c.sel) return;
    var v = c.sel.getFullYear() + '-' + pad(c.sel.getMonth() + 1) + '-' + pad(c.sel.getDate());
    if (c.timePicker) v += 'T' + pad(c.time.h) + ':' + pad(c.time.m) + ':' + pad(c.time.s);
    S.draft.value = v;
    var shown = pad(c.sel.getDate()) + '.' + pad(c.sel.getMonth() + 1) + '.' + c.sel.getFullYear() + (c.timePicker ? ' ' + pad(c.time.h) + ':' + pad(c.time.m) + ':' + pad(c.time.s) : '');
    S.draft.shown = shown;
    var input = document.getElementById('valueSelect');
    if (input) input.value = shown;
    var add = document.getElementById('addFilter'); if (add) add.disabled = addDisabled();
  }

  // ---- value control
  function valueControl() {
    var f = currentField(), cond = S.draft.cond;
    var disabled = !f || !cond || noValue(cond);
    if (isInterval(cond) && f && isDateType(f.type)) {
      return h('div', {}, textInput('text', 'eg. 2d 30m', false), h('p', {}, 'Duration in format: 0d 0h 0m 0s'));
    }
    if (!f || f.type === 'string' || f.type === 'number' || isDateType(f.type)) {
      if (f && isDateType(f.type)) {
        var tp = f.type === 'datetime';
        var shown = S.draft.shown || '';
        return h('input', { id: 'valueSelect', type: 'text', readonly: true, placeholder: tp ? 'dd.mm.yyyy 00:00:00' : 'dd.mm.yyyy', disabled: disabled, value: shown,
          onclick: function () { if (!disabled) openCalendar(tp); } });
      }
      return textInput(f && f.type === 'number' ? 'number' : 'text', 'Enter filter value', disabled);
    }
    var opts, multi;
    if (f.type === 'boolean') { opts = [{ label: 'True', value: true }, { label: 'False', value: false }]; multi = false; }
    else {
      multi = !!f.multiValue;
      opts = (f.value || []).map(function (v) {
        var lab = typeof v === 'object' ? (v.name || JSON.stringify(v)) : (f.platformEnum ? label(f.platformEnum, v) : String(v));
        return { label: lab, value: v };
      });
    }
    var cur = S.draft.value;
    return select({ id: 'valueSelect', options: opts, multi: multi, disabled: disabled,
      display: multi ? (Array.isArray(cur) ? cur.map(function (x) { return x.label; }).join(', ') : '') : (cur ? cur.label : ''),
      isSelected: function (opt) { return multi ? (Array.isArray(cur) && cur.some(function (x) { return x.value === opt.value; })) : !!cur && cur.value === opt.value; },
      onPick: function (opt) {
        if (multi) {
          var arr = Array.isArray(S.draft.value) ? S.draft.value.slice() : [];
          var idx = arr.findIndex(function (x) { return x.value === opt.value; });
          if (idx >= 0) arr.splice(idx, 1); else arr.push({ label: opt.label, value: opt.value });
          S.draft.value = arr.length ? arr : undefined;
        } else S.draft.value = { label: opt.label, value: opt.value };
      } });
  }
  function textInput(type, placeholder, disabled) {
    var input = h('input', { id: 'valueSelect', 'data-testid': 'text-input-valueSelect', type: type, placeholder: placeholder, disabled: !!disabled, readonly: true });
    input.value = typeof S.draft.value === 'string' || typeof S.draft.value === 'number' ? String(S.draft.value) : '';
    input.addEventListener('focus', function () { input.removeAttribute('readonly'); });
    input.addEventListener('input', function () { S.draft.value = input.value; var add = document.getElementById('addFilter'); if (add) add.disabled = addDisabled(); });
    return input;
  }

  // ---- filter widget
  function computeValue() {
    var v = S.draft.value, f = currentField();
    if (v == null || v === '') return undefined;
    if (typeof v === 'string') {
      if (isDateType(f.type) && isInterval(S.draft.cond)) return isoFromInput(v);
      if (f.type === 'datetime') return new Date(v).toISOString();
      if (f.type === 'date') return new Date(v).toISOString().split('T')[0];
      return v;
    }
    if (Array.isArray(v)) return v.map(function (x) { return x.value; });
    return v.value;
  }
  function wireValue(v) { return Array.isArray(v) ? v.map(function (x) { return (typeof x === 'object' && x && x.name) ? x.name : x; }) : v; }
  function onAdd() {
    var f = currentField();
    var dup = S.filters.some(function (x, i) { return i !== S.badge && x.fieldSource === S.draft.source && x.fieldIdentifier === S.draft.field && x.condition === S.draft.cond; });
    if (dup) { S.alerts.push({ id: ++S.alertId, text: 'A filter with the same field and condition already exists' }); renderToasts(); return; }
    var item = { fieldSource: S.draft.source, fieldIdentifier: S.draft.field, condition: S.draft.cond, value: computeValue() };
    var raw = computeValueRaw(item);
    if (S.badge === -1) S.filters.push(raw); else S.filters[S.badge] = raw;
    S.badge = -1; S.page = 1; S.draft = { source: null, field: null, cond: null, value: undefined }; S.cal = null;
    load();
  }
  function computeValueRaw(item) { var o = { fieldSource: item.fieldSource, fieldIdentifier: item.fieldIdentifier, condition: item.condition }; if (item.value !== undefined) o.value = wireValue(item.value); return o; }
  function badgeValue(fl, fd) {
    if (fd && fd.type === 'boolean') return "'" + (fl.value ? 'True' : 'False') + "'";
    if (Array.isArray(fl.value)) return "'" + fl.value.map(function (v) { return fd && fd.platformEnum ? label(fd.platformEnum, v) : String(v); }).join(' OR ') + "'";
    var v = fl.value;
    if (v == null || v === '') return "''";
    if (typeof v === 'number') return "'" + v + "'";
    if (fd && isDateType(fd.type) && isInterval(fl.condition)) return "'" + inputFromIso(String(v)) + "'";
    if (fd && fd.platformEnum) return "'" + label(fd.platformEnum, String(v)) + "'";
    if (fd && fd.type === 'datetime') return "'" + fmtLocal(new Date(v)) + "'";
    return "'" + v + "'";
  }
  function badge(fl, i) {
    var g = CAT.filter(function (x) { return x.filterFieldSource === fl.fieldSource; })[0];
    var fd = g && g.searchFieldData.filter(function (x) { return x.fieldIdentifier === fl.fieldIdentifier; })[0];
    var remove = h('button', { type: 'button', onclick: function (e) { e.stopPropagation(); S.filters.splice(i, 1); S.badge = -1; S.page = 1; load(); } },
      h('span', { class: 'sr-only' }, 'Remove badge'));
    return h('button', { type: 'button', 'data-testid': 'badge', onclick: function () { editBadge(i); } },
      h('b', {}, label('FilterFieldSource', fl.fieldSource) + ' '), "'" + (fd ? fd.fieldLabel : fl.fieldIdentifier) + "' " + label('FilterConditionOperator', fl.condition) + ' ' + badgeValue(fl, fd), remove);
  }
  function editBadge(i) {
    var fl = S.filters[i];
    S.badge = S.badge === i ? -1 : i;
    if (S.badge === -1) S.draft = { source: null, field: null, cond: null, value: undefined };
    else S.draft = { source: fl.fieldSource, field: fl.fieldIdentifier, cond: fl.condition, value: typeof fl.value === 'string' ? fl.value : undefined };
    render();
  }
  function filterWidget() {
    var g = currentGroup();
    var fields = g ? g.searchFieldData.filter(function (f) { return f.conditions.length > 0; }) : [];
    var f = currentField();
    return h('section', {}, h('h5', {}, 'Certificate Inventory Filter'),
      h('div', {},
        select({ id: 'group', label: 'Filter Field Source', options: CAT.map(function (x) { return { label: label('FilterFieldSource', x.filterFieldSource), value: x.filterFieldSource }; }),
          display: S.draft.source ? label('FilterFieldSource', S.draft.source) : '', isSelected: function (o) { return o.value === S.draft.source; },
          onPick: function (o) { S.draft = { source: o.value, field: null, cond: null, value: undefined }; S.cal = null; } }),
        select({ id: 'field', label: 'Filter Field', disabled: !S.draft.source, options: fields.map(function (x) { return { label: x.fieldLabel, value: x.fieldIdentifier }; }),
          display: f ? f.fieldLabel : '', isSelected: function (o) { return o.value === S.draft.field; },
          onPick: function (o) { S.draft = { source: S.draft.source, field: o.value, cond: null, value: undefined }; S.cal = null; } }),
        select({ id: 'conditions', label: 'Filter Condition', disabled: !S.draft.field, options: f ? f.conditions.map(function (c) { return { label: label('FilterConditionOperator', c), value: c }; }) : [],
          display: S.draft.cond ? label('FilterConditionOperator', S.draft.cond) : '', isSelected: function (o) { return o.value === S.draft.cond; },
          onPick: function (o) { S.draft = { source: S.draft.source, field: S.draft.field, cond: o.value, value: undefined }; S.cal = null; } }),
        h('div', {}, h('label', { for: 'valueSelect' }, 'Filter Value'), valueControl()),
        h('button', { id: 'addFilter', type: 'button', disabled: addDisabled(), onclick: onAdd }, S.badge === -1 ? 'Add' : 'Update')),
      h('div', {}, S.filters.map(badge)),
      h('div', { 'data-testid': 'switch-archived-switch' }, h('label', { for: 'archived-switch' }, 'Include archived'),
        h('label', { for: 'archived-switch' }, h('input', { type: 'checkbox', id: 'archived-switch', class: 'sr-only', 'data-testid': 'switch-archived-switch-input', checked: S.archived,
          onchange: function (e) { S.archived = e.target.checked; S.page = 1; load(); } }))));
  }

  // ---- list
  function sortableOf(col) { var g = CAT[0]; var f = g.searchFieldData.filter(function (x) { return x.fieldIdentifier === col; })[0]; return !!(f && f.sortable); }
  function applySort(col, dir) { S.sort = { fieldSource: 'property', fieldIdentifier: col, direction: dir }; S.page = 1; load(); }
  function onSortClick(col) { var dir = S.sort && S.sort.fieldIdentifier === col && S.sort.direction === 'asc' ? 'desc' : 'asc'; applySort(col, dir); }
  function header(col, idx) {
    var id = col[0], text = col[1], key = 'property:' + id;
    var sorted = S.sort && S.sort.fieldIdentifier === id ? S.sort.direction : null;
    var sortable = sortableOf(id);
    var arrow = h('svg', { 'data-testid': 'sort-indicator', 'data-direction': sorted || 'none', 'aria-hidden': 'true' });
    var heading = h('span', { id: 'h' + idx }, text);
    return h('th', { 'data-id': key, 'aria-labelledby': 'h' + idx, 'aria-sort': sortable && sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : null, class: 'uppercase' },
      sortable ? h('button', { type: 'button', onclick: function () { onSortClick(id); } }, heading, ' ', arrow) : heading,
      h('button', { type: 'button', 'aria-label': 'Column options for ' + text, 'data-testid': 'column-header-menu-' + key + '-trigger', onclick: function () { S.menu = id; renderPortal(); } }, ':'));
  }
  function empty() { return h('span', { 'data-testid': 'empty-cell' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, 'No value')); }
  function cell(id, r) {
    function orEmpty(v, node) { return v === null || v === undefined || v === '' ? empty() : (node || String(v)); }
    switch (id) {
      case 'CERTIFICATE_STATE': return h('span', { 'data-testid': 'certificate-status' }, h('span', { class: 'sr-only' }, cap(label('CertificateState', r.state))));
      case 'CERTIFICATE_VALIDATION_STATUS': return h('span', { 'data-testid': 'certificate-status' }, h('span', { class: 'sr-only' }, cap(label('CertificateValidationStatus', r.validationStatus))));
      case 'COMPLIANCE_STATUS': return r.complianceStatus ? h('span', { 'data-testid': 'certificate-status' }, h('span', { class: 'sr-only' }, cap(label('ComplianceStatus', r.complianceStatus)))) : empty();
      case 'PRIVATE_KEY': return r.privateKeyAvailability ? h('span', {}, h('span', { class: 'sr-only' }, 'Private key available')) : empty();
      case 'COMMON_NAME': return h('a', { href: '#/certificates/detail/' + r.uuid }, r.commonName || '(empty)');
      case 'NOT_BEFORE': return r.notBefore ? h('span', {}, fmtLocal(new Date(r.notBefore))) : empty();
      case 'NOT_AFTER': return r.notAfter ? h('span', {}, fmtLocal(new Date(r.notAfter))) : empty();
      case 'GROUP_NAME':
        if (!r.groups || !r.groups.length) return empty();
        return h('span', {}, h('a', { href: '#/groups/detail/' + r.groups[0].uuid }, r.groups[0].name), r.groups.length > 1 ? h('button', { type: 'button', 'aria-label': 'Show all ' + r.groups.length + ' values' }, '+' + (r.groups.length - 1)) : null);
      case 'RA_PROFILE_NAME': return r.raProfile ? h('span', {}, r.raProfile.name) : empty();
      case 'OWNER': return r.owner ? h('a', { href: '#/users/detail/' + r.ownerUuid }, r.owner) : empty();
      case 'SERIAL_NUMBER': return orEmpty(r.serialNumber);
      case 'SIGNATURE_ALGORITHM': return orEmpty(r.signatureAlgorithm);
      case 'PUBLIC_KEY_ALGORITHM': return orEmpty(r.publicKeyAlgorithm);
      case 'ISSUER_COMMON_NAME': return r.issuerCommonName && r.issuerCertificateUuid ? h('a', { href: '#/certificates/detail/' + r.issuerCertificateUuid }, r.issuerCommonName) : orEmpty(r.issuerCommonName);
      case 'CERTIFICATE_TYPE': return r.certificateType ? h('span', {}, label('CertificateType', r.certificateType)) : empty();
      case 'ARCHIVED': return h('span', { 'data-testid': 'badge' }, r.archived ? 'Yes' : 'No');
    }
    return empty();
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function pageSizeSelect() {
    return select({ id: 'pageSize', options: [10, 25, 50, 100].map(function (n) { return { label: String(n), value: String(n) }; }), disabled: S.loading, display: String(S.size),
      isSelected: function (o) { return o.value === String(S.size); },
      onPick: function (o) {
        var n = parseInt(o.value, 10); var firstVisible = Math.min(Math.max((S.page - 1) * S.size + 1, 1), S.total || 1);
        S.size = n; S.page = Math.max(1, Math.ceil(firstVisible / n)); S.checked = []; load();
      } });
  }
  function pager() {
    var pages = []; for (var i = 1; i <= S.totalPages; i++) pages.push(i);
    return h('div', { 'data-testid': 'pagination' }, h('nav', { 'aria-label': 'Pagination' },
      h('button', { type: 'button', 'aria-label': 'Previous', 'data-testid': 'pagination-prev', disabled: S.loading || S.page === 1, onclick: function () { go(S.page - 1); } }, 'Previous'),
      pages.map(function (n) { return h('button', { type: 'button', 'data-testid': 'pagination-page-' + n, 'aria-current': n === S.page ? 'page' : null, disabled: S.loading, onclick: function () { go(n); } }, String(n)); }),
      h('button', { type: 'button', 'aria-label': 'Next', 'data-testid': 'pagination-next', disabled: S.loading || S.page === S.totalPages, onclick: function () { go(S.page + 1); } }, 'Next')));
  }
  function go(n) { S.page = n; S.checked = []; load(); }
  function listWidget() {
    var rows = S.rows.map(function (r) {
      return h('tr', { 'data-id': r.uuid }, h('td', {}, h('input', { type: 'checkbox', id: r.uuid + '__checkbox__', 'data-testid': 'checkbox', checked: S.checked.indexOf(r.uuid) >= 0, disabled: S.loading,
        onchange: function (e) { var i = S.checked.indexOf(r.uuid); if (e.target.checked && i < 0) S.checked.push(r.uuid); if (!e.target.checked && i >= 0) S.checked.splice(i, 1); render(); } }),
        h('label', { for: r.uuid + '__checkbox__', class: 'sr-only' }, 'Checkbox')),
        COLUMNS.map(function (c) { return h('td', {}, h('div', {}, cell(c[0], r))); }));
    });
    var nonDefault = S.filters.length > 0 || S.page > 1 || S.size !== 10 || !!S.sort;
    var tool = ['group', 'user-check', 'shield-check', 'download', 'archive', 'unarchive'].map(function (n) { return h('button', { type: 'button', 'data-testid': n + '-button', disabled: S.checked.length === 0 }, n); });
    return h('section', { style: 'position:relative' }, h('h5', {}, 'List of Certificates'),
      nonDefault ? h('button', { type: 'button', 'data-testid': 'reset-view-icon', 'aria-label': 'Reset filters, sorting and pagination', onclick: onReset }, 'reset') : null,
      tool,
      S.loading && S.rows.length ? h('div', { 'data-testid': 'widget-busy-overlay' }) : null,
      h('div', { 'data-testid': 'custom-table' },
        h('table', {}, h('thead', {}, h('tr', {}, h('th', { 'data-id': '__checkbox__' }, h('input', { type: 'checkbox', id: '__checkbox____checkbox__', 'data-testid': 'checkbox' })), COLUMNS.map(header))),
          h('tbody', {}, S.loading && !S.rows.length ? [h('tr', { 'data-testid': 'table-skeleton-row' }, h('td', {}, '...'))] : rows)),
        !S.loading && !S.rows.length ? h('div', {}, 'No items to show') : null,
        h('div', {}, h('div', {}, S.rows.length ? pageSizeSelect() : null), S.totalPages > 1 ? pager() : null,
          S.rows.length || S.total ? h('div', { class: 'text-sm' }, h('div', {}, 'Showing ' + ((S.page - 1) * S.size + 1) + ' to ' + Math.min((S.page - 1) * S.size + S.rows.length, S.total) + ' items of ' + S.total)) : null)));
  }
  function onReset() { S.filters = []; S.page = 1; S.size = 10; S.sort = null; S.checked = []; load(); }

  function render() {
    root.replaceChildren(
      h('nav', { 'data-testid': 'sidebar-sticky' }, h('ul', {}, h('li', {}, h('a', { href: '#/' }, 'Dashboard')), h('li', {}, h('a', { href: '#/certificates' }, 'Certificates')))),
      h('main', {}, location.hash.indexOf('/certificates') >= 0 ? (S.loaded ? [filterWidget(), listWidget()] : h('div', { 'data-testid': 'table-skeleton' }, 'loading')) : h('div', {}, 'Dashboard')));
    renderPortal();
  }
  function load() {
    S.loading = true; S.checked = []; render();
    var body = { itemsPerPage: S.size, pageNumber: S.page, filters: S.filters, includeArchived: S.archived };
    if (S.sort) body.sort = S.sort;
    fetch('/api/v1/certificates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
      return res.json().then(function (json) {
        S.loading = false; S.loaded = true;
        if (res.status !== 200) { S.alerts.push({ id: ++S.alertId, text: 'Failed to get list (' + res.status + '): ' + (Array.isArray(json) ? json.join(', ') : '') }); S.rows = []; S.total = 0; S.totalPages = 0; }
        else { S.rows = json.certificates; S.total = json.totalItems; S.totalPages = json.totalPages; }
        render();
      });
    });
  }
  window.addEventListener('hashchange', function () { if (location.hash.indexOf('/certificates') >= 0 && !S.loaded) load(); else render(); });
  Promise.all([fetch('/api/v1/enums').then(function (r) { return r.json(); }), fetch('/api/v1/certificates/search').then(function (r) { return r.json(); })]).then(function (res) { ENUMS = res[0]; CAT = res[1]; render(); });
})();
`;

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fake inventory</title><style>${APP_CSS}</style></head>
<body><div id="root"></div><div id="portal"></div><div data-testid="alerts-container" id="toasts"></div><script>${APP_JS}</script></body></html>`;
