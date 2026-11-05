/**
 * configBase — the blocks the regression and API configs share: the reporters and the single-worker settings (the suites chain run objects,
 * so `prepareRun` refuses `--workers` above 1).
 */
import type { ReporterDescription } from '@playwright/test';

export function reporters(name: string): ReporterDescription[] {
    return [
        ['line'],
        ['html', { open: 'never', outputFolder: `playwright-report/${name}` }],
        ['junit', { outputFile: `test-results/${name}-junit.xml` }],
    ];
}

export const SINGLE_WORKER = { fullyParallel: false, workers: 1, retries: 0 } as const;
