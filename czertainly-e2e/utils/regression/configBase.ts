/**
 * configBase — the blocks the regression and API configs share: the reporters of one suite and the single-worker
 * settings. One worker, in file order, no retries: the suites chain run objects and the run-end teardown and the
 * non-interference check need a sequential run (`prepareRun` refuses `--workers` above 1).
 */
import type { ReporterDescription } from '@playwright/test';

/** Line output, an HTML report in playwright-report/<name> and a JUnit file test-results/<name>-junit.xml. */
export function reporters(name: string): ReporterDescription[] {
    return [
        ['line'],
        ['html', { open: 'never', outputFolder: `playwright-report/${name}` }],
        ['junit', { outputFile: `test-results/${name}-junit.xml` }],
    ];
}

/** One worker, files in order, no retries (a retry would create a second chain of run objects). */
export const SINGLE_WORKER = { fullyParallel: false, workers: 1, retries: 0 } as const;
