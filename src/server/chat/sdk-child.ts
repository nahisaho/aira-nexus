import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PrivateSdkChild {
  baseDirectory: string;
  workingDirectory: string;
  env: Record<string, string | undefined>;
  dispose(): Promise<void>;
}

/** @id CODE-CHC-007 @implements REQ-CHC-004 REQ-CHC-005 */
/** @id CODE-CHR-002 @implements REQ-CHR-002 */
export async function createPrivateSdkChild(): Promise<PrivateSdkChild> {
  const directory = await mkdtemp(join(tmpdir(), 'aira-chat-sdk-'));
  const home = join(directory, 'home');
  const config = join(directory, 'config');
  const workingDirectory = join(directory, 'work');
  const temp = join(directory, 'tmp');
  try {
    await chmod(directory, 0o700);
    for (const child of [home, config, workingDirectory, temp]) await mkdir(child, { mode: 0o700 });
  } catch (error) {
    await rm(directory, { recursive: true, force: false });
    throw error;
  }
  const env: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    APPDATA: config,
    LOCALAPPDATA: config,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    LANG: 'C.UTF-8',
    OTEL_SDK_DISABLED: 'true',
    DO_NOT_TRACK: '1',
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return {
    baseDirectory: directory,
    workingDirectory,
    env,
    dispose: () => rm(directory, { recursive: true, force: false }),
  };
}
