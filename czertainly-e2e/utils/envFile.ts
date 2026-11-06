/**
 * envFile — which dotenv file a process reads; side-effect free. REG_ENV_FILE, when set, is the only env file.
 * API_ENV_FILE is an alias for the REG / API configs only. Otherwise `<dir>/.env` is read; dotenv never overrides a set variable.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

export interface EnvFileOptions {
    allowApiEnvFile?: boolean;
    requireExplicit?: boolean;
}

function explicitVariable(env: NodeJS.ProcessEnv, opts: EnvFileOptions): 'REG_ENV_FILE' | 'API_ENV_FILE' | undefined {
    if (env.REG_ENV_FILE) return 'REG_ENV_FILE';
    if (opts.allowApiEnvFile && env.API_ENV_FILE) return 'API_ENV_FILE';
    return undefined;
}

export function envFileFor(env: NodeJS.ProcessEnv = process.env, dir: string = process.cwd(), opts: EnvFileOptions = {}): string {
    const variable = explicitVariable(env, opts);
    return variable ? path.resolve(env[variable]!) : path.resolve(dir, '.env');
}

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
