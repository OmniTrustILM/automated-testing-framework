/**
 * coreBuild — which core build a run talks to, for the one build-dependent oracle and the migration gate.
 * A successful `GET /api/v1/info` is cached for the run, a failed one never; an unreadable marker means baseline and adds a test
 * annotation, so `isMigratedBuild` requires the test's `testInfo`.
 */
import { APIRequestContext } from '@playwright/test';
import { Logger } from '../Logger';
import { BuildInfo, readRunState, updateRunState } from './ledger/runState';
import { settings } from './run/settings';

const logger = new Logger('Build');

const MIGRATED_BRANCH = /spring-boot-4\.1/;

export function parseBuildInfo(body: unknown): BuildInfo {
    const b = (body ?? {}) as { app?: { version?: string }; build?: { branch?: string; commitId?: string } };
    return {
        version: b.app?.version,
        branch: b.build?.branch,
        commitId: b.build?.commitId,
        markerReadable: typeof b.build?.branch === 'string' && b.build.branch.length > 0,
    };
}

export interface BuildInfoStore {
    read(): BuildInfo | undefined;
    write(info: BuildInfo): void;
}

const runStateStore: BuildInfoStore = {
    read: () => readRunState().buildInfo,
    write: (info) => void updateRunState({ buildInfo: info }),
};

/** GET /api/v1/info, cached once READ; a failure returns an unreadable marker and caches nothing. */
export async function getBuildInfo(api: APIRequestContext, store: BuildInfoStore = runStateStore): Promise<BuildInfo> {
    const cached = store.read();
    if (cached) return cached;
    try {
        const resp = await api.get('/api/v1/info');
        if (!resp.ok()) {
            logger.warn(`GET /api/v1/info answered ${resp.status()}: build marker unreadable (not cached)`);
            return { markerReadable: false };
        }
        const info = parseBuildInfo(await resp.json());
        store.write(info);
        logger.info(`core ${info.version ?? '?'} branch ${info.branch ?? '?'} (${info.commitId ?? '?'})`);
        return info;
    } catch (e) {
        logger.warn(`GET /api/v1/info failed (${String(e).slice(0, 120)}): build marker unreadable (not cached)`);
        return { markerReadable: false };
    }
}

interface Annotatable {
    annotations: Array<{ type: string; description?: string }>;
}

export function decideMigrated(info: BuildInfo, env: NodeJS.ProcessEnv = process.env): { migrated: boolean; why: string; guessed: boolean } {
    const flag = settings(env).build?.toLowerCase();
    if (flag === 'sb41') return { migrated: true, why: 'REG_BUILD=sb41', guessed: false };
    if (flag === 'main' || flag === 'baseline') return { migrated: false, why: `REG_BUILD=${flag}`, guessed: false };
    if (info.markerReadable) {
        const migrated = MIGRATED_BRANCH.test(info.branch!);
        return { migrated, why: `build.branch ${info.branch}`, guessed: false };
    }
    return { migrated: false, why: 'build marker unreadable: treated as baseline', guessed: true };
}

export async function isMigratedBuild(api: APIRequestContext, testInfo: Annotatable, store: BuildInfoStore = runStateStore): Promise<boolean> {
    const decision = decideMigrated(await getBuildInfo(api, store));
    if (decision.guessed) {
        logger.warn(decision.why);
        testInfo.annotations.push({ type: 'build-marker', description: `${decision.why} (set REG_BUILD=sb41 or main)` });
    }
    return decision.migrated;
}
