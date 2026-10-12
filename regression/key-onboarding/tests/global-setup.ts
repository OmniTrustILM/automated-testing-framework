import * as fs from 'fs';
import { AdminApi } from './utils/adminApi';
import { provisioningFile, Provisioning, runDir } from './utils/env';
import { provisionToken } from './utils/provision';
import { plantKeys } from './utils/token';

export default async function globalSetup(): Promise<void> {
  const api = await AdminApi.open();
  try {
    const { token, tokenProfile } = await provisionToken(api);
    const provisioning: Provisioning = { token, tokenProfile, ...plantKeys() };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(provisioningFile, JSON.stringify(provisioning, null, 2));
  } finally {
    await api.dispose();
  }
}
