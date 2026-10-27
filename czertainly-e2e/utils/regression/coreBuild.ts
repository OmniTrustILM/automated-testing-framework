/**
 * build — which core build a run talks to, for the one build-dependent oracle and the migration gate.
 *
 * `GET /api/v1/info` answers `{ app: { name, version }, build: { timestamp, branch, commitId }, db: { system, version } }`
 * (interfaces CoreInfoResponseDto). A successful read is cached in RunState.buildInfo; a failed one is NEVER cached:
 * the next call reads again, so one 503 at the start of a run cannot pin "baseline" for the whole run.
 *
 * `isMigratedBuild()` is true when REG_BUILD=sb41, or when `build.branch` names the Spring Boot 4.1 integration branch.
 * REG_BUILD=main (or baseline) states the baseline explicitly. An unreadable marker means baseline AND adds a test
 * annotation, never a silent default: the refused-method oracle (API-GEN-07 / API-PROT-37 / API-CORE-08: 400 on main,
 * `test.fail()` + `@bug:core#2502` on the migrated build) depends on it. `isMigratedBuild` therefore REQUIRES the
 * test's `testInfo` (the annotation has nowhere to go without it).
 */
import { APIRequestContext } from '@playwright/test';
import { Logger } from '../Logger';
import { BuildInfo, readRunState, updateRunState } from './ledger/runState';
import { settings } from './run/settings';

const logger = new Logger('Build');

/** The core branch of the Spring Boot 4.1 migration (integration/spring-boot-4.1). */
const MIGRATED_BRANCH = /spring-boot-4\.1/;

/** Parse the /v1/info body; a body without `build.branch` is an unreadable marker. */
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

/** RunState.buildInfo (the default store; tests inject their own). */
const runStateStore: BuildInfoStore = {
    read: () => readRunState().buildInfo,
    write: (info) => void updateRunState({ buildInfo: info }),
};

/**
 * GET /api/v1/info, cached in RunState.buildInfo once it was READ (a 2xx with a JSON body). A failure (non-2xx,
 * network error, unparsable body) returns an unreadable marker and caches nothing (a later call reads again).
 */
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

/** The decision itself, separate from the API read so it is unit-testable. */
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

/** True on the Spring Boot 4.1 build; a guess (unreadable marker) is written into the test's annotations. */
export async function isMigratedBuild(api: APIRequestContext, testInfo: Annotatable, store: BuildInfoStore = runStateStore): Promise<boolean> {
    const decision = decideMigrated(await getBuildInfo(api, store));
    if (decision.guessed) {
        logger.warn(decision.why);
        testInfo.annotations.push({ type: 'build-marker', description: `${decision.why} (set REG_BUILD=sb41 or main)` });
    }
    return decision.migrated;
}
