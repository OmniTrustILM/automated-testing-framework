/**
 * certificateState — waits until a certificate reaches a state, failing fast on a `failOn` state, a 404 after the grace, another 4xx, or a
 * third transient answer in a row; the error names the last state and history.
 */
import type { APIRequestContext } from '@playwright/test';
import { Logger } from '../../Logger';

const logger = new Logger('CertificateState');

export interface WaitForStateOptions {
    failOn?: string[];
    intervals?: number[];
    /**
     * A 404 within this many ms of the start is read-after-write lag (polled
     * again); after it a 404 ends the wait. 0 = fail on the first 404.
     */
    notFoundGraceMs?: number;
}

export const NOT_FOUND_GRACE_MS = 10_000;

async function certificateContext(request: APIRequestContext, certUuid: string, state: string | undefined, startedAt: number): Promise<string> {
    let history = 'history unavailable';
    try {
        const resp = await request.get(`/api/v1/certificates/${certUuid}/history`);
        if (resp.ok()) {
            const entries = (await resp.json()) as Array<{ event?: string; status?: string; message?: string; created?: string }>;
            history = entries
                .slice(0, 3)
                .map((e) => `${e.created ?? '?'} ${e.event ?? '?'} ${e.status ?? '?'}: ${(e.message ?? '').slice(0, 160)}`)
                .join(' | ') || 'no history entries';
        }
    } catch {
    }
    return `state "${state ?? 'unknown'}" after ${Math.round((Date.now() - startedAt) / 1000)} s; latest history: ${history}`;
}

export const RETRYABLE_4XX: readonly number[] = [408, 425, 429];

export const isTransientStatus = (status: number): boolean => status >= 500 || RETRYABLE_4XX.includes(status);

/**
 * Polls GET /api/v1/certificates/{uuid} until `state` equals `expectedState`, failing fast instead of waiting out the timeout; a transient
 * answer is tolerated twice and never retried into a pass.
 */
export async function waitForCertificateState(
    request: APIRequestContext,
    certUuid: string,
    expectedState: string,
    timeout: number = 60_000,
    opts: WaitForStateOptions = {},
): Promise<void> {
    logger.info(`Waiting for certificate ${certUuid} to reach state "${expectedState}" (timeout ${timeout}ms)`);
    const failOn = (opts.failOn ?? ['failed', 'rejected']).filter((s) => s !== expectedState);
    const intervals = opts.intervals?.length ? opts.intervals : [1000, 2000, 3000];
    const graceMs = opts.notFoundGraceMs ?? NOT_FOUND_GRACE_MS;
    const startedAt = Date.now();
    let serverErrors = 0;
    let lastState: string | undefined;

    for (let attempt = 0; ; attempt++) {
        const resp = await request.get(`/api/v1/certificates/${certUuid}`);
        const status = resp.status();
        if (isTransientStatus(status)) {
            serverErrors++;
            logger.warn(`Cert ${certUuid} state poll got status ${status} (${serverErrors} transient in a row)`);
            if (serverErrors >= 3) {
                throw new Error(`Certificate ${certUuid}: ${serverErrors} consecutive ${status} answers while waiting for "${expectedState}"; ` +
                    `${await certificateContext(request, certUuid, lastState, startedAt)}`);
            }
        } else if (status === 404 && Date.now() - startedAt < graceMs) {
            serverErrors = 0;
            logger.warn(`Cert ${certUuid} not found yet (404 within the ${graceMs} ms read-after-write grace); polling on`);
        } else if (!resp.ok()) {
            throw new Error(`Certificate ${certUuid}: GET answered ${status} while waiting for "${expectedState}" ` +
                `(${(await resp.text()).slice(0, 200)}); elapsed ${Math.round((Date.now() - startedAt) / 1000)} s`);
        } else {
            serverErrors = 0;
            lastState = ((await resp.json()) as { state?: string }).state;
            if (lastState === expectedState) break;
            if (lastState && failOn.includes(lastState)) {
                throw new Error(`Certificate ${certUuid} reached "${lastState}" instead of "${expectedState}": ` +
                    `${await certificateContext(request, certUuid, lastState, startedAt)}`);
            }
        }
        const remaining = timeout - (Date.now() - startedAt);
        if (remaining <= 0) {
            throw new Error(`Certificate ${certUuid} did not reach state "${expectedState}" within ${timeout}ms: ` +
                `${await certificateContext(request, certUuid, lastState, startedAt)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervals[Math.min(attempt, intervals.length - 1)], remaining)));
    }

    logger.info(`Certificate ${certUuid} reached state "${expectedState}"`);
}
