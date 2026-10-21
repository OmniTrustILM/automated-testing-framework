/**
 * ownRaProfiles — pure checks of utils/regression/ownRaProfiles.ts without an environment: the order in which the run
 * picks a CA connector for its RA profile, the REG_CA_CONNECTORS override, and the SAN oracle each CA gets.
 * Moved here from the former grab-bag file of the 18 main flows, so the file is named after the module it tests.
 */
import { expect, test } from '@playwright/test';
import { sanOracleFor } from '../../utils/regression/ownCertificates';
import { caConnectorOrder } from '../../utils/regression/ownRaProfiles';

// ------------------------------------------------------------------ regressionApi (pure parts)

test('the CA order (MS ADCS, EJBCA-NG, PyADCS), REG_CA_CONNECTORS and the SAN oracle per CA', () => {
    expect(caConnectorOrder({})).toEqual(['MS-ADCS-NG-Connector', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_ADCS_CONNECTOR: 'ADCS-X' })).toEqual(['ADCS-X', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_CA_CONNECTORS: 'B, A ,B' })).toEqual(['B', 'A']);
    expect(sanOracleFor('EJBCA-NG-Connector', {})).toBe('exact');
    expect(sanOracleFor('MS-ADCS-NG-Connector', {})).toBe('dns');
    expect(sanOracleFor('PyADCS-Connector', { REG_EXACT_SAN_CONNECTORS: 'PyADCS-Connector' })).toBe('exact');
});
