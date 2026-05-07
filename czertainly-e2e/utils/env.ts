import * as dotenv from 'dotenv';
dotenv.config();

type AuthMode = 'local' | 'oidc';

export type TestEnv = {
  baseUrl: string;
  authMode: AuthMode;
  username: string;
  password: string;
  clientSecret?: string;
  authClientId: string;
  authRealm: string;
  authBaseUrl?: string;
  localAuthProviderName: string;
  discoveryProviderName?: string;
  discoveryProviderUrl?: string;
  discoveryTarget?: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadEnv(): TestEnv {
  const authMode = (process.env.AUTH_MODE ?? 'local') as AuthMode;
  if (authMode !== 'local' && authMode !== 'oidc') {
    throw new Error(`AUTH_MODE must be either 'local' or 'oidc', but got: ${process.env.AUTH_MODE}`);
  }

  return {
    baseUrl: required('BASE_URL'),
    authMode,
    username: required('SMOKE_USERNAME'),
    password: required('SMOKE_PASSWORD'),
    clientSecret: process.env.SMOKE_CLIENT_SECRET,
    authClientId: process.env.AUTH_CLIENT_ID || 'ilm',
    authRealm: process.env.AUTH_REALM || 'ILM',
    authBaseUrl: process.env.AUTH_BASE_URL, // Defaults to baseUrl/kc if not set
    localAuthProviderName: required('LOCAL_AUTH_PROVIDER_NAME'),
    discoveryProviderUrl: process.env.DISCOVERY_PROVIDER_URL,
    discoveryProviderName: process.env.DISCOVERY_PROVIDER_NAME,
    discoveryTarget: process.env.DISCOVERY_TARGET,
  };
}
