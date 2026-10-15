/**
 * envFile — which dotenv file a process reads (reviews R3, Q11, Q16). Side-effect free: importing it loads nothing.
 *
 * Rule: when REG_ENV_FILE is set, that file is the ONLY env file; the `.env` of the working directory is never read in
 * that case. API_ENV_FILE is an alias honoured only by the REG / API configs (`prepareRun` passes `allowApiEnvFile`),
 * never by a smoke run's `utils/env.ts` (Q16): a shell that exported API_ENV_FILE for an API run must not change what
 * the smoke suite reads. Otherwise `<dir>/.env` is read (`dir` = the config's folder for the REG / API configs, the
 * working directory for `utils/env.ts`). dotenv never overrides a variable that is already set, so the first load wins:
 * the configs load first and then freeze TIER_KIND / AUTH_MODE / REG_RA_PROFILE_NAME (tier.ts `freezeTierEnv`), and pin
 * REG_ENV_FILE to the file they used, so a later load in a worker reads the same file.
 *
 * An explicitly named file that does not exist is an error for the configs (`requireExplicit`, Q11); the default
 * `<dir>/.env` may be missing (CI has none).
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

export interface EnvFileOptions {
    /** Honour API_ENV_FILE when REG_ENV_FILE is unset (the REG / API configs only). */
    allowApiEnvFile?: boolean;
    /** Throw when REG_ENV_FILE / API_ENV_FILE names a file that does not exist. */
    requireExplicit?: boolean;
}

/** The variable that names the env file explicitly, if any (REG_ENV_FILE, else API_ENV_FILE when allowed). */
function explicitVariable(env: NodeJS.ProcessEnv, opts: EnvFileOptions): 'REG_ENV_FILE' | 'API_ENV_FILE' | undefined {
    if (env.REG_ENV_FILE) return 'REG_ENV_FILE';
    if (opts.allowApiEnvFile && env.API_ENV_FILE) return 'API_ENV_FILE';
    return undefined;
}

/** The env file a load would read: REG_ENV_FILE, else API_ENV_FILE (configs only), else `<dir>/.env`. */
export function envFileFor(env: NodeJS.ProcessEnv = process.env, dir: string = process.cwd(), opts: EnvFileOptions = {}): string {
    const variable = explicitVariable(env, opts);
    return variable ? path.resolve(env[variable]!) : path.resolve(dir, '.env');
}

/** Load that one file into `env` (existing variables win). Returns the path; a missing default file loads nothing. */
export function loadDotenv(env: NodeJS.ProcessEnv = process.env, dir: string = process.cwd(), opts: EnvFileOptions = {}): string {
    const variable = explicitVariable(env, opts);
    const file = envFileFor(env, dir, opts);
    if (variable && opts.requireExplicit && !fs.existsSync(file)) {
        // The variable is named, its value is not: reports of a run may be shared.
        throw new Error(`${variable} names an env file that does not exist; refusing to run with a guessed environment.`);
    }
    dotenv.config({ path: file, processEnv: env as dotenv.DotenvPopulateInput, quiet: true });
    return file;
}
