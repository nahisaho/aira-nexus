import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, rmSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import protocol from '../../shared/conversion-protocol.json' with { type: 'json' };

export interface ConversionRuntimeConfig {
  imageId: string;
  modelsPath: string;
  modelManifestPath: string;
  namespace: string;
}

export interface ConversionRuntimeInput {
  name: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  etag: string;
  jobId: string;
  fence: string;
}

export interface ConversionOutput {
  markdown: Uint8Array;
  documentJson: Uint8Array;
}

export interface DocumentConverter {
  ready(isCurrentClaim?: (jobId: string, fence: string) => Promise<boolean>): Promise<void>;
  convert(input: ConversionRuntimeInput, signal: AbortSignal): Promise<ConversionOutput>;
}

export interface DockerCommandOptions {
  deadlineMs: number;
  stdoutLimit: number;
  stderrLimit: number;
  signal?: AbortSignal;
  stdin?: Uint8Array;
}

export interface DockerCommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Trusted injection boundary; argv excludes the fixed docker executable. */
export interface DockerTransport {
  run(argv: readonly string[], options: DockerCommandOptions): Promise<DockerCommandResult>;
}

export type ConversionFailureCode = (typeof protocol.failureCodes)[number];

export class ConversionRuntimeError extends Error {
  constructor(
    public readonly code: ConversionFailureCode,
    public readonly settled: boolean,
  ) {
    super('Document conversion is unavailable.');
    if (!protocol.failureCodes.includes(code)) this.code = 'handler_failed';
    this.name = 'ConversionRuntimeError';
  }
}

const namespaceLabel = 'aira.conversion.namespace';
const converterLabel = 'aira.conversion.converter';
const jobLabel = 'aira.conversion.job';
const fenceLabel = 'aira.conversion.fence';
const digestPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const controlMs = 15000;
const controlBytes = 65536;
const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class CommandFault extends Error {
  constructor(readonly kind: 'aborted' | 'deadline' | 'overflow' | 'unavailable') {
    super('Document runtime command failed.');
  }
}

function failure(error: unknown, fallback = 'runtime_unavailable'): ConversionRuntimeError {
  if (error instanceof ConversionRuntimeError) return error;
  if (error instanceof CommandFault) {
    if (error.kind === 'overflow') return new ConversionRuntimeError('output_too_large', true);
    if (error.kind === 'aborted') return new ConversionRuntimeError('interrupted', true);
    if (error.kind === 'deadline') return new ConversionRuntimeError('timeout', true);
  }
  return new ConversionRuntimeError(fallback, true);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// JSON.parse alone silently accepts duplicate keys. Only root-object keys are
// relevant here: both manifests and IPC envelopes have flat scalar schemas.
function strictObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!record(parsed)) throw new Error('Invalid object.');
  const seen = new Set<string>();
  let depth = 0;
  let key = false;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (character === '"') {
      const start = cursor;
      let escaped: boolean;
      do {
        cursor = text.indexOf('"', cursor + 1);
        if (cursor < 0) throw new Error('Invalid string.');
        let escapes = 0;
        for (let i = cursor - 1; text[i] === '\\'; i--) escapes++;
        escaped = escapes % 2 !== 0;
      } while (escaped);
      if (depth === 1 && key) {
        const name = JSON.parse(text.slice(start, cursor + 1)) as string;
        if (seen.has(name)) throw new Error('Duplicate key.');
        seen.add(name);
        key = false;
      }
    } else if (character === '{' || character === '[') {
      depth++;
      if (depth === 1) key = true;
    } else if (character === '}' || character === ']') {
      depth--;
    } else if (character === ',' && depth === 1) {
      key = true;
    }
  }
  return parsed;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/** @id CODE-DRT-004 @implements REQ-DRT-004 */
function decodeOutput(result: DockerCommandResult): ConversionOutput {
  if (
    result.stdout.byteLength > protocol.limits.stdoutBytes ||
    result.stderr.byteLength > protocol.limits.stderrBytes
  ) {
    throw new ConversionRuntimeError('output_too_large', true);
  }
  try {
    const frame = strictObject(utf8().decode(result.stdout));
    if (frame.version !== protocol.version) throw new Error('Invalid version.');
    if (
      result.exitCode === 2 &&
      exactKeys(frame, ['version', 'error']) &&
      typeof frame.error === 'string' &&
      protocol.failureCodes.includes(frame.error)
    ) {
      throw new ConversionRuntimeError(frame.error, true);
    }
    if (
      result.exitCode !== 0 ||
      !exactKeys(frame, ['version', 'markdownBase64', 'documentJsonBase64'])
    ) {
      throw new Error('Invalid envelope.');
    }
    const decode = (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
        throw new Error('Invalid encoding.');
      }
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      if ((value.length / 4) * 3 - padding > protocol.limits.outputBytes) {
        throw new ConversionRuntimeError('output_too_large', true);
      }
      const buffer = Buffer.from(value, 'base64');
      if (buffer.toString('base64') !== value) throw new Error('Noncanonical encoding.');
      const text = utf8().decode(buffer);
      if (!text.trim()) throw new Error('Empty output.');
      return { buffer, text };
    };
    const markdown = decode(frame.markdownBase64);
    const document = decode(frame.documentJsonBase64);
    const structured: unknown = JSON.parse(document.text);
    if (!record(structured) || Object.keys(structured).length === 0) {
      throw new Error('Invalid document.');
    }
    return { markdown: markdown.buffer, documentJson: document.buffer };
  } catch (error) {
    throw failure(error, 'output_invalid');
  }
}

class FixedDockerTransport implements DockerTransport {
  run(argv: readonly string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
    return new Promise((accept, reject) => {
      if (options.signal?.aborted) return reject(new CommandFault('aborted'));
      const remaining = options.deadlineMs - Date.now();
      if (remaining <= 0) return reject(new CommandFault('deadline'));
      // Neither daemon selection, Docker credentials nor container environment
      // are inherited from the worker's provider/database/proxy environment.
      const child = spawn('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...argv], {
        shell: false,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent/aira-docling-docker',
          LANG: 'C.UTF-8',
        },
        stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      let finished = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const finish = (error?: CommandFault, exitCode?: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        if (error) {
          child.kill('SIGKILL');
          reject(error);
        } else {
          accept({
            exitCode: exitCode!,
            stdout: Buffer.concat(stdout, stdoutBytes),
            stderr: Buffer.concat(stderr, stderrBytes),
          });
        }
      };
      const aborted = () => finish(new CommandFault('aborted'));
      const timer = setTimeout(() => finish(new CommandFault('deadline')), remaining);
      options.signal?.addEventListener('abort', aborted, { once: true });
      child.on('error', () => finish(new CommandFault('unavailable')));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (finished) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.stdoutLimit) finish(new CommandFault('overflow'));
        else stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (finished) return;
        stderrBytes += chunk.length;
        if (stderrBytes > options.stderrLimit) finish(new CommandFault('overflow'));
        else stderr.push(chunk);
      });
      child.on('close', (code) => {
        if (code === null) finish(new CommandFault('unavailable'));
        else finish(undefined, code);
      });
      child.stdin?.on('error', () => finish(new CommandFault('unavailable')));
      if (options.stdin) child.stdin?.end(options.stdin);
      if (options.signal?.aborted) aborted();
    });
  }
}

type OwnedContainer = {
  id: string;
  job: string;
  fence: string;
  converter: string;
};

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Invalid model.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let length: number;
    do {
      ({ bytesRead: length } = await handle.read(buffer, 0, buffer.length, null));
      hash.update(buffer.subarray(0, length));
    } while (length > 0);
    const after = await handle.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Model changed.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function verifyModels(config: ConversionRuntimeConfig): Promise<void> {
  for (const path of [config.modelsPath, config.modelManifestPath]) {
    if (!isAbsolute(path) || /[,\0\r\n]/.test(path) || (await realpath(path)) !== resolve(path)) {
      throw new Error('Invalid asset path.');
    }
  }
  const permissions = (info: { uid: number; gid: number; mode: number }, bits: number) => {
    const shift = info.uid === 65532 ? 6 : info.gid === 65532 ? 3 : 0;
    return ((info.mode >> shift) & bits) === bits;
  };
  const root = await lstat(config.modelsPath);
  if (!root.isDirectory() || !permissions(root, 5)) throw new Error('Invalid model root.');
  const manifestInfo = await lstat(config.modelManifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > 1048576) {
    throw new Error('Invalid manifest.');
  }
  const manifest = strictObject(await readFile(config.modelManifestPath, 'utf8'));
  const entries = Object.entries(manifest);
  if (entries.length === 0 || entries.length > 20000) throw new Error('Invalid manifest.');
  for (const [path, digest] of entries) {
    if (
      path.length > 1024 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      posix.normalize(path) !== path ||
      typeof digest !== 'string' ||
      !digestPattern.test(digest)
    ) {
      throw new Error('Invalid model entry.');
    }
    const target = resolve(config.modelsPath, path);
    if (relative(config.modelsPath, target).startsWith(`..${sep}`)) {
      throw new Error('Escaping model.');
    }
  }
  const found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Linked model.');
      if (info.isDirectory()) {
        if (!permissions(info, 5)) throw new Error('Inaccessible model directory.');
        await walk(path);
      } else if (info.isFile()) {
        if (!permissions(info, 4)) throw new Error('Inaccessible model.');
        const name = relative(config.modelsPath, path).split(sep).join('/');
        if (!Object.hasOwn(manifest, name) || (await hashFile(path)) !== manifest[name]) {
          throw new Error('Unverified model.');
        }
        found.add(name);
      } else throw new Error('Invalid model material.');
    }
  };
  await walk(config.modelsPath);
  if (found.size !== entries.length || (await realpath(config.modelsPath)) !== config.modelsPath) {
    throw new Error('Missing model.');
  }
}

/** @id CODE-DRT-002 @implements REQ-DRT-002 */
function verifiedInput(input: ConversionRuntimeInput): ConversionRuntimeInput {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength > protocol.limits.inputBytes ||
    input.size > protocol.limits.inputBytes
  ) {
    throw new ConversionRuntimeError('input_too_large', true);
  }
  const bytes = Uint8Array.from(input.bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    !Number.isSafeInteger(input.size) ||
    input.size <= 0 ||
    input.size !== bytes.byteLength ||
    input.sha256 !== digest ||
    input.etag !== `"${digest}"`
  ) {
    throw new ConversionRuntimeError('source_changed', true);
  }
  if (
    typeof input.name !== 'string' ||
    input.name.length > 1024 ||
    !tokenPattern.test(input.jobId) ||
    !tokenPattern.test(input.fence)
  ) {
    throw new ConversionRuntimeError('invalid_input', true);
  }
  const extension = input.name.split('.').at(-1)?.toLowerCase();
  if (!extension || !protocol.formats.includes(extension)) {
    throw new ConversionRuntimeError('unsupported_type', true);
  }
  return { ...input, bytes, name: `source.${extension}` };
}

export class DoclingRuntime implements DocumentConverter {
  private readonly config: ConversionRuntimeConfig;
  private readonly transport: DockerTransport;
  private assets?: Promise<void>;
  private readonly active = new Set<string>();

  constructor(config: ConversionRuntimeConfig, trustedTransport?: DockerTransport) {
    this.config = { ...config };
    this.transport = trustedTransport ?? new FixedDockerTransport();
  }

  private checkConfig(): void {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(this.config.imageId) ||
      !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(this.config.namespace)
    ) {
      throw new ConversionRuntimeError('runtime_unavailable', true);
    }
  }

  private async command(
    argv: readonly string[],
    deadlineMs: number,
    signal?: AbortSignal,
    attached = false,
  ): Promise<DockerCommandResult> {
    if (signal?.aborted) throw new CommandFault('aborted');
    if (deadlineMs <= Date.now()) throw new CommandFault('deadline');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let aborted!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        reject(new CommandFault('aborted'));
        controller.abort();
      };
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => {
        reject(new CommandFault('deadline'));
        controller.abort();
      }, deadlineMs - Date.now());
    });
    const options: DockerCommandOptions = {
      deadlineMs,
      signal: controller.signal,
      stdoutLimit: attached ? protocol.limits.stdoutBytes : controlBytes,
      stderrLimit: protocol.limits.stderrBytes,
    };
    try {
      const result = await Promise.race([this.transport.run(argv, options), interrupted]);
      if (
        result.stdout.byteLength > options.stdoutLimit ||
        result.stderr.byteLength > options.stderrLimit
      ) {
        throw new CommandFault('overflow');
      }
      return result;
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener('abort', aborted);
    }
  }

  private async checked(
    argv: readonly string[],
    deadline = Date.now() + controlMs,
    signal?: AbortSignal,
  ) {
    const result = await this.command(argv, deadline, signal);
    if (result.exitCode !== 0) throw new Error('Runtime command refused.');
    return result;
  }

  private inspected(
    result: DockerCommandResult,
    expected: OwnedContainer,
  ): Record<string, unknown> {
    if (result.exitCode !== 0) throw new Error('Container unavailable.');
    const values: unknown = JSON.parse(utf8().decode(result.stdout));
    if (!Array.isArray(values) || values.length !== 1 || !record(values[0])) {
      throw new Error('Invalid inspection.');
    }
    const value = values[0];
    const config = value.Config;
    if (!record(config) || !record(config.Labels)) throw new Error('Unproven container.');
    const labels = config.Labels;
    if (
      value.Id !== expected.id ||
      labels[namespaceLabel] !== this.config.namespace ||
      labels[converterLabel] !== expected.converter ||
      labels[jobLabel] !== expected.job ||
      labels[fenceLabel] !== expected.fence
    ) {
      throw new Error('Unproven container.');
    }
    return value;
  }

  private async absent(id: string, deadline: number): Promise<boolean> {
    const result = await this.command(
      ['ps', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`],
      deadline,
    );
    return result.exitCode === 0 && utf8().decode(result.stdout).trim() === '';
  }

  /** @id CODE-DRT-005 @implements REQ-DRT-005 */
  private async cleanup(
    owned: OwnedContainer,
    stop: boolean,
    deadline = Date.now() + protocol.limits.stopMs,
  ): Promise<boolean> {
    try {
      let exited = false;
      if (stop) {
        const inspected = await this.command(['inspect', owned.id], deadline);
        if (inspected.exitCode !== 0) return await this.absent(owned.id, deadline);
        const value = this.inspected(inspected, owned);
        if (!record(value.State) || typeof value.State.Running !== 'boolean') return false;
        exited = value.State.Running === false;
        if (!exited) {
          const stopped = await this.command(['stop', '--time', '1', owned.id], deadline);
          if (stopped.exitCode !== 0) await this.command(['kill', owned.id], deadline);
        }
      }
      if (!exited) {
        const waited = await this.command(['wait', owned.id], deadline);
        if (waited.exitCode === 0 && /^\d+\s*$/.test(utf8().decode(waited.stdout))) exited = true;
      }
      if (!exited) {
        const result = await this.command(['inspect', owned.id], deadline);
        if (result.exitCode !== 0) return await this.absent(owned.id, deadline);
        const value = this.inspected(result, owned);
        exited = record(value.State) && value.State.Running === false;
      }
      if (!exited) return false;
      const removed = await this.command(['rm', owned.id], deadline);
      return removed.exitCode === 0 || (await this.absent(owned.id, deadline));
    } catch {
      return false;
    }
  }

  private async stage(input?: ConversionRuntimeInput): Promise<string> {
    const path = resolve(`.docling-runtime-${randomUUID()}`);
    if (/[,\0\r\n]/.test(path)) throw new Error('Invalid private staging path.');
    await mkdir(path, { mode: 0o700 });
    try {
      let parser: Uint8Array;
      try {
        parser = await readFile(new URL('./parser.py', import.meta.url));
      } catch {
        // tsc does not copy Python assets; a checkout deployment retains src.
        parser = await readFile(
          new URL('../../../src/server/conversion/parser.py', import.meta.url),
        );
      }
      await writeFile(resolve(path, 'parser.py'), parser, { flag: 'wx', mode: 0o444 });
      await chmod(resolve(path, 'parser.py'), 0o444);
      await writeFile(resolve(path, 'conversion-protocol.json'), JSON.stringify(protocol), {
        flag: 'wx',
        mode: 0o444,
      });
      await chmod(resolve(path, 'conversion-protocol.json'), 0o444);
      if (input) {
        await writeFile(resolve(path, input.name), input.bytes, { flag: 'wx', mode: 0o444 });
        await chmod(resolve(path, input.name), 0o444);
      }
      return path;
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  /** @id CODE-DRT-003 @implements REQ-DRT-003 */
  private createArgs(
    path: string,
    name: string,
    owned: Omit<OwnedContainer, 'id'>,
    input?: ConversionRuntimeInput,
  ): string[] {
    const args = [
      'create',
      '--name',
      name,
      '--pull',
      'never',
      '--network',
      'none',
      '--user',
      '65532:65532',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '1',
      '--memory',
      '4096m',
      '--memory-swap',
      '4096m',
      '--pids-limit',
      '96',
      '--ipc',
      'none',
      '--restart',
      'no',
      '--log-driver',
      'none',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777',
      '--label',
      `${namespaceLabel}=${this.config.namespace}`,
      '--label',
      `${converterLabel}=${owned.converter}`,
      '--label',
      `${jobLabel}=${owned.job}`,
      '--label',
      `${fenceLabel}=${owned.fence}`,
      '--mount',
      `type=bind,src=${this.config.modelsPath},dst=/models,readonly,bind-recursive=disabled`,
      '--mount',
      `type=bind,src=${path}/parser.py,dst=/app/parser.py,readonly`,
      '--mount',
      `type=bind,src=${path}/conversion-protocol.json,dst=/app/conversion-protocol.json,readonly`,
      '--entrypoint',
      'python',
    ];
    const environment = {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      XDG_CACHE_HOME: '/tmp/cache',
      EASYOCR_MODULE_PATH: '/tmp/easyocr',
      HF_HOME: '/tmp/huggingface',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
    };
    for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
    if (input) {
      args.push('--mount', `type=bind,src=${path}/${input.name},dst=/input/${input.name},readonly`);
    } else {
      // Probes are not durable job claims; concurrent workers must not reap one
      // as a job orphan. Automatic removal also covers a worker dying mid-probe.
      args.push('--rm');
    }
    args.push(this.config.imageId, '-I', '/app/parser.py');
    args.push(...(input ? [`/input/${input.name}`, input.name] : ['--check']));
    return args;
  }

  private async launch(
    input?: ConversionRuntimeInput,
    signal?: AbortSignal,
  ): Promise<DockerCommandResult> {
    const path = await this.stage(input);
    let cleanupDeadline: number | undefined;
    const aborted = () => {
      // Reserve dispatch/bookkeeping time inside the hard 15-second ceiling.
      cleanupDeadline ??= Date.now() + protocol.limits.stopMs - 100;
    };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const token = randomUUID();
    const identity = {
      job: input?.jobId ?? `probe-${token}`,
      fence: input?.fence ?? token,
      converter: input ? 'docling' : 'docling-probe',
    };
    const name = `${this.config.namespace}-${token}`;
    let owned: OwnedContainer | undefined;
    let uncertain = false;
    let stopped = true;
    let output: DockerCommandResult | undefined;
    let problem: unknown;
    let executionDeadline: number | undefined;
    try {
      if (signal?.aborted) throw new CommandFault('aborted');
      uncertain = true;
      const created = await this.checked(
        this.createArgs(path, name, identity, input),
        Date.now() + controlMs,
        signal,
      );
      const id = utf8().decode(created.stdout).trim();
      if (!digestPattern.test(id)) throw new Error('Invalid container identity.');
      owned = { id, ...identity };
      this.active.add(id);
      uncertain = false;
      if (signal?.aborted) throw new CommandFault('aborted');
      executionDeadline = Date.now() + protocol.limits.timeoutMs;
      output = await this.command(['start', '--attach', id], executionDeadline, signal, true);
    } catch (error) {
      problem = error;
      if (error instanceof CommandFault && error.kind === 'deadline' && executionDeadline) {
        cleanupDeadline ??= executionDeadline + protocol.limits.stopMs;
      }
    } finally {
      if (!owned && uncertain) {
        // A killed CLI may have completed create in the daemon. Recover only
        // this invocation's unguessable name plus all four immutable labels.
        cleanupDeadline ??= Date.now() + protocol.limits.stopMs;
        try {
          const result = await this.command(['inspect', name], cleanupDeadline);
          const values: unknown = JSON.parse(utf8().decode(result.stdout));
          if (
            Array.isArray(values) &&
            record(values[0]) &&
            typeof values[0].Id === 'string' &&
            digestPattern.test(values[0].Id)
          ) {
            const recovered = { id: values[0].Id, ...identity };
            this.inspected(result, recovered);
            owned = recovered;
          }
        } catch {
          // Absence cannot disprove a still-pending daemon create.
        }
      }
      if (owned) {
        stopped = await this.cleanup(owned, !output, cleanupDeadline);
        this.active.delete(owned.id);
      } else if (uncertain) stopped = false;
      try {
        // Existing bind mounts retain their inode until daemon cleanup; an
        // uncertain create must not leave a reusable plaintext staging path.
        rmSync(path, { recursive: true, force: true });
      } catch {
        stopped = false;
      }
      signal?.removeEventListener('abort', aborted);
    }
    if (!stopped) throw new ConversionRuntimeError('cancellation_unconfirmed', false);
    if (signal?.aborted) throw new ConversionRuntimeError('interrupted', true);
    if (problem) throw failure(problem);
    return output!;
  }

  private async ensureAssets(): Promise<void> {
    this.checkConfig();
    if (!this.assets) {
      this.assets = (async () => {
        await verifyModels(this.config);
        const inspected = await this.checked(['image', 'inspect', this.config.imageId]);
        const images: unknown = JSON.parse(utf8().decode(inspected.stdout));
        if (
          !Array.isArray(images) ||
          images.length !== 1 ||
          !record(images[0]) ||
          images[0].Id !== this.config.imageId
        ) {
          throw new Error('Unavailable image.');
        }
        const probe = await this.launch();
        const result = strictObject(utf8().decode(probe.stdout));
        if (
          probe.exitCode !== 0 ||
          !exactKeys(result, ['version', 'doclingDistribution', 'doclingVersion']) ||
          result.version !== protocol.version ||
          result.doclingDistribution !== protocol.engine.distribution ||
          result.doclingVersion !== protocol.engine.version
        ) {
          throw new Error('Unavailable engine.');
        }
      })();
    }
    try {
      await this.assets;
    } catch (error) {
      this.assets = undefined;
      throw failure(error);
    }
  }

  /** @id CODE-DRT-006 @implements REQ-DRT-006 */
  async ready(isCurrentClaim?: (jobId: string, fence: string) => Promise<boolean>): Promise<void> {
    try {
      await this.ensureAssets();
      const listed = await this.checked([
        'ps',
        '--all',
        '--no-trunc',
        '--quiet',
        '--filter',
        `label=${namespaceLabel}=${this.config.namespace}`,
        '--filter',
        `label=${converterLabel}=docling`,
        '--filter',
        `label=${jobLabel}`,
        '--filter',
        `label=${fenceLabel}`,
      ]);
      const ids = [...new Set(utf8().decode(listed.stdout).trim().split(/\s+/).filter(Boolean))];
      for (const id of ids) {
        if (!digestPattern.test(id)) throw new Error('Invalid discovered identity.');
        if (this.active.has(id)) continue;
        const deadline = Date.now() + protocol.limits.stopMs;
        const inspected = await this.command(['inspect', id], deadline);
        if (inspected.exitCode !== 0) {
          throw new ConversionRuntimeError('cancellation_unconfirmed', false);
        }
        const found: unknown = JSON.parse(utf8().decode(inspected.stdout));
        if (!Array.isArray(found) || found.length !== 1 || !record(found[0])) {
          throw new Error('Invalid discovery.');
        }
        const config = found[0].Config;
        const labels = record(config) && record(config.Labels) ? config.Labels : {};
        const job = labels[jobLabel];
        const fence = labels[fenceLabel];
        if (
          labels[namespaceLabel] !== this.config.namespace ||
          labels[converterLabel] !== 'docling' ||
          typeof job !== 'string' ||
          !tokenPattern.test(job) ||
          typeof fence !== 'string' ||
          !tokenPattern.test(fence)
        )
          continue;
        const owned = { id, job, fence, converter: 'docling' };
        this.inspected(inspected, owned);
        if (!isCurrentClaim) throw new Error('Claim authority unavailable.');
        // Claim lookup shares this orphan's recovery deadline; never assume a
        // database failure means the container belongs to an expired worker.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let current: boolean;
        try {
          current = await Promise.race([
            isCurrentClaim(job, fence),
            new Promise<never>((_accept, reject) => {
              timer = setTimeout(
                () => reject(new Error('Claim deadline.')),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (current === true) continue;
        if (current !== false) throw new Error('Claim authority unavailable.');
        if (!(await this.cleanup(owned, true, deadline))) {
          throw new ConversionRuntimeError('cancellation_unconfirmed', false);
        }
      }
    } catch (error) {
      throw failure(error);
    }
  }

  async convert(input: ConversionRuntimeInput, signal: AbortSignal): Promise<ConversionOutput> {
    try {
      this.checkConfig();
      const verified = verifiedInput(input);
      if (signal.aborted) throw new ConversionRuntimeError('interrupted', true);
      await this.ensureAssets();
      if (signal.aborted) throw new ConversionRuntimeError('interrupted', true);
      const result = await this.launch(verified, signal);
      if (signal.aborted) throw new ConversionRuntimeError('interrupted', true);
      return decodeOutput(result);
    } catch (error) {
      throw failure(error);
    }
  }
}
