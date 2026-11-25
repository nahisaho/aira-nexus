import type { ConversionRuntimeConfig } from './runtime.js';
import { isAbsolute } from 'node:path';

/** @id CODE-DCV-003 @implements REQ-DCV-007 */
export function readConversionConfig(
  env: NodeJS.ProcessEnv,
  dependencies: { jobsEnabled: boolean; filesConfigured: boolean },
): ConversionRuntimeConfig | undefined {
  if (env.DOCUMENT_CONVERSION_ENABLED === undefined || env.DOCUMENT_CONVERSION_ENABLED === 'false')
    return undefined;
  const imageId = env.DOCUMENT_CONVERSION_IMAGE_ID;
  const modelsPath = env.DOCUMENT_CONVERSION_MODELS_PATH;
  const modelManifestPath = env.DOCUMENT_CONVERSION_MODEL_MANIFEST_PATH;
  const namespace = env.DOCUMENT_CONVERSION_NAMESPACE;
  if (
    env.DOCUMENT_CONVERSION_ENABLED !== 'true' ||
    !dependencies.jobsEnabled ||
    !dependencies.filesConfigured ||
    !imageId ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !modelsPath ||
    !isAbsolute(modelsPath) ||
    !modelManifestPath ||
    !isAbsolute(modelManifestPath) ||
    !namespace ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(namespace)
  )
    throw new Error('Invalid or incomplete document conversion configuration.');
  return { imageId, modelsPath, modelManifestPath, namespace };
}
