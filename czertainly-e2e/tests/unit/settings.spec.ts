/**
 * settings — the reader of the regression and API environment (utils/regression/run/settings.ts).
 *
 * Checks `settings(env)` members (defaults, the two spellings of the local-stack variables, an injected `env`), and that
 * every variable the reader names is documented in .env.example (the internal pins in a line that says the run sets
 * them). A variable read in code but missing from .env.example, or a documented one the code ignores under another
 * spelling, is the drift this reader exists to stop. Pure; the source of settings.ts and .env.example are read as text.
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { INTERNAL_PINS, settings } from '../../utils/regression/run/settings';

const ROOT = path.resolve(__dirname, '..', '..');

test('defaults are written once and an unset variable gives them', () => {
    const s = settings({});
    expect([s.adcsConnector, s.credentialConnector, s.pkcs11Connector, s.authMode, s.coreReplicas, s.stubBindHost, s.stubAdvertisedHost, s.kubectlBin]).toEqual([
        'MS-ADCS-NG-Connector', 'Common-Credential-Connector', 'PKCS11-Cryptography-Provider', 'local', '1', '127.0.0.1', 'host.docker.internal', 'kubectl',
    ]);
    expect(s.caConnectors).toEqual(['MS-ADCS-NG-Connector', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(s.exactSanConnectors).toEqual(['EJBCA-NG-Connector']);
    expect(s.services).toEqual({ core: 'core', rabbitmq: 'rabbitmq', db: 'db', auth: 'auth', scheduler: 'scheduler' });
    expect([s.scanHost, s.scanBind, s.webhookBind, s.smtpCatcherUrl]).toEqual(['', '0.0.0.0', '0.0.0.0', '']);
    expect([s.composeFile, s.composeProject, s.runId, s.restrictedUsername]).toEqual([undefined, undefined, undefined, undefined]);
});

test('the CA order follows the ADCS connector name unless REG_CA_CONNECTORS is set; lists are trimmed and de-duplicated', () => {
    expect(settings({ REG_ADCS_CONNECTOR: 'Other-ADCS' }).caConnectors[0]).toBe('Other-ADCS');
    expect(settings({ REG_CA_CONNECTORS: ' A , B,A ,' }).caConnectors).toEqual(['A', 'B']);
    expect(settings({ REG_EXACT_SAN_CONNECTORS: 'X, Y' }).exactSanConnectors).toEqual(['X', 'Y']);
});

test('both spellings of the local-stack variables are read: LOCAL_COMPOSE_* first, its alias REG_LOCAL_COMPOSE_* when it is not set', () => {
    expect(settings({ REG_LOCAL_COMPOSE_PROJECT: 'alias', REG_LOCAL_COMPOSE_FILE: ' f.yml ' }).composeProject).toBe('alias');
    expect(settings({ REG_LOCAL_COMPOSE_PROJECT: 'alias', REG_LOCAL_COMPOSE_FILE: ' f.yml ' }).composeFile).toBe('f.yml');
    expect(settings({ LOCAL_COMPOSE_PROJECT: 'main', REG_LOCAL_COMPOSE_PROJECT: 'alias' }).composeProject).toBe('main');
    expect(settings({ LOCAL_COMPOSE_PROJECT: '  ', REG_LOCAL_COMPOSE_PROJECT: 'alias' }).composeProject).toBe('alias');
    expect(settings({ REG_LOCAL_SERVICE_CORE: 'c2' }).services.core).toBe('c2');
    expect(settings({ REG_LOCAL_SERVICE_CORE: 'c2', LOCAL_SERVICE_CORE: 'c1' }).services.core).toBe('c1');
});

test('members read the injected env lazily, not process.env', () => {
    const env: NodeJS.ProcessEnv = {};
    const s = settings(env);
    expect(s.scanHost).toBe('');
    env.REG_SCAN_HOST = ' scan.example.test ';
    expect(s.scanHost).toBe('scan.example.test');
    expect(settings({}).strictVersions).toBe(false);
    expect(settings({ REG_STRICT_VERSIONS: 'true' }).strictVersions).toBe(true);
});

test('the real docker CLI stays disabled under the unit tests even when an injected env does not say so', () => {
    // the unit config sets REG_UNIT_NO_DOCKER for every worker: an injected env cannot lift it
    expect(process.env.REG_UNIT_NO_DOCKER).toBe('1');
    expect(settings({}).unitNoDocker).toBe(true);
    expect(settings({ REG_UNIT_NO_DOCKER: '0' }).unitNoDocker).toBe(true);
    // without the process value the injected env decides (the lift-proof is the process value)
    const saved = process.env.REG_UNIT_NO_DOCKER;
    delete process.env.REG_UNIT_NO_DOCKER;
    try {
        expect(settings({}).unitNoDocker).toBe(false);
        expect(settings({ REG_UNIT_NO_DOCKER: '1' }).unitNoDocker).toBe(true);
    } finally {
        process.env.REG_UNIT_NO_DOCKER = saved;
    }
});

test('every variable settings.ts reads is documented in .env.example; the internal pins are named as set by the run', () => {
    const source = fs.readFileSync(path.join(ROOT, 'utils', 'regression', 'run', 'settings.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const read = new Set(source.match(/\b(?:REG|API|TIER|LOCAL|AUTH)_[A-Z0-9_]+\b|\bBASE_URL\b|\bKUBECONFIG\b/g) ?? []);
    for (const pin of INTERNAL_PINS) read.add(pin);
    expect(read.size, 'the reader names its variables').toBeGreaterThan(60);
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const missing = [...read].filter((name) => !new RegExp(`\\b${name}\\b`).test(example)).sort();
    expect(missing, 'variables read by settings.ts but absent from .env.example').toEqual([]);
    const pinStart = example.search(/^.*set by the run.*$/im);
    expect(pinStart, '.env.example has a line saying the run sets the internal pins').toBeGreaterThanOrEqual(0);
    const pinBlock = example.slice(pinStart);
    for (const pin of INTERNAL_PINS) expect(pinBlock, `${pin} is listed as set by the run`).toContain(pin);
});
