/**
 * provisioning — the specs' view of the run's provisioning summary (replaces the source's env.ts).
 *
 * WHAT: reads the summary the `timestamping-setup` project wrote (`summaryFile()`), turns it into the families, sets
 * and credentials the specs use, and names the plan-driven test titles.
 * WHY: Playwright lists tests BEFORE the setup project runs, so a title can only come from the plan (`plannedFamilies()`);
 * the summary is read lazily INSIDE tests and hooks, and a test skips with the reason when the tier could not provide
 * its family. Module-scope reads are forbidden (tests/unit/timestampingSpecs.spec.ts).
 * HOW: `readSummary()` reads and caches a ready summary; the `*OrSkip` readers skip the running test; `plannedSets()` is
 * what a module-scope `for` loop iterates; `artifactDir()` is the per-test output folder.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { currentRunId } from '../regression/run/runId';
import { PlannedFamily, plannedFamilies, summaryFile } from './config';
import type { BasicCredential, NamedUuid, Provisioning, TimestampingSummary, TsaSet } from './types';

export type { BasicCredential, NamedUuid, Provisioning, TsaSet };

export const RSA = 'RSA';
export const ECDSA = 'ECDSA';
export const SOFTWARE_V1 = 'software-v1';

let cached: Extract<TimestampingSummary, { status: 'ready' }> | undefined;

/** The run's summary. A missing file is `unavailable` (the setup project did not run), never an exception. */
export function readSummary(): TimestampingSummary {
    if (cached) return cached;
    const file = summaryFile();
    if (!fs.existsSync(file)) {
        return { status: 'unavailable', runId: currentRunId(), at: new Date().toISOString(), reason: 'the timestamping setup wrote no summary (the timestamping-setup project did not run)' };
    }
    const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as TimestampingSummary;
    if (summary.status === 'ready') cached = summary;
    return summary;
}

/** The ready summary; skips the running test or hook with the setup's reason when the tier is unavailable. */
export function readySummaryOrSkip(): Extract<TimestampingSummary, { status: 'ready' }> {
    const summary = readSummary();
    if (summary.status !== 'ready') {
        test.skip(true, summary.reason);
        throw new Error(summary.reason);
    }
    return summary;
}

export function provisioningOrSkip(): Provisioning {
    return readySummaryOrSkip().provisioning;
}

/** The ledger `spec` of the objects a timestamping spec creates: `timestamping/<file stem>` (the block teardown selects by the prefix). */
export function ledgerSpec(testInfo: { file: string }): string {
    return `timestamping/${path.basename(testInfo.file).replace(/\.spec\.ts$/, '')}`;
}

export interface TsaFamily {
    /** The set's name in the provisioning summary. */
    name: string;
    /** The family's name in test titles. */
    label: string;
    cryptoProvider: string;
    keyAlgorithm: string;
    connector: NamedUuid;
    nonQualified: TsaSet;
    qualified: TsaSet;
}

function familyOf(name: string, p: Provisioning): TsaFamily {
    const set = p.sets[name];
    return {
        name,
        label: set.label ?? set.keyAlgorithm,
        cryptoProvider: set.cryptoProvider,
        keyAlgorithm: set.keyAlgorithm,
        connector: set.connector,
        nonQualified: { ...set.nonQualified, keyAlgorithm: set.keyAlgorithm },
        qualified: { ...set.qualified, keyAlgorithm: set.keyAlgorithm },
    };
}

/** The provisioned sets as qualified / non-qualified pairs of one key algorithm, in plan order. Inside a test or hook only. */
export function provisionedFamilies(): TsaFamily[] {
    const p = provisioningOrSkip();
    return plannedFamilies().filter((f) => p.sets[f.name]).map((f) => familyOf(f.name, p));
}

/** One planned family as provisioned; skips with the reason when the setup could not provision it. */
export function familyOrSkip(planned: PlannedFamily): TsaFamily {
    const summary = readySummaryOrSkip();
    const missing = summary.missingFamilies[planned.name];
    if (missing !== undefined || !summary.provisioning.sets[planned.name]) {
        test.skip(true, `the ${planned.label} family was not provisioned: ${missing ?? 'not in the summary'}`);
    }
    return familyOf(planned.name, summary.provisioning);
}

export function setOrSkip(planned: PlannedFamily, qualified: boolean): TsaSet {
    const family = familyOrSkip(planned);
    return qualified ? family.qualified : family.nonQualified;
}

/** The first planned RSA family: the protocol and canary specs run once, on the plainest signer. */
export function primaryPlanned(): PlannedFamily {
    return plannedFamilies().find((f) => f.keyAlgorithm === RSA)!;
}

export function primaryFamily(): TsaFamily {
    return familyOrSkip(primaryPlanned());
}

/**
 * Every planned set, labelled for test titles (what the source's provisionedSets() produced for a full environment):
 * the primary family's titles stay unprefixed, the others carry their label.
 */
export function plannedSets(): Array<{ label: string; family: PlannedFamily; qualified: boolean }> {
    const primary = primaryPlanned();
    return plannedFamilies().flatMap((family) => {
        const prefix = family === primary || family.name === primary.name ? '' : `${family.label} `;
        return [
            { label: `${prefix}non-qualified`, family, qualified: false },
            { label: `${prefix}qualified`, family, qualified: true },
        ];
    });
}

/**
 * Core keeps a Basic credential per TSP profile, so a request authenticates with the credential of the set it
 * addresses. A name no set serves, as in the unknown-profile cases, takes the first.
 */
export function basicCredentialFor(profileName: string): BasicCredential {
    const sets = provisionedFamilies().flatMap((family) => [family.nonQualified, family.qualified]);
    const serving = sets.find((set) => set.signingProfile.name === profileName || set.tspProfile.name === profileName);
    return (serving ?? sets[0]).basicCredential;
}

/** The cryptography provider connectors behind the provisioned sets, each once. */
export function cryptographyConnectors(): NamedUuid[] {
    const byUuid = new Map(provisionedFamilies().map((family) => [family.connector.uuid, family.connector]));
    return [...byUuid.values()];
}

/** When provisioning began on the server's clock, epoch milliseconds: the lower bound of this run's signing records. */
export function runStartedAt(): number {
    return Date.parse(readySummaryOrSkip().provisionedAt);
}

/** Per-test scratch space (the test's output dir), so a failed assertion can be re-examined against the exact bytes. */
export function artifactDir(label: string): string {
    const dir = test.info().outputPath(label.replace(/[^A-Za-z0-9._-]+/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
