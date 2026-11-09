/**
 * provisioning — the specs' view of the run's provisioning summary.
 * Playwright lists tests BEFORE the setup project runs, so the summary is read inside tests and hooks only
 * (tests/unit/keyOnboardingSpecs.spec.ts).
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { currentRunId } from '../regression/run/runId';
import { summaryFile } from './config';
import type { KeyOnboardingSummary, NamedUuid, PlantedKeys, Provisioning } from './types';
import type { KeyDetail, OnboardingResult } from './adminApi';
import { recordCreated } from '../regression/ledger/ledger';

export type { NamedUuid, PlantedKeys, Provisioning };

let cached: Extract<KeyOnboardingSummary, { status: 'ready' }> | undefined;

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

export function provisioningOrSkip(): Provisioning {
    const summary = readSummary();
    if (summary.status !== 'ready') {
        test.skip(true, summary.reason);
        throw new Error(summary.reason);
    }
    return summary.provisioning;
}

export function ledgerSpec(testInfo: { file: string }): string {
    return `key-onboarding/${path.basename(testInfo.file).replace(/\.spec\.ts$/, '')}`;
}

export function onboardedKey(result: OnboardingResult): { uuid: string; name: string } {
    if (!result.keyUuid || !result.keyName) {
        throw new Error(`The onboarding of ${result.keyHandle} reports onboarded without ${result.keyUuid ? 'a key name' : 'a key uuid'}; it cannot be recorded`);
    }
    return { uuid: result.keyUuid, name: result.keyName };
}

export function recordOwnKeyItems(key: KeyDetail, spec: string, note: string): void {
    for (const item of key.items) recordCreated('keyItems', { uuid: item.uuid, name: key.name }, { spec, note, parents: { key: key.uuid } });
}
