/**
 * ledger — the ledger: a line is recorded or read only with a canonical uuid (or <namespace>/<name> for a
 * Kubernetes object) and canonical parents; skipped lines are reported in one warning per read; runId() is the one id
 * of this run.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import {
    ledgerFile,
    ledgerUuidProblem,
    parentsProblem,
    parseLedger,
    readLedger,
    recordCreated,
    recordDeleted,
    recordDerived,
} from '../../utils/regression/ledger/ledger';
import { runId } from '../../utils/regression/ledger/runState';
import { currentRunId } from '../../utils/regression/run/runId';

const U1 = '00000000-0000-4000-8000-0000000000e1';

// ledger shapes: a canonical uuid (or <namespace>/<name> for k8s) and canonical parents, or nothing is recorded / read
test('ledger shapes: a canonical uuid or k8s namespace/name with canonical parents, else nothing', ({}, testInfo) => {
    const saved = process.env.REG_STATE_DIR;
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    try {
        const bad = [` ${U1}`, `${U1} `, U1.replace(/-/g, ''), 'AAAAAAAAAAAAAAAAAAAAAA', `urn:uuid:${U1}`, '0-0-4000-8000-1', `${U1}/../settings`, '', 'u-1'];
        for (const uuid of bad) {
            expect(ledgerUuidProblem('roles', uuid), JSON.stringify(uuid)).toBeDefined();
            expect(() => recordCreated('roles', { uuid, name: 'qa-reg-x' }, 'T'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
            expect(() => recordDerived('certificates', { uuid, name: 'x' }, 'T', '2026-10-14T00:00:00.000Z'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
            expect(() => recordDeleted('roles', { uuid, name: 'x' }, 'T'), JSON.stringify(uuid)).toThrow(/not a canonical uuid/);
        }
        expect(() => recordCreated('roles', { uuid: U1, name: 'qa-reg-x' }, 'T', undefined, { authority: '../x' })).toThrow(/parent/);
        expect(() => recordCreated('roles', { uuid: U1, name: 'qa-reg-x' }, 'T', undefined, { raProfiles: [U1, 'x'] })).toThrow(/parent/);
        expect(() => recordCreated('k8s:Issuer', { uuid: U1, name: 'qa-reg-x' }, 'T')).toThrow(/namespace/);
        expect(() => recordCreated('k8s:Issuer', { uuid: 'ns/Bad_Name', name: 'qa-reg-x' }, 'T')).toThrow(/namespace/);
        expect(fs.existsSync(ledgerFile()), 'nothing was written').toBe(false);
        // Valid shapes are written (either case of a canonical uuid; a k8s namespaced name).
        recordCreated('roles', { uuid: U1.toUpperCase(), name: 'qa-reg-x' }, 'T', undefined, { authority: U1 });
        recordCreated('k8s:Issuer', { uuid: 'ns-1/qa-reg-x-issuer', name: 'qa-reg-x-issuer' }, 'T');
        expect(readLedger().map((l) => l.uuid)).toEqual([U1.toUpperCase(), 'ns-1/qa-reg-x-issuer']);
        expect(parentsProblem({ raProfiles: [] }), 'an empty parent list').toBeDefined();
        expect(parentsProblem(['x'])).toBeDefined();
        expect(parentsProblem(undefined)).toBeUndefined();
    } finally {
        if (saved === undefined) delete process.env.REG_STATE_DIR;
        else process.env.REG_STATE_DIR = saved;
    }
    // parseLedger: a hand-edited line with a forged id or parent proves nothing.
    const line = (o: Record<string, unknown>) => JSON.stringify({ at: 'a', runId: 'r', type: 'roles', name: 'r-x', spec: 'T', event: 'created', ...o });
    const parsed = parseLedger([
        line({ uuid: U1 }), line({ uuid: ` ${U1}` }), line({ uuid: `${U1}/x` }), line({ uuid: U1, parents: { authority: 'a/../b' } }),
        line({ uuid: U1, type: 'k8s:Issuer' }), line({ uuid: 'ns/name', type: 'k8s:Issuer' }), line({ uuid: 5 }),
    ].join('\n'));
    expect(parsed.map((l) => `${l.type} ${l.uuid}`)).toEqual([`roles ${U1}`, 'k8s:Issuer ns/name']);
});

// skipped ledger lines are reported in ONE warning per read — a count and the run-id prefixes, never an id
test('skipped ledger lines are reported in one warning per read: a count and run-id prefixes, no id', () => {
    const warnings: string[] = [];
    const saved = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
        const line = (o: Record<string, unknown>) => JSON.stringify({ at: 'a', type: 'roles', name: 'n', spec: 'T', event: 'created', ...o });
        const bad = [
            line({ runId: 'qa-man-20261009-101500-aa11', uuid: 'manual-role-7' }), line({ runId: 'qa-man-20261009-101500-aa11', uuid: 'MAN-LEAK-ID' }),
            line({ runId: 'qa-neg-20261010-090000-bb22', uuid: ' 00000000-0000-4000-8000-000000000001' }),
            line({ runId: 'qa-neg-20261010-090000-bb22', uuid: U1, parents: { authority: 'NEG-LEAK-PARENT' } }),
            line({ run: 'qa-man-legacy', uuid: 'x/../settings' }), line({ uuid: 'no-run-id-line' }),
        ];
        const good = [line({ runId: 'qa-reg-20261014-120000-cd34', uuid: U1 })];
        const parsed = parseLedger([...bad, ...good, '{broken', 'null'].join('\n'));
        expect(parsed.map((l) => l.uuid)).toEqual([U1]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('skipped 6 line(s) whose id or parents have the wrong shape (run-id prefixes: (no run id), qa-man, qa-neg) and 2 unreadable line(s) of the ledger');
        for (const leak of ['manual-role-7', 'MAN-LEAK-ID', 'NEG-LEAK-PARENT', 'settings', '20261009', 'aa11', 'no-run-id-line']) expect(warnings[0]).not.toContain(leak);
        // A uuid-shaped or free-form run id is reported as `(other)`, never in part.
        warnings.length = 0;
        parseLedger([
            line({ runId: '11111111-0000-4000-8000-000000000001', uuid: 'odd-1' }),
            line({ runId: 'abcdefgh-ijklmnop', uuid: 'odd-2' }),
            line({ runId: 'qa-run3-20261013-x', uuid: 'odd-3' }),
        ].join('\n'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('(run-id prefixes: (other), qa-run3)');
        for (const leak of ['11111111', 'abcdefgh', 'ijklmnop', 'odd-']) expect(warnings[0]).not.toContain(leak);
        // A clean ledger: no warning at all.
        warnings.length = 0;
        parseLedger(good.join('\n'));
        expect(warnings).toEqual([]);
    } finally {
        console.warn = saved;
    }
});

// runId() is the one id of this run: the value RUN_ID froze at import, whatever the environment says later
test('runId() is the one id of this run: the value frozen at import', () => {
    expect(runId()).toBe(runId());
    const saved = process.env.REG_RUN_ID;
    process.env.REG_RUN_ID = 'qa-reg-20990101-000000-zz99';
    try {
        expect(runId()).toBe(runId());
        expect(currentRunId()).toBe('qa-reg-20990101-000000-zz99');
    } finally {
        if (saved === undefined) delete process.env.REG_RUN_ID;
        else process.env.REG_RUN_ID = saved;
    }
});
