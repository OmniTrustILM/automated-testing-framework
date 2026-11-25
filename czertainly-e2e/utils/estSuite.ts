/**
 * estSuite — the lifecycle every EST spec shares.
 *
 * WHAT: the EST environment, an admin API context, a cleanup stack, raBasic clients on a chosen RA
 * Profile, and common names unique to the run.
 * WHY: each spec opens the same context and must undo what it creates, newest first, so issued
 * certificates go before profiles and profiles before CAs.
 * HOW: a spec calls `open` from `test.beforeAll` and `close` from `test.afterAll`; cleanup steps
 * pushed to `undo` run in reverse order before the context is disposed.
 */

import { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { EstEnv, loadEstEnv } from './estEnv';
import { newEstAdminContext } from './estAdminApi';
import { cleanupCertificatesByCommonName } from './estEnroll';
import { createPolicyClient, PolicyClient, PolicyProfileOptions } from './estPolicyClients';

export class EstSuite {
  readonly undo: Array<() => Promise<unknown>> = [];
  private env?: EstEnv;
  private api?: APIRequestContext;

  constructor(private readonly newContext: (env: EstEnv) => Promise<APIRequestContext> = newEstAdminContext) {}

  async open(source: Record<string, string | undefined> = process.env): Promise<{ env: EstEnv; api: APIRequestContext }> {
    const env = loadEstEnv(source);
    const api = await this.newContext(env);
    this.env = env;
    this.api = api;
    return { env, api };
  }

  async close(): Promise<void> {
    if (!this.api) return;
    for (const step of this.undo.reverse()) await step();
    await this.api.dispose();
  }

  /** A raBasic client on the RA Profile; its objects are cleaned up with the suite. */
  raBasicClient(suffix: string, raProfileUuid: string, options: PolicyProfileOptions = {}): Promise<PolicyClient> {
    return createPolicyClient(this.opened().api, this.opened().env, (step) => this.undo.push(step), 'raBasic', suffix, {
      ...options,
      raProfileUuid,
    });
  }

  /** A common name unique to the run; every certificate carrying it is removed at the end. */
  uniqueCommonName(prefix: string): string {
    const { api } = this.opened();
    const cn = `est-e2e-${prefix}-${crypto.randomBytes(4).toString('hex')}`;
    this.undo.push(() => cleanupCertificatesByCommonName(api, cn));
    return cn;
  }

  private opened(): { env: EstEnv; api: APIRequestContext } {
    if (!this.env || !this.api) throw new Error('EstSuite is not open');
    return { env: this.env, api: this.api };
  }
}
