/**
 * provision — the timestamping setup: preflight, per-run provisioning in timestamping-setup.sh order, and the summary.
 *
 * WHAT: `provisionTimestamping(api)` returns the run's `TimestampingSummary`: `unavailable` with the reason when the
 * tier lacks a prerequisite (preflight.ts) or a shared step fails at the tier, else `ready` with every set that could be
 * provisioned and `missingFamilies` for the others. `writeSummary` stores it at `summaryFile()` (mode 0600: it holds
 * no password: those are derived from the run secret). `SETUP_LEDGER_SPEC` is the `spec` of every ledger line written here.
 * WHY: replaces development-environment `scripts/timestamping-setup.sh` for the block: instead of reusing and changing
 * fixed-name objects, each run creates its own (run-prefixed names, a ledger line per object right after its create), and
 * the block teardown, then the run-end teardown, delete them.
 * HOW: shared objects first (vault profile, token, token profile, time-quality configuration, mapped user, role); then per
 * planned family the non-qualified and the qualified set (key → RA profile → certificate → chain → TSP profile → signing
 * profile → link → Basic credential → grants). One token and token profile serve every family, as the developers'
 * suite ran the ML-DSA script on the RSA run's token. A family other than RSA that fails mid-way at the tier is reported
 * in `missingFamilies` with the step and the status; what it created stays in the ledger. The RSA family is required by
 * the plan (the protocol and canary specs run on it): its failure mid-way fails the setup test. Only a TierError becomes
 * a reason: a SetupError (a refused body, a refused identity), a programming error or a guard refusal propagates and
 * fails the setup test. Shared tier or local stack, the same strict guard judges the setup (tests/timestamping/SHARED-TIER.md): the one
 * request it cannot send, marking a not-yet-trusted issuing root CA trusted, needs `opts.localApi` (a proven local stack), else the tier
 * is `unavailable` with that reason.
 */
import * as fs from 'fs';
import { writeJsonAtomic } from '../../devBlocks/provision/summaryFile';
import * as path from 'path';
import { Logger } from '../../Logger';
import type { GuardedApi } from '../../regression/guard/types';
import type { OwnRef } from '../../regression/ledger/ledger';
import { runId } from '../../regression/ledger/runState';
import { PlannedFamily, summaryFile, TimestampingConfig, timestampingConfig } from '../config';
import type { Provisioning, SummarySet, TimestampingSummary } from '../types';
import { clearBaseline, takeBaseline } from '../inventory';
import { newStamp, objectName, SETUP_LEDGER_SPEC, SetupContext, step } from './context';
import { Prerequisites, preflight } from './preflight';
import { createKeyPair, createRaProfile, createToken, createTokenProfile, issueCertificate, trustChain, waitIssued } from './pki';
import { createBasicCredential, createMappedUser, createRole, createSigningProfile, createTimeQuality, createTspProfile, createVaultProfile, grantPermissions, linkProfiles, SetGrant, TimeQuality } from './profiles';
import { Admin, DEFAULT_POLL, PollSettings, SetupError, TierError } from './transport';

export { SETUP_LEDGER_SPEC };
export { offlineBlocker } from './preflight';

const logger = new Logger('TimestampingSetup');

export interface ProvisionOptions {
    /**
     * A `localStack` guarded context, given only on a proven local stack (the setup test builds it): the two requests the strict `api`
     * cannot send (SetupContext.localAdmin). Without it the setup never changes or calls a pre-existing object.
     */
    localApi?: GuardedApi;
    cfg?: TimestampingConfig;
    env?: NodeJS.ProcessEnv;
    /** The waits (unit tests: 0 ms pauses). */
    poll?: Partial<PollSettings>;
    /** The name stamp of this setup attempt (default: four random base36 characters). */
    stamp?: string;
}

/** What every set of the run shares. */
interface Shared {
    pre: Prerequisites;
    vaultProfile: OwnRef;
    token: OwnRef;
    tokenProfile: OwnRef;
    timeQuality: TimeQuality;
    user: OwnRef;
    role: OwnRef;
    /** The grants of every completed set (savePermissions replaces the role's whole document). */
    grants: SetGrant[];
}

const HALVES = [
    { suffix: 'non-qualified', qualified: false },
    { suffix: 'qualified', qualified: true },
] as const;

/** What the summary says while a setup attempt runs: a killed or retried attempt never leaves an older `ready` file behind. */
export const SETUP_NOT_FINISHED = 'the timestamping setup has not finished (it is running, or an attempt was stopped before it wrote its summary)';

export function unavailableSummary(reason: string): TimestampingSummary {
    return { status: 'unavailable', runId: runId(), at: new Date().toISOString(), reason };
}

/**
 * Preflight, then provisioning; see the file header. Every admin request goes through the guarded `api` (the strict guard, shared tier
 * or local); `opts.localApi` serves the two requests only a proven local stack may make.
 */
export async function provisionTimestamping(api: GuardedApi, opts: ProvisionOptions = {}): Promise<TimestampingSummary> {
    const env = opts.env ?? process.env;
    clearBaseline(env);
    const cfg = opts.cfg ?? timestampingConfig(env);
    const admin = new Admin(api);
    const found = await preflight(admin, cfg, env, api);
    if (found.status === 'unavailable') {
        logger.warn(`timestamping unavailable: ${found.reason}`);
        return unavailableSummary(found.reason);
    }
    const ctx: SetupContext = {
        admin, ...(opts.localApi ? { localAdmin: new Admin(opts.localApi) } : {}), cfg, env, poll: { ...DEFAULT_POLL, ...opts.poll }, stamp: opts.stamp ?? newStamp(), log: logger,
    };
    const missingFamilies: Record<string, string> = { ...found.missingFamilies };
    for (const [name, why] of Object.entries(missingFamilies)) logger.warn(`family ${name} skipped: ${why}`);

    // Before anything is created: what the tier holds of the three resources the block adds to (utils/timestamping/inventory.ts). Read-only;
    // a tier that cannot list them is a skipped check, never a failure.
    const baseline = await takeBaseline(admin, env);
    if (baseline.status === 'skipped') logger.warn(`inventory check skipped: ${baseline.reason}`);

    admin.markProvisioningStart();
    let shared: Shared;
    try {
        shared = await provisionShared(ctx, found.prerequisites);
    } catch (e) {
        if (!(e instanceof TierError)) throw e;
        logger.warn(`timestamping provisioning stopped: ${e.message}`);
        return unavailableSummary(`provisioning stopped at ${e.message} (the objects created so far are in the ledger; the teardown removes them)`);
    }

    const sets: Record<string, SummarySet> = {};
    for (const family of cfg.families) {
        if (missingFamilies[family.name] !== undefined) continue;
        try {
            sets[family.name] = await provisionFamily(ctx, shared, family);
        } catch (e) {
            if (!(e instanceof TierError)) throw e;
            const why = `the ${family.label} family stopped at ${e.message}`;
            // The plan requires RSA: a ready summary without it would let every protocol spec skip green.
            if (family.name === 'rsa') throw new SetupError(`${why} (the RSA family is required; the objects created so far are in the ledger)`);
            missingFamilies[family.name] = why;
            logger.warn(why);
        }
    }

    const serverAt = admin.provisionedAt();
    if (!serverAt) logger.warn('no Date header on the provisioning answers: provisionedAt falls back to the runner clock');
    return {
        status: 'ready',
        runId: runId(),
        provisionedAt: (serverAt ?? new Date()).toISOString(),
        provisioning: provisioningOf(ctx, shared, sets),
        missingFamilies,
    };
}

/** Steps 5–10 of the script (1–4 are the preflight's discovery; 11, the --issuer-ca upload, is not ported). */
async function provisionShared(ctx: SetupContext, pre: Prerequisites): Promise<Shared> {
    const vaultProfile = await step('step 5 (vault profile)', () => createVaultProfile(ctx, pre.vaultInstance, objectName(ctx, 'tsa-vault-profile')));
    const token = await step('step 6 (token)', () => createToken(ctx, pre.connectors.crypto, objectName(ctx, 'tsa-token')));
    const tokenProfile = await step('step 7 (token profile)', () => createTokenProfile(ctx, token, objectName(ctx, 'tsa-token-profile')));
    const timeQuality = await step('step 8 (time-quality configuration)', () => createTimeQuality(ctx, objectName(ctx, 'time-quality')));
    const user = await step('step 9 (mapped user)', () => createMappedUser(ctx, objectName(ctx, 'tsp-user')));
    const role = await step('step 10 (timestamping role)', () => createRole(ctx, objectName(ctx, 'tsp-role'), user));
    return { pre, vaultProfile, token, tokenProfile, timeQuality, user, role, grants: [] };
}

/** Steps 12–21 for both halves of one family. */
async function provisionFamily(ctx: SetupContext, s: Shared, family: PlannedFamily): Promise<SummarySet> {
    const plan = s.pre.raPlans[family.name];
    const halves: Partial<Record<'nonQualified' | 'qualified', SummarySet['qualified']>> = {};
    for (const half of HALVES) {
        const base = `${family.name}-${half.suffix}`;
        const at = (n: number, what: string) => `step ${n} (${what}, ${half.suffix})`;
        const keyPair = await step(at(12, 'key pair'), () => createKeyPair(ctx, s.token, s.tokenProfile, family.keyAlgorithm, objectName(ctx, `tsa-${base}`)));
        const raProfile = await step(at(13, 'RA profile'), () => createRaProfile(ctx, s.pre.authority, plan, half.qualified, objectName(ctx, `tsa-${base}`)));
        // The CN names the EJBCA end entity (usernameGenMethod CN): run-prefixed and unique per setup attempt.
        const commonName = objectName(ctx, `tsa-${base}`);
        const certificate = await step(at(14, 'TSA certificate'), () => issueCertificate(ctx, { commonName, authority: s.pre.authority, raProfile, token: s.token, tokenProfile: s.tokenProfile, keyPair }));
        await step(at(15, 'issuance'), () => waitIssued(ctx, certificate));
        await step(at(16, 'trust chain'), () => trustChain(ctx, certificate));
        const tspProfile = await step(at(17, 'TSP profile'), () => createTspProfile(ctx, objectName(ctx, `tsp-${base}`), s.vaultProfile));
        const policyOid = half.qualified ? ctx.cfg.policyIdQualified : ctx.cfg.policyIdNonQualified;
        const signingProfile = await step(at(18, 'signing profile'), () => createSigningProfile(ctx, {
            name: objectName(ctx, `tsa-${base}`), certificate, token: s.token, tspProfile, policyOid,
            timestampFormatting: s.pre.connectors.timestampFormatting, timeQuality: half.qualified ? s.timeQuality : undefined,
        }));
        await step(at(19, 'link'), () => linkProfiles(ctx, tspProfile, signingProfile, s.vaultProfile));
        const basicCredential = await step(at(20, 'Basic credential'), () => createBasicCredential(ctx, tspProfile, s.user));
        // Applied as each set completes, so a completed set serves timestamps even when the next one fails.
        s.grants.push({ tspProfile, signingProfile, token: s.token, tokenProfile: s.tokenProfile });
        await step(at(21, 'grants'), () => grantPermissions(ctx, s.role, s.grants));
        halves[half.qualified ? 'qualified' : 'nonQualified'] = {
            qualified: half.qualified,
            policyOid,
            key: { name: keyPair.key.name, uuid: keyPair.key.uuid },
            raProfile: { name: raProfile.name, uuid: raProfile.uuid },
            certificate: { commonName, uuid: certificate.uuid },
            tspProfile: { name: tspProfile.name, uuid: tspProfile.uuid },
            basicCredential,
            signingProfile: { name: signingProfile.name, uuid: signingProfile.uuid },
        };
    }
    return {
        cryptoProvider: ctx.cfg.cryptoProvider,
        connector: { name: s.pre.connectors.crypto.name, uuid: s.pre.connectors.crypto.uuid },
        token: { name: s.token.name, uuid: s.token.uuid },
        tokenProfile: { name: s.tokenProfile.name, uuid: s.tokenProfile.uuid },
        keyAlgorithm: family.keyAlgorithm,
        label: family.label,
        nonQualified: halves.nonQualified!,
        qualified: halves.qualified!,
    };
}

/** The summary in the shape of the script's `write_json_summary` (types.ts `Provisioning`). */
function provisioningOf(ctx: SetupContext, s: Shared, sets: Record<string, SummarySet>): Provisioning {
    const c = s.pre.connectors;
    const nu = (r: { name: string; uuid: string }) => ({ name: r.name, uuid: r.uuid });
    let ilmHost = '';
    try {
        ilmHost = ctx.env.BASE_URL ? new URL(ctx.env.BASE_URL).origin : '';
    } catch {
        ilmHost = '';
    }
    return {
        ilmHost,
        connectorHost: s.pre.connectorHost,
        connectors: { credentialProvider: nu(c.credentialProvider), ejbca: nu(c.ejbca), timestampFormatting: nu(c.timestampFormatting), vault: nu(c.vault) },
        credential: nu(s.pre.credential),
        authority: nu(s.pre.authority),
        vaultInstance: nu(s.pre.vaultInstance),
        vaultProfile: nu(s.vaultProfile),
        mappedUser: { username: s.user.name, uuid: s.user.uuid },
        role: nu(s.role),
        timeQuality: { name: s.timeQuality.name, uuid: s.timeQuality.uuid, accuracy: s.timeQuality.accuracy, ntpServers: s.timeQuality.ntpServers, maxClockDrift: s.timeQuality.maxClockDrift },
        sets,
    };
}

/**
 * Writes the summary at `summaryFile()` with mode 0600 (directory created): a temp file in the same directory, chmod,
 * rename, so a reader never sees half a file. It holds no secret (the Basic passwords are derived, utils/timestamping/secrets.ts).
 */
export function writeSummary(summary: TimestampingSummary, env: NodeJS.ProcessEnv = process.env): string {
    const file = summaryFile(env);
    return writeJsonAtomic(file, summary);
}
