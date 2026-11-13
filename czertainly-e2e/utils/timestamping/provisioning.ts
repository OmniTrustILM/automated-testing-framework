/**
 * provisioning — the specs' view of the run's provisioning summary: families, sets, credentials and plan-driven test titles.
 * Playwright lists tests BEFORE the setup project runs, so titles come from the plan and
 * the summary is read inside tests and hooks only (tests/unit/timestampingSpecs.spec.ts).
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { currentRunId } from '../regression/run/runId';
import { isLocalTier } from '../regression/tier/kind';
import { hasLocalProof } from '../regression/tier/localProof';
import { PlannedFamily, plannedFamilies, summaryFile } from './config';
import { basicPassword } from './secrets';
import type { BasicCredential, NamedUuid, Provisioning, StoredTsaSet, TimestampingSummary, TsaSet } from './types';

export type { BasicCredential, NamedUuid, Provisioning, TsaSet };

export const RSA = 'RSA';
export const ECDSA = 'ECDSA';
export const SOFTWARE_V1 = 'software-v1';

let cached: Extract<TimestampingSummary, { status: 'ready' }> | undefined;

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

/** A mixed file skips per row, unless TIER_KIND=local and this run holds its local-backend proof (`describeLocalOnly` covers a whole file). */
export function skipUnlessLocalStack(env: NodeJS.ProcessEnv = process.env): void {
    test.skip(!isLocalTier(env), 'local stack only (TIER_KIND=local)');
    test.skip(!hasLocalProof(env), 'no authenticated local-backend proof for this run (the <block>-proof project)');
}

export function ledgerSpec(testInfo: { file: string }): string {
    return `timestamping/${path.basename(testInfo.file).replace(/\.spec\.ts$/, '')}`;
}

export interface TsaFamily {
    name: string;
    label: string;
    cryptoProvider: string;
    keyAlgorithm: string;
    connector: NamedUuid;
    nonQualified: TsaSet;
    qualified: TsaSet;
}

export const halfOf = (half: StoredTsaSet, keyAlgorithm: string, env: NodeJS.ProcessEnv = process.env): TsaSet => ({
    ...half, keyAlgorithm, basicCredential: { ...half.basicCredential, password: basicPassword(half.tspProfile.uuid, half.basicCredential.username, env) },
});

function familyOf(name: string, p: Provisioning): TsaFamily {
    const set = p.sets[name];
    return {
        name,
        label: set.label ?? set.keyAlgorithm,
        cryptoProvider: set.cryptoProvider,
        keyAlgorithm: set.keyAlgorithm,
        connector: set.connector,
        nonQualified: halfOf(set.nonQualified, set.keyAlgorithm),
        qualified: halfOf(set.qualified, set.keyAlgorithm),
    };
}

export function provisionedFamilies(): TsaFamily[] {
    const p = provisioningOrSkip();
    return plannedFamilies().filter((f) => p.sets[f.name]).map((f) => familyOf(f.name, p));
}

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

export function primaryPlanned(): PlannedFamily {
    return plannedFamilies().find((f) => f.keyAlgorithm === RSA)!;
}

export function primaryFamily(): TsaFamily {
    return familyOrSkip(primaryPlanned());
}

/** The primary family's titles stay unprefixed, the others carry their label. */
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

/** Core keeps a Basic credential per TSP profile; a name no set serves takes the first. */
export function basicCredentialFor(profileName: string): BasicCredential {
    const sets = provisionedFamilies().flatMap((family) => [family.nonQualified, family.qualified]);
    const serving = sets.find((set) => set.signingProfile.name === profileName || set.tspProfile.name === profileName);
    return (serving ?? sets[0]).basicCredential;
}

export function cryptographyConnectors(): NamedUuid[] {
    const byUuid = new Map(provisionedFamilies().map((family) => [family.connector.uuid, family.connector]));
    return [...byUuid.values()];
}

/** Server clock, epoch milliseconds: the lower bound of this run's signing records. */
export function runStartedAt(): number {
    return Date.parse(readySummaryOrSkip().provisionedAt);
}

export function artifactDir(label: string): string {
    const dir = test.info().outputPath(label.replace(/[^A-Za-z0-9._-]+/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
