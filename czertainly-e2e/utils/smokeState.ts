/**
 * smokeState — file-based state sharing between Playwright globalSetup and globalTeardown.
 *
 * globalSetup writes the SmokeState to .smoke-state.json (gitignored). globalTeardown
 * reads it to know what to delete in reverse dependency order.
 *
 * State is all-or-nothing: globalSetup either writes the full SmokeState (all PKI
 * fields + connector UUIDs together) or doesn't write anything. Tests can rely on
 * any field being present when `readSmokeState()` returns non-null.
 *
 * Why a file: globalSetup and globalTeardown are separate function invocations in
 * Playwright's lifecycle — in-memory state between them is not reliable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';

const logger = new Logger('SmokeState');

// .smoke-state.json lives at czertainly-e2e/.smoke-state.json (sibling of utils/)
const STATE_FILE = path.resolve(__dirname, '..', '.smoke-state.json');

export interface SmokeState {
  /** UUIDs of connectors registered by THIS run — globalTeardown deletes them. */
  registeredConnectorUuids: string[];

  // SMK-004 PKI chain — always written together with the rest of the state.
  credentialUuid: string;
  credentialName: string;
  authorityUuid: string;
  authorityName: string;
  raProfileUuid: string;
  raProfileName: string;
}

export function writeSmokeState(state: SmokeState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  logger.info(`Wrote smoke state to ${STATE_FILE}`);
}

export function readSmokeState(): SmokeState | null {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }
  const content = fs.readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(content) as SmokeState;
}

export function deleteSmokeState(): void {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    logger.info(`Deleted smoke state ${STATE_FILE}`);
  }
}
