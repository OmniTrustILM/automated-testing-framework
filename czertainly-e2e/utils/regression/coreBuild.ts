/**
 * coreBuild — which core build a run talks to, for the build annotation of a row.
 * A successful `GET /api/v1/info` is cached for the run, a failed one never.
 */
import { APIRequestContext } from '@playwright/test';
import { Logger } from '../Logger';
import { BuildInfo, readRunState, updateRunState } from './ledger/runState';

const logger = new Logger('Build');

export function parseBuildInfo(body: unknown): BuildInfo {
    const b = (body ?? {}) as { app?: { version?: string }; build?: { branch?: string; commitId?: string } };
    return { version: b.app?.version, branch: b.build?.branch, commitId: b.build?.commitId };
}

export interface BuildInfoStore {
    read(): BuildInfo | undefined;
    write(info: BuildInfo): void;
}

const runStateStore: BuildInfoStore = {
    read: () => readRunState().buildInfo,
    write: (info) => void updateRunState({ buildInfo: info }),
};

/** GET /api/v1/info, cached once READ; a failure returns an empty build and caches nothing. */
export async function getBuildInfo(api: APIRequestContext, store: BuildInfoStore = runStateStore): Promise<BuildInfo> {
    const cached = store.read();
    if (cached) return cached;
    try {
        const resp = await api.get('/api/v1/info');
        if (!resp.ok()) {
            logger.warn(`GET /api/v1/info answered ${resp.status()}: build unknown (not cached)`);
            return {};
        }
        const info = parseBuildInfo(await resp.json());
        store.write(info);
        logger.info(`core ${info.version ?? '?'} branch ${info.branch ?? '?'} (${info.commitId ?? '?'})`);
        return info;
    } catch (e) {
        logger.warn(`GET /api/v1/info failed (${String(e).slice(0, 120)}): build unknown (not cached)`);
        return {};
    }
}
