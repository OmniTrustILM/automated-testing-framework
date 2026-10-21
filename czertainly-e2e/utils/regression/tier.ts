/**
 * tier — the path the smoke suite's utils/env.ts imports `assertAuthModeAllowed` from (smoke files never change). The
 * tier checks live in tier/kind.ts, tier/dns.ts, tier/docker.ts and tier/localProof.ts; new code imports those.
 */
export { assertAuthModeAllowed } from './tier/localProof';
