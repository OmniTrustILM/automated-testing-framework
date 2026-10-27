/**
 * ownRaProfiles — pure checks of utils/regression/ownRaProfiles.ts without an environment: the order in which the run
 * picks a CA connector for its RA profile and the REG_CA_CONNECTORS override.
 * Moved here from the former grab-bag file of the 18 main flows, so the file is named after the module it tests.
 */
import { expect, test } from '@playwright/test';
import { caConnectorOrder } from '../../utils/regression/ownRaProfiles';

// ------------------------------------------------------------------ regressionApi (pure parts)

test('the CA order (MS ADCS, EJBCA-NG, PyADCS) and REG_CA_CONNECTORS', () => {
    expect(caConnectorOrder({})).toEqual(['MS-ADCS-NG-Connector', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_ADCS_CONNECTOR: 'ADCS-X' })).toEqual(['ADCS-X', 'EJBCA-NG-Connector', 'PyADCS-Connector']);
    expect(caConnectorOrder({ REG_CA_CONNECTORS: 'B, A ,B' })).toEqual(['B', 'A']);
});
