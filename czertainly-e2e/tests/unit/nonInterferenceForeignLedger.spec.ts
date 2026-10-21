/**
 * Non-interference reads the SHARED ledger (created-objects.jsonl): lines of other QA tools (other run
 * ids) inside the run window explain a foreign object that vanished and the change of a total; anything else stays a
 * violation. The ledger text below copies the SHAPE of the real file's lines (keys, event-less `DELETED (own)` notes of
 * the qa-man tool, singular types such as `certificate` / `key`); every value is synthetic.
 *
 * Rows: a situation seen on a live tier (a foreign certificate and its key deleted by a qa-man cleanup inside the window ⇒ no
 * violation, one note); the same without the deletion lines ⇒ violations; a deletion line outside the window ⇒
 * violation; creates by another tool ⇒ the total is explained. Limits (fail-closed): unreadable / malformed lines, an
 * ambiguous note, this run's own lines, another tier, an unknown type, a creation of an object that existed before or
 * is not there after, a deletion of an object that is still there, an own uuid named by another tool.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { compareSnapshots, confirmForeignCreates, foreignEventOf, foreignResourceType, foreignWindowLines, TierSnapshot } from '../../utils/regression/teardown/nonInterference';
import { LedgerLine, parseLedger } from '../../utils/regression/ledger/ledger';

const RUN = 'qa-api-20261015-222835-h2yd';
const MAN = 'qa-man-20261009';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CERT = U(1);
const KEY = U(2);
const BEFORE_AT = '2026-10-15T22:28:40.000Z';
const AFTER_AT = '2026-10-15T23:05:00.000Z';
const INSIDE = '2026-10-15T22:41:28.123Z';

/** One line in the shape the real qa-man tool writes (no `event`, a `note`). */
const manLine = (type: string, uuid: string, at: string, note: string, runId = MAN): string =>
    JSON.stringify({ at, runId, type, name: 'synthetic-name', uuid, spec: 'fe-administrator#0000', note });

function snap(takenAt: string, resources: TierSnapshot['resources'], extra: Partial<TierSnapshot> = {}): TierSnapshot {
    return { takenAt, runId: RUN, resources, platformEvents: '{}', systemJobs: '[]', ...extra };
}

/** Seen on a live tier: one stored foreign certificate and one stored foreign key, both gone after the run. */
const before5 = () => snap(BEFORE_AT, {
    certificates: { total: 161203, foreign: { [CERT]: { name: 'synthetic', marker: 'issued' } }, window: 200, newest: 100 },
    keys: { total: 5000, foreign: { [KEY]: { name: 'certKey_synthetic', marker: 'active/true' } }, window: 200, newest: 100 },
});
const after5 = () => snap(AFTER_AT, {
    certificates: { total: 161202, foreign: {}, window: 200, newest: 100 },
    keys: { total: 4999, foreign: {}, window: 200, newest: 100 },
});
/** The manual-test objects were uploaded the day before (outside the window), then deleted by their own cleanup inside it. */
const created5 = [manLine('certificate', CERT, '2026-10-15T06:06:00.000Z', 'uploaded for fe-administrator#0000'), manLine('key', KEY, '2026-10-15T06:06:01.000Z', 'own key of the upload')];
const deleted5 = (at = INSIDE) => [manLine('certificate', CERT, at, 'DELETED (own) 2026-10-16'), manLine('key', KEY, at, 'DELETED (own) 2026-10-16')];
const compare = (b: TierSnapshot, a: TierSnapshot, text: string[]) => compareSnapshots(b, a, { ledger: parseLedger(text.join('\n')), runId: RUN, tolerance: 0 });

// seen on a live tier: a foreign certificate and key deleted by another tool's cleanup inside the run window — no violation,
// one note
test('seen on a live tier: a foreign certificate and key deleted by another tool give one note', () => {
    const r = compare(before5(), after5(), [...created5, ...deleted5()]);
    expect(r.violations).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toBe(`explained by other QA tools' ledger lines inside the run window: certificates ${CERT} deleted (qa-man); keys ${KEY} deleted (qa-man)`);
    expect(r.notes[0], 'no names, no run id').not.toMatch(/synthetic|20261009/);
});

test('the same without the deletion lines: both objects and both totals are violations', () => {
    expect(compare(before5(), after5(), created5).violations).toEqual([
        `certificates: pre-existing ${CERT} is gone`,
        'certificates: total 161203 -> 161202 (-1), the ledger explains +0',
        `keys: pre-existing ${KEY} is gone`,
        'keys: total 5000 -> 4999 (-1), the ledger explains +0',
    ]);
});

// a deletion line outside the run window explains nothing (before the before snapshot, after the after snapshot)
test('a deletion line outside the run window explains nothing, before or after the snapshots', () => {
    for (const at of ['2026-10-15T22:20:00.000Z', '2026-10-15T23:05:00.001Z']) {
        const r = compare(before5(), after5(), [...created5, ...deleted5(at)]);
        expect(r.violations, at).toEqual(expect.arrayContaining([`certificates: pre-existing ${CERT} is gone`, `keys: pre-existing ${KEY} is gone`]));
        expect(r.notes, at).toEqual([]);
    }
    // The window is closed: a line exactly at either end counts.
    expect(compare(before5(), after5(), [...created5, ...deleted5(BEFORE_AT)]).violations).toEqual([]);
    expect(compare(before5(), after5(), [...created5, ...deleted5(AFTER_AT)]).violations).toEqual([]);
});

const smallBefore = () => snap(BEFORE_AT, { raProfiles: { total: 3, foreign: { [U(10)]: { name: 'a', marker: 'enabled=true' }, [U(11)]: { name: 'b', marker: 'enabled=true' } } } });
const smallAfter = (extra: string[] = [U(20), U(21)], total = 5) => snap(AFTER_AT, {
    raProfiles: {
        total,
        foreign: { [U(10)]: { name: 'a', marker: 'enabled=true' }, [U(11)]: { name: 'b', marker: 'enabled=true' }, ...Object.fromEntries(extra.map((u) => [u, { name: 'n', marker: 'enabled=true' }])) },
    },
});

// creates by another tool inside the window explain the growth of a total (singular and plural type names)
test('creates by another tool inside the window explain the growth of a total', () => {
    const text = [manLine('raProfile', U(20), INSIDE, 'own RA profile'), JSON.stringify({ at: INSIDE, runId: 'qa-neg-20261015-x', type: 'raProfiles', name: 'n', uuid: U(21), spec: 'S' })];
    const r = compare(smallBefore(), smallAfter(), text);
    expect(r.violations).toEqual([]);
    expect(r.notes).toEqual(["explained by other QA tools' ledger lines inside the run window: raProfiles +2 created (qa-man, qa-neg)"]);
    // Without them the growth is a violation.
    expect(compare(smallBefore(), smallAfter(), []).violations).toEqual(['raProfiles: total 3 -> 5 (+2), the ledger explains +0']);
    // One create explains one object only.
    expect(compare(smallBefore(), smallAfter(), [text[0]]).violations).toEqual(['raProfiles: total 3 -> 5 (+2), the ledger explains +1']);
});

// limits: unreadable and malformed lines, an ambiguous note, this run's own id, another tier and an unknown type explain
// nothing
test('limits: unreadable or malformed lines, ambiguous note, own run id and other tier explain nothing', () => {
    const bad = [
        '{"at": "2026-10-15T22:41:28.123Z", "runId": "qa-man-1", "type": "certificate", "uuid": "' + CERT, // truncated JSON
        manLine('certificate', CERT.toUpperCase().replace(/-/g, ''), INSIDE, 'DELETED (own)'), // not a canonical uuid
        manLine('certificate', CERT, 'yesterday', 'DELETED (own)'), // no parseable time
        manLine('certificate', CERT, INSIDE, 'checked: DELETED (own)'), // the deletion is not at the start of the note
        manLine('certificate', CERT, INSIDE, 'uploaded; will be bulk-deleted'), // ambiguous
        manLine('certificate', CERT, INSIDE, 'DELETED (own)', RUN), // this run's own id
        manLine('certificate', CERT, INSIDE, 'DELETED (own)', ''), // no run id
        JSON.stringify({ at: INSIDE, runId: MAN, type: 'certificate', name: 'x', uuid: CERT, spec: 'S', note: 'DELETED (own)', tier: 'another-tier' }),
        manLine('cbom', CERT, INSIDE, 'DELETED (own)'), // a type without a snapshot resource
        manLine('certificate', KEY, INSIDE, 'DELETED (own)'), // the key's uuid under the certificate type
    ];
    const b = { ...before5(), tier: 'this-tier' };
    const a = { ...after5(), tier: 'this-tier' };
    for (const line of bad) {
        const r = compare(b, a, [line]);
        expect(r.violations, line).toContain(`certificates: pre-existing ${CERT} is gone`);
        expect(r.notes, line).toEqual([]);
    }
    // Control: the well-formed line of another tool explains it on the same tier and with no tier at all.
    expect(compare(b, a, [manLine('certificate', CERT, INSIDE, 'DELETED (own)')]).violations).not.toContain(`certificates: pre-existing ${CERT} is gone`);
    expect(compare(b, a, [JSON.stringify({ at: INSIDE, runId: MAN, type: 'certificate', name: 'x', uuid: CERT, spec: 'S', note: 'DELETED (own)', tier: 'this-tier' })]).violations)
        .not.toContain(`certificates: pre-existing ${CERT} is gone`);
    // An explicit event of another qa-reg run is read by its event, whatever its note says.
    const other = (event: string, note: string) => JSON.stringify({ at: INSIDE, runId: 'qa-reg-20261015-220000-zz99', type: 'certificates', name: 'x', uuid: CERT, spec: 'S', note, event, tier: 'this-tier' });
    expect(compare(b, a, [other('deleted', 'teardown')]).violations).not.toContain(`certificates: pre-existing ${CERT} is gone`);
    expect(compare(b, a, [other('created', 'DELETED (own)')]).violations).toContain(`certificates: pre-existing ${CERT} is gone`);
});

// limits: a create of an object stored before, or of a small collection's object that is not there after, explains no growth
test('limits: a create of an object stored before, or missing after, explains no growth', () => {
    // U(10) existed before the run: a "created" line for it inside the window explains nothing.
    expect(compare(smallBefore(), smallAfter([U(20)], 4), [manLine('raProfile', U(10), INSIDE, 'own')]).violations).toEqual(['raProfiles: total 3 -> 4 (+1), the ledger explains +0']);
    // U(22) is not stored after (a collection read whole stores every foreign object): explains nothing.
    expect(compare(smallBefore(), smallAfter([U(20)], 4), [manLine('raProfile', U(22), INSIDE, 'own')]).violations).toEqual(['raProfiles: total 3 -> 4 (+1), the ledger explains +0']);
    // Created and deleted inside the window: neither counts, the total is unchanged.
    expect(compare(smallBefore(), smallAfter([], 3), [manLine('raProfile', U(22), INSIDE, 'own'), manLine('raProfile', U(22), INSIDE, 'DELETED (own)')]).violations).toEqual([]);
    // A large collection without a creation time on its detail (certificates): a create counts only for an object in
    // the AFTER newest sample that the BEFORE newest sample did not hold; a timestamp, a stored copy or a detail read
    // alone explains nothing.
    const b = { ...before5() };
    b.resources = { ...b.resources, certificates: { ...b.resources.certificates, newestUuids: [CERT] } };
    const a = after5();
    a.resources.certificates = { total: 161204, foreign: { [CERT]: { name: 'synthetic', marker: 'issued' } }, window: 200, newest: 100, newestUuids: [CERT] };
    a.resources.keys = { total: 5000, foreign: { [KEY]: { name: 'certKey_synthetic', marker: 'active/true' } }, window: 200, newest: 100 };
    const line = [manLine('certificate', U(30), INSIDE, 'uploaded')];
    expect(compare(b, a, line).violations).toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    expect(compareSnapshots(b, a, { ledger: parseLedger(line.join('\n')), runId: RUN, tolerance: 0, confirmedCreated: [`certificates:${U(30)}`] }).violations, 'a detail read proves no newness')
        .toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    a.resources.certificates.foreign[U(30)] = { name: 'uploaded', marker: 'issued' };
    expect(compare(b, a, line).violations, 'stored after, but not in the newest sample').toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    a.resources.certificates.newestUuids = [U(30), CERT];
    expect(compare(b, a, line).violations, 'in the after newest sample, absent from the before one').toEqual([]);
    b.resources.certificates.newestUuids = [U(30), CERT];
    expect(compare(b, a, line).violations, 'already in the before newest sample').toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    b.resources.certificates.newestUuids = [];
    expect(compare(b, a, line).violations, 'an empty before sample of a non-empty collection proves nothing').toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    delete b.resources.certificates.newestUuids;
    expect(compare(b, a, line).violations, 'a before snapshot without the sample proves nothing').toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
});

// an object that existed in the middle of a large collection is not new: its created line plus a detail read hide no unrecorded
// +1
test('an object from the middle of a large collection is not new: created line plus detail read hide no +1', () => {
    // The counterexample: total 1000 -> 1001, a created line of another tool names a uuid that existed before the run
    // outside both windows, and a detail read answers 200 for it. The +1 stays unexplained.
    const tier = 'aaaaaaaaaaaa';
    const b: TierSnapshot = { ...snap(BEFORE_AT, { certificates: { total: 1000, foreign: { [U(1)]: { name: 'a', marker: 'issued' } }, window: 200, newest: 100, newestUuids: [U(1)] } }), tier };
    const a: TierSnapshot = { ...snap(AFTER_AT, { certificates: { total: 1001, foreign: { [U(1)]: { name: 'a', marker: 'issued' } }, window: 200, newest: 100, newestUuids: [U(1)] } }), tier };
    const ledger: LedgerLine[] = [{ at: INSIDE, runId: MAN, type: 'certificate', name: 'x', uuid: U(5), spec: 's', event: 'created', tier }];
    expect(compareSnapshots(b, a, { ledger, runId: RUN, tolerance: 0 }).violations).toHaveLength(1);
    expect(compareSnapshots(b, a, { ledger, runId: RUN, tolerance: 0, confirmedCreated: [`certificates:${U(5)}`] }).violations, 'no false green')
        .toEqual(['certificates: total 1000 -> 1001 (+1), the ledger explains +0']);
    // A genuine create of another tool inside the window: newest after, not newest before — explained, with its note.
    a.resources.certificates.newestUuids = [U(5), U(1)];
    const r = compareSnapshots(b, a, { ledger, runId: RUN, tolerance: 0 });
    expect(r.violations).toEqual([]);
    expect(r.notes).toEqual(["explained by other QA tools' ledger lines inside the run window: certificates +1 created (qa-man)"]);
});

// created and deleted by another tool inside the window: the pair explains nothing, so it cannot hide an unrecorded change
test('created and deleted by another tool inside the window: the pair explains nothing', () => {
    const b = before5();
    const a = after5();
    // One object of this run that was never recorded: certificates +1. Another tool created AND deleted U(33) meanwhile.
    a.resources.certificates = { total: 161204, foreign: { [CERT]: { name: 'synthetic', marker: 'issued' }, [U(33)]: { name: 'x', marker: 'issued' } }, window: 200, newest: 100 };
    a.resources.keys = { total: 5000, foreign: { [KEY]: { name: 'certKey_synthetic', marker: 'active/true' } }, window: 200, newest: 100 };
    const pair = [manLine('certificate', U(33), INSIDE, 'uploaded'), manLine('certificate', U(33), INSIDE, 'DELETED (own)')];
    expect(compare(b, a, pair).violations).toEqual(['certificates: total 161203 -> 161204 (+1), the ledger explains +0']);
    expect(compareSnapshots(b, a, { ledger: parseLedger(pair.join('\n')), runId: RUN, tolerance: 0, confirmedCreated: [`certificates:${U(33)}`] }).violations).toHaveLength(1);
});

test('own uuids: compared case-insensitively, and the objects the teardown deleted count as own', () => {
    const own: LedgerLine = { at: INSIDE, runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: U(20), spec: 'T', event: 'created' };
    const upper = '0000000A-0000-4000-8000-00000000000B';
    const lines = [{ ...own, uuid: upper }, ...parseLedger(manLine('raProfile', upper.toLowerCase(), INSIDE, 'own'))];
    // The run recorded it in upper case, the other tool in lower case: it stays the run's own (+1 once, no note).
    expect(compareSnapshots(smallBefore(), smallAfter([upper.toLowerCase()], 4), { ledger: lines, runId: RUN, tolerance: 0 })).toEqual({ violations: [], notes: [] });
    expect(own.uuid).toBe(U(20));
    // And the other way round: the run in lower case, the other tool in upper case.
    const lower = [{ ...own, uuid: upper.toLowerCase() }, ...parseLedger(manLine('raProfile', upper, INSIDE, 'own'))];
    expect(compareSnapshots(smallBefore(), smallAfter([upper.toLowerCase()], 4), { ledger: lower, runId: RUN, tolerance: 0 })).toEqual({ violations: [], notes: [] });
    expect(foreignWindowLines(parseLedger(manLine('raProfile', upper.toLowerCase(), INSIDE, 'own')), RUN, Date.parse(BEFORE_AT), Date.parse(AFTER_AT), undefined, new Set([upper]))).toEqual([]);
    // An object the run-end teardown deleted (no ledger line in this call): another tool's create line for it explains nothing.
    const after = smallAfter([U(22)], 4);
    const text = manLine('raProfile', U(22), INSIDE, 'own');
    expect(compareSnapshots(smallBefore(), after, { ledger: parseLedger(text), runId: RUN, tolerance: 0 }).violations).toEqual([]);
    expect(compareSnapshots(smallBefore(), after, { ledger: parseLedger(text), runId: RUN, tolerance: 0, ownDeleted: [{ type: 'raProfiles', uuid: U(22).toUpperCase() }] }).violations)
        .toEqual(['raProfiles: total 3 -> 4 (+1), the ledger explains -1']);
});

// a line without tier identity on a known tier: only the older event-less shape explains, and the note says so
test('a line without tier identity on a known tier explains only in the older event-less shape', () => {
    const b = { ...before5(), tier: 'this-tier' };
    const a = { ...after5(), tier: 'this-tier' };
    const explicit = (tier?: string) => JSON.stringify({ at: INSIDE, runId: 'qa-reg-20261015-220000-zz99', type: 'certificates', name: 'x', uuid: CERT, spec: 'S', event: 'deleted', ...(tier ? { tier } : {}) });
    expect(compare(b, a, [explicit()]).violations, 'an explicit event without a tier').toContain(`certificates: pre-existing ${CERT} is gone`);
    expect(compare(b, a, [explicit('this-tier')]).violations).not.toContain(`certificates: pre-existing ${CERT} is gone`);
    const legacy = compare(b, a, [manLine('certificate', CERT, INSIDE, 'DELETED (own)')]);
    expect(legacy.violations).not.toContain(`certificates: pre-existing ${CERT} is gone`);
    expect(legacy.notes.join('\n')).toContain(`certificates ${CERT} deleted (qa-man, a line without tier identity)`);
    // Without a known tier (no BASE_URL) nothing is marked.
    expect(compare(before5(), after5(), [...deleted5()]).notes[0]).not.toContain('without tier identity');
});

// confirmForeignCreates: keys are proven new by the creation time of their detail; other collections are not read
test('confirmForeignCreates: keys are proven new by their detail creation time; others are not read', async () => {
    const b = before5();
    const a = after5();
    const reads: string[] = [];
    const answers: Record<string, [number, unknown]> = {
        [`/api/v1/keys/${U(40)}`]: [200, { creationTime: '2026-10-15T22:30:00.000Z' }], // after before.takenAt: new
        [`/api/v1/keys/${U(41)}`]: [200, { creationTime: '2026-10-15T06:00:00.000Z' }], // older: existed before the run
        [`/api/v1/keys/${U(42)}`]: [500, {}],
        [`/api/v1/keys/${U(46)}`]: [200, { name: 'no creation time' }],
        [`/api/v1/keys/${U(47)}`]: [404, {}],
    };
    const api = {
        fetch: async (url: string) => {
            reads.push(url);
            const [status, body] = answers[url] ?? [404, {}];
            return { status: () => status, text: async () => JSON.stringify(body) };
        },
    } as unknown as APIRequestContext;
    const text = [U(40), U(41), U(42), U(46), U(47)].map((u) => manLine('key', u, INSIDE, 'own key'));
    text.push(manLine('certificate', U(43), INSIDE, 'uploaded'), manLine('raProfile', U(44), INSIDE, 'own'), manLine('key', U(45), INSIDE, 'own key'), manLine('key', U(45), INSIDE, 'DELETED (own)'), manLine('key', KEY, INSIDE, 'own key'));
    const got = await confirmForeignCreates(api, b, a, { ledger: parseLedger(text.join('\n')), runId: RUN });
    expect(got).toEqual([`keys:${U(40)}`]);
    expect(reads, 'certificates, small collections, created-then-deleted and stored-before objects are not read').toEqual([U(40), U(41), U(42), U(46), U(47)].map((u) => `/api/v1/keys/${u}`));
});

// limits: a deletion line of an object that is still there explains no shrinking; an own uuid is never explained by another
// tool
test('limits: a deletion line of an object still there explains no shrinking; own uuids never explained', () => {
    const b = smallBefore();
    const a = smallAfter([], 2);
    // U(11) is still there, U(10) too: a "DELETED" line for U(10) cannot explain the missing third object.
    expect(compare(b, a, [manLine('raProfile', U(10), INSIDE, 'DELETED (own)')]).violations).toEqual(['raProfiles: total 3 -> 2 (-1), the ledger explains +0']);
    // A uuid this run recorded as its own: another tool's line about it is ignored (the run's own lines decide).
    const own: LedgerLine = { at: INSIDE, runId: RUN, type: 'raProfiles', name: `${RUN}-ra`, uuid: U(20), spec: 'T', event: 'created' };
    const lines = [own, ...parseLedger(manLine('raProfile', U(20), INSIDE, 'own'))];
    expect(compareSnapshots(smallBefore(), smallAfter([U(20)], 4), { ledger: lines, runId: RUN, tolerance: 0 }).notes).toEqual([]);
    expect(foreignWindowLines(lines, RUN, Date.parse(BEFORE_AT), Date.parse(AFTER_AT), undefined, new Set([U(20)]))).toEqual([]);
});

// keys: another tool's deleted key takes one or two key items; its created certificate may bring one certKey item
test('keys: another tool deleted key takes one or two key items; its created certificate one certKey', () => {
    const b = before5();
    const a = after5();
    a.resources.certificates.total = 161203; // the certificate stays
    a.resources.certificates.foreign = { [CERT]: { name: 'synthetic', marker: 'issued' } };
    a.resources.keys.total = 4998; // a key with two items
    expect(compare(b, a, [manLine('key', KEY, INSIDE, 'DELETED (own)')]).violations).toEqual([]);
    a.resources.keys.total = 4997; // three items cannot be one key
    expect(compare(b, a, [manLine('key', KEY, INSIDE, 'DELETED (own)')]).violations).toEqual(['keys: total 5000 -> 4997 (-3), the ledger explains -2..+-1']);
    // A key another tool created: one or two key items.
    const k = before5();
    const k2 = after5();
    k2.resources.certificates = { ...k.resources.certificates };
    const keyLine = [manLine('cryptographicKeys', U(32), INSIDE, 'own key')];
    for (const [total, ok] of [[5001, true], [5002, true], [5003, false], [5000, false]] as const) {
        k2.resources.keys = { total, foreign: { ...k.resources.keys.foreign, [U(32)]: { name: 'own key', marker: 'active/true' } }, window: 200, newest: 100 };
        const r = compareSnapshots(k, k2, { ledger: parseLedger(keyLine.join('\n')), runId: RUN, tolerance: 0, confirmedCreated: [`keys:${U(32)}`] });
        expect(r.violations.length === 0, `keys ${total}`).toBe(ok);
    }
    k2.resources.keys.total = 5001;
    expect(compare(k, k2, keyLine).violations, 'a key without the creation-time proof explains nothing').toHaveLength(1);
    // A certificate another tool uploaded with its key: certificates +1, keys 0..+1.
    a.resources.keys = { total: 5001, foreign: { [KEY]: { name: 'certKey_synthetic', marker: 'active/true' } }, window: 200, newest: 100 };
    a.resources.certificates.total = 161204;
    b.resources.certificates.newestUuids = [CERT];
    a.resources.certificates.newestUuids = [U(31), CERT];
    expect(compare(b, a, [manLine('certificate', U(31), INSIDE, 'uploaded')]).violations).toEqual([]);
});

test('the readers: event-less notes, explicit events, type aliases', () => {
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'DELETED (own) → 204' })).toBe('deleted');
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'DELETED' })).toBe('deleted');
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'DELETEDX' })).toBeUndefined();
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'deleted (own)' })).toBeUndefined();
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'LEFT ON TIER (own): core refuses delete' })).toBeUndefined();
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'REMOVED (own) from the shared Location' })).toBeUndefined();
    expect(foreignEventOf({ event: 'created', eventImplied: true, note: 'own role' })).toBe('created');
    expect(foreignEventOf({ event: 'created', eventImplied: true })).toBe('created');
    expect(foreignEventOf({ event: 'deleted', note: 'anything' })).toBe('deleted');
    expect(foreignEventOf({ event: 'created', note: 'DELETED (own)' })).toBe('created');
    expect(parseLedger(manLine('certificate', CERT, INSIDE, 'DELETED (own)'))[0]).toMatchObject({ event: 'created', eventImplied: true });
    expect(parseLedger(JSON.stringify({ at: INSIDE, runId: MAN, type: 'roles', name: 'x', uuid: CERT, spec: 'S', event: 'created', eventImplied: true }))[0].eventImplied, 'a written mark is never taken over').toBeUndefined();
    expect(['certificate', 'certificates', 'key', 'cryptographicKeys', 'raProfile', 'role', 'cbom', 'oids', 'constructor', 7].map(foreignResourceType))
        .toEqual(['certificates', 'certificates', 'keys', 'keys', 'raProfiles', 'roles', undefined, undefined, undefined, undefined]);
    expect(foreignWindowLines(parseLedger(deleted5().join('\n')), RUN, NaN, Date.parse(AFTER_AT)), 'no window, nothing explained').toEqual([]);
    expect(foreignWindowLines(parseLedger(deleted5().join('\n')), RUN, Date.parse(AFTER_AT), Date.parse(BEFORE_AT)), 'an inverted window').toEqual([]);
});
