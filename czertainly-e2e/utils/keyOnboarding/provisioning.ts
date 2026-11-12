/**
 * provisioning — the specs' view of the run's provisioning summary (replaces the source's env.ts reader).
 *
 * WHAT: reads the summary the `key-onboarding-setup` project wrote (`summaryFile()`) and hands the ready provisioning to
 * the specs; names the ledger `spec` of the objects a spec creates.
 * WHY: Playwright lists tests BEFORE the setup project runs, so the summary is read lazily INSIDE tests and hooks, and a
 * test skips with the reason when the tier is unavailable. Module-scope reads are forbidden
 * (tests/unit/keyOnboardingSpecs.spec.ts).
 * HOW: `readSummary()` reads and caches a ready summary; `provisioningOrSkip()` skips the running test with the setup's reason.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { currentRunId } from '../regression/run/runId';
import { summaryFile } from './config';
import type { KeyOnboardingSummary, NamedUuid, PlantedKeys, Provisioning } from './types';
import type { OnboardingResult } from './adminApi';

export type { NamedUuid, PlantedKeys, Provisioning };

let cached: Extract<KeyOnboardingSummary, { status: 'ready' }> | undefined;

/** The run's summary. A missing file is `unavailable` (the setup project did not run), never an exception. */
export function readSummary(): KeyOnboardingSummary {
    if (cached) return cached;
    const file = summaryFile();
    if (!fs.existsSync(file)) {
        return { status: 'unavailable', runId: currentRunId(), at: new Date().toISOString(), reason: 'the key onboarding setup wrote no summary (the key-onboarding-setup project did not run)' };
    }
    const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as KeyOnboardingSummary;
    if (summary.status === 'ready') cached = summary;
    return summary;
}

/** The ready provisioning; skips the running test or hook with the setup's reason when the block is unavailable. */
export function provisioningOrSkip(): Provisioning {
    const summary = readSummary();
    if (summary.status !== 'ready') {
        test.skip(true, summary.reason);
        throw new Error(summary.reason);
    }
    return summary.provisioning;
}

/** The ledger `spec` of the objects a key onboarding spec creates: `key-onboarding/<file stem>` (the block teardown selects by the prefix). */
export function ledgerSpec(testInfo: { file: string }): string {
    return `key-onboarding/${path.basename(testInfo.file).replace(/\.spec\.ts$/, '')}`;
}

/** The key an onboarding result names, for the ledger: fails when an onboarded result lacks its uuid or its live name. */
export function onboardedKey(result: OnboardingResult): { uuid: string; name: string } {
    if (!result.keyUuid || !result.keyName) {
        throw new Error(`The onboarding of ${result.keyHandle} reports onboarded without ${result.keyUuid ? 'a key name' : 'a key uuid'}; it cannot be recorded`);
    }
    return { uuid: result.keyUuid, name: result.keyName };
}
