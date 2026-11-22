export type FileStorageConfig =
  | { mode: 'azurite'; endpoint: string; container: string; account: string; key: string }
  | { mode: 'azure'; endpoint: string; container: string; clientId?: string };
export function readFileStorageConfig(env: NodeJS.ProcessEnv): FileStorageConfig | undefined {
  const fields = [
    'AZURITE_BLOB_ENDPOINT',
    'AZURITE_ACCOUNT_NAME',
    'AZURITE_ACCOUNT_KEY',
    'AZURE_STORAGE_ACCOUNT_URL',
    'AZURE_STORAGE_CONTAINER',
    'AZURE_MANAGED_IDENTITY_CLIENT_ID',
  ];
  const mode = env.FILE_STORAGE_MODE;
  if (mode === undefined) {
    if (fields.some((field) => env[field] !== undefined))
      throw new Error('Incomplete file storage configuration.');
    return undefined;
  }
  const container = env.AZURE_STORAGE_CONTAINER ?? 'aira-nexus';
  if (mode === 'azurite')
    return validateFileStorageConfig({
      mode,
      container,
      endpoint: env.AZURITE_BLOB_ENDPOINT ?? '',
      account: env.AZURITE_ACCOUNT_NAME ?? '',
      key: env.AZURITE_ACCOUNT_KEY ?? '',
    });
  if (mode === 'azure') {
    if (
      ['AZURITE_BLOB_ENDPOINT', 'AZURITE_ACCOUNT_NAME', 'AZURITE_ACCOUNT_KEY'].some(
        (field) => env[field] !== undefined,
      )
    )
      throw new Error('Azure mode must not include Azurite credentials or endpoints.');
    return validateFileStorageConfig({
      mode,
      container,
      endpoint: env.AZURE_STORAGE_ACCOUNT_URL ?? '',
      ...(env.AZURE_MANAGED_IDENTITY_CLIENT_ID === undefined
        ? {}
        : { clientId: env.AZURE_MANAGED_IDENTITY_CLIENT_ID }),
    });
  }
  throw new Error('Invalid file storage mode.');
}
export function validateFileStorageConfig(config: FileStorageConfig): FileStorageConfig {
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new Error('Invalid file storage endpoint.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.container) ||
    config.container.includes('--')
  )
    throw new Error('Invalid file storage configuration.');
  if (config.mode === 'azurite') {
    const key = Buffer.from(config.key, 'base64');
    if (
      !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/|$)/.test(config.endpoint) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^[a-z0-9]{3,24}$/.test(config.account) ||
      ![`/${config.account}`, `/${config.account}/`].includes(url.pathname) ||
      key.length !== 64 ||
      key.toString('base64') !== config.key
    )
      throw new Error('Azurite requires a numeric loopback endpoint and a valid account key.');
  } else if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    !/^[a-z0-9]{3,24}\.blob\.(?:core\.windows\.net|core\.usgovcloudapi\.net|core\.chinacloudapi\.cn)$/.test(
      url.hostname,
    ) ||
    (config.clientId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.clientId))
  )
    throw new Error('Azure requires an HTTPS account endpoint and managed identity.');
  return config;
}
