export interface Principal {
  tenantId: string;
  objectId: string;
}

export interface Project {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConfig {
  tenantId: string;
  apiClientId: string;
  spaClientId: string;
  scope: string;
  publicOrigin: string;
}

export interface ApiFailure {
  error: { code: string; message: string; requestId: string };
}
