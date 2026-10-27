/**
 * ownCertificates — pure checks of utils/regression/ownCertificates.ts without an environment: the SAN oracle each CA gets
 * and the special-character common name of the distinguished-name row.
 */
import { expect, test } from '@playwright/test';
import { carriesRunPrefix } from '../../utils/regression/ledger/ownership';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { sanOracleFor, specialCharCn } from '../../utils/regression/ownCertificates';

test('the SAN oracle per CA connector: exact for EJBCA-NG, dns for MS ADCS, exact for a connector named in REG_EXACT_SAN_CONNECTORS', () => {
    expect(sanOracleFor('EJBCA-NG-Connector', {})).toBe('exact');
    expect(sanOracleFor('MS-ADCS-NG-Connector', {})).toBe('dns');
    expect(sanOracleFor('PyADCS-Connector', { REG_EXACT_SAN_CONNECTORS: 'PyADCS-Connector' })).toBe('exact');
});

test('the API-CERT-21[rfc4514] CN starts with the run prefix (the teardown\'s ownership rule), the special characters come after it; a leading space would not be own', () => {
    const cn = specialCharCn(runName('c21dn-x'));
    expect(cn.startsWith(`${runId()}-`)).toBe(true);
    expect(cn).toMatch(/, O= QA\+Team$/);
    expect(carriesRunPrefix(cn, runId(), 'certificates')).toBe(true);
    expect(carriesRunPrefix(` ${cn}`, runId(), 'certificates'), 'the old shape (leading space) is refused by the ownership rule').toBe(false);
});
