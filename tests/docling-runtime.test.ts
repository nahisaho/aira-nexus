import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import protocol from '../src/shared/conversion-protocol.json' with { type: 'json' };
import {
  DoclingRuntime,
  type ConversionRuntimeConfig,
  type ConversionRuntimeInput,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerTransport,
} from '../src/server/conversion/runtime.js';

const execute = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const imageId = `sha256:${'8'.repeat(64)}`;
const jobId = 'c2a00000-0000-4000-8000-000000000001';
const fence = 'f3000000-0000-4000-8000-000000000002';
const namespace = 'docling-test-worker';
const labels = {
  'aira.conversion.namespace': namespace,
  'aira.conversion.converter': 'docling',
  'aira.conversion.job': jobId,
  'aira.conversion.fence': fence,
};
const markdown = '# 合成資料\n\nJapanese 日本語 / English OCR';
const documentJson = JSON.stringify({
  schema_name: 'DoclingDocument',
  texts: [{ text: '日本語' }],
});
const envelope = (md = markdown, json = documentJson) =>
  JSON.stringify({
    version: 1,
    markdownBase64: Buffer.from(md).toString('base64'),
    documentJsonBase64: Buffer.from(json).toString('base64'),
  });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const containerId = (value: number) => value.toString(16).padStart(64, '0');
const bytes = encoder.encode('%PDF-1.7\nsynthetic-only');
const input = (changes: Partial<ConversionRuntimeInput> = {}): ConversionRuntimeInput => ({
  name: 'synthetic.pdf',
  bytes,
  size: bytes.length,
  sha256: digest(bytes),
  etag: `"${digest(bytes)}"`,
  jobId,
  fence,
  ...changes,
});
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = resolve(`.docling-runtime-test-${randomUUID()}`);
  roots.push(root);
  const modelsPath = resolve(root, 'models');
  await mkdir(resolve(modelsPath, 'ocr'), { recursive: true });
  await writeFile(resolve(modelsPath, 'ocr/model.bin'), 'synthetic-model');
  const modelManifestPath = resolve(root, 'models.sha256.json');
  // Strict JSON object: relative POSIX model-file path -> lowercase SHA256 digest.
  await writeFile(
    modelManifestPath,
    JSON.stringify({ 'ocr/model.bin': digest('synthetic-model') }),
  );
  const config: ConversionRuntimeConfig = { imageId, modelsPath, modelManifestPath, namespace };
  return { root, config };
}

type Call = { argv: readonly string[]; options: DockerCommandOptions; at: number };
type Container = {
  Id: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean; Status: string };
};
const container = (id: string, overrides: Record<string, string> = {}): Container => ({
  Id: id,
  Config: { Labels: { ...labels, ...overrides } },
  State: { Running: true, Status: 'running' },
});
const reply = (stdout: string, exitCode = 0, stderr = ''): DockerCommandResult => ({
  exitCode,
  stdout: encoder.encode(stdout),
  stderr: encoder.encode(stderr),
});

class DockerDouble implements DockerTransport {
  calls: Call[] = [];
  containers = new Map<string, Container>();
  frames: DockerCommandResult[] = [];
  inspectedImageId = imageId;
  probe = { version: 1, doclingDistribution: 'docling-slim', doclingVersion: '2.150.0' };
  start?: (call: Call) => Promise<DockerCommandResult>;
  cleanup?: (call: Call) => Promise<DockerCommandResult | undefined>;
  discoveryIds: string[] = [];
  private probes = new Set<string>();
  private nextId = 0;

  async run(argv: readonly string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
    const call = { argv: [...argv], options: { ...options }, at: Date.now() };
    this.calls.push(call);
    const command = argv[0];
    if (command === 'image' && argv[1] === 'inspect') {
      return reply(JSON.stringify([{ Id: this.inspectedImageId, Config: { Labels: {} } }]));
    }
    if (command === 'ps') return reply(this.discoveryIds.join('\n'));
    if (command === 'create') {
      const id = containerId(++this.nextId);
      const parsedLabels: Record<string, string> = {};
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '--label') {
          const value = argv[i + 1]!;
          const split = value.indexOf('=');
          parsedLabels[value.slice(0, split)] = value.slice(split + 1);
        }
      }
      this.containers.set(id, container(id, parsedLabels));
      if (argv.includes('--check')) this.probes.add(id);
      return reply(`${id}\n`);
    }
    const id = argv.at(-1)!;
    if (command === 'start') {
      if (this.probes.has(id)) return reply(JSON.stringify(this.probe));
      if (this.start) return this.start(call);
      return this.frames.shift() ?? reply(envelope());
    }
    if (
      command === 'stop' ||
      command === 'kill' ||
      command === 'wait' ||
      command === 'inspect' ||
      command === 'rm'
    ) {
      const overridden = await this.cleanup?.(call);
      if (overridden) return overridden;
      const found = this.containers.get(id);
      if (command === 'inspect') {
        return found ? reply(JSON.stringify([found])) : reply('', 1, 'Error: No such container');
      }
      if (command === 'rm') {
        if (found?.State.Running) return reply('', 1, 'container is running');
        this.containers.delete(id);
        return reply(id);
      }
      if (found) found.State = { Running: false, Status: 'exited' };
      return reply(command === 'wait' ? '0\n' : id);
    }
    return reply('', 1, 'unsupported synthetic docker operation');
  }
}

async function outcome<T>(work: Promise<T>) {
  try {
    return { ok: true as const, value: await work };
  } catch (error) {
    const failure = error as Error & { code?: string; settled?: boolean };
    return {
      ok: false as const,
      code: failure.code,
      settled: failure.settled,
      message: failure.message,
    };
  }
}

async function convert(
  runtime: DoclingRuntime,
  value = input(),
  signal = new AbortController().signal,
) {
  return outcome(runtime.convert(value, signal));
}

function expectSuccess(result: Awaited<ReturnType<typeof convert>>) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected successful conversion control');
  expect(decoder.decode(result.value.markdown)).toBe(markdown);
  expect(decoder.decode(result.value.documentJson)).toBe(documentJson);
}

function expectFailure(result: Awaited<ReturnType<typeof convert>>, code: string, settled = true) {
  expect(result).toMatchObject({ ok: false, code, settled });
  if (result.ok) throw new Error('Unexpected successful conversion');
  expect(protocol.failureCodes).toContain(result.code);
  expect(result.message).not.toMatch(/PRIVATE_|\/home\/|password|Traceback|secret-source/i);
}

// Python substitutes only the external Docling engine: the production parser CLI
// still validates formats/status/pages/OCR/version and builds its own IPC frame.
const pythonHarness = String.raw`
import copy, enum, importlib.metadata, json, pathlib, runpy, sys, types
parser, source, name, trace_path, version = sys.argv[1:]
payload = json.loads(pathlib.Path(source).read_text())
trace = {"distributions": [], "convert": [], "options": {}}
def save():
    pathlib.Path(trace_path).write_text(json.dumps(trace))
def module(name, **attrs):
    value = types.ModuleType(name)
    for key, item in attrs.items(): setattr(value, key, item)
    sys.modules[name] = value
    return value
for parent in ("docling", "docling.datamodel", "docling.backend", "docling.exceptions"):
    value = module(parent)
    value.__path__ = []
class InputFormat(enum.Enum):
    PDF="pdf"; DOCX="docx"; PPTX="pptx"; XLSX="xlsx"; IMAGE="image"
class ConversionStatus(enum.Enum):
    SUCCESS="success"; PARTIAL_SUCCESS="partial_success"; FAILURE="failure"
class Options:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
    def model_copy(self, deep=False):
        return copy.deepcopy(self) if deep else copy.copy(self)
class PdfPipelineOptions(Options):
    def __init__(self, **kwargs):
        self.do_ocr = True
        self.ocr_options = Options(lang=[])
        self.generate_picture_images = False
        self.generate_page_images = False
        super().__init__(**kwargs)
class RapidOcrOptions(Options): pass
class AcceleratorDevice(enum.Enum):
    CPU="cpu"
class ConversionError(Exception): pass
class PdfHandle: pass
class PdfDocument:
    def __init__(self, *args, **kwargs):
        self.raw = PdfHandle()
        if payload.get("encrypted"): raise RuntimeError("PRIVATE_encrypted password")
    def __len__(self): return payload.get("pages", 1)
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
def security_revision(handle):
    if not isinstance(handle, PdfHandle): raise TypeError("Expected raw PDF handle")
    return -1
module("pypdfium2", PdfDocument=PdfDocument, PdfiumError=RuntimeError,
       raw=Options(FPDF_GetSecurityHandlerRevision=security_revision))
class Document:
    def export_to_markdown(self, **kwargs): return payload.get("markdown", "# 合成資料\n\nJapanese 日本語 / English OCR")
    def export_to_dict(self, **kwargs):
        return payload.get("document", {"schema_name":"DoclingDocument","texts":[{"text":"日本語"}]})
    def export_to_json(self, **kwargs):
        return json.dumps(self.export_to_dict(), ensure_ascii=False, separators=(",",":"))
class DocumentConverter:
    def __init__(self, **kwargs):
        for key, option in kwargs.get("format_options", {}).items():
            opts = getattr(option, "pipeline_options", option)
            trace["options"][str(key.value)] = {
                "ocr": getattr(opts, "do_ocr", False),
                "languages": getattr(getattr(opts, "ocr_options", None), "lang", []),
                "downloads": getattr(getattr(opts, "ocr_options", None), "download_enabled", None),
                "remote": getattr(opts, "enable_remote_services", None),
            }
        save()
    def convert(self, source, **kwargs):
        trace["convert"].append(kwargs)
        save()
        if payload.get("raises"): raise RuntimeError("PRIVATE_document /home/private/secret-source")
        status = ConversionStatus(payload.get("status", "success"))
        return Options(document=Document(), status=status, errors=[], pages=[None]*payload.get("pages",1))
def pinned_version(name):
    trace["distributions"].append(name)
    save()
    if name != "docling-slim": raise importlib.metadata.PackageNotFoundError(name)
    return version
importlib.metadata.version = pinned_version
importlib.metadata.distribution = lambda name: Options(version=pinned_version(name), metadata={"Name":name})
module("docling.datamodel.base_models", InputFormat=InputFormat, ConversionStatus=ConversionStatus, DocumentStream=Options)
module("docling.datamodel.pipeline_options", PdfPipelineOptions=PdfPipelineOptions, RapidOcrOptions=RapidOcrOptions,
       OcrMacOptions=Options, EasyOcrOptions=Options)
module("docling.datamodel.accelerator_options", AcceleratorDevice=AcceleratorDevice, AcceleratorOptions=Options)
module("docling.document_converter", DocumentConverter=DocumentConverter, PdfFormatOption=Options, ImageFormatOption=Options)
module("docling.exceptions", ConversionError=ConversionError)
sys.argv = [parser, source, name]
if payload.get("mountedParserPath"):
    script = pathlib.Path(parser).read_text()
    manifest = (pathlib.Path(parser).parents[2] / "shared" / "conversion-protocol.json").read_text()
    original_is_file = pathlib.Path.is_file
    original_read_text = pathlib.Path.read_text
    pathlib.Path.is_file = lambda path: str(path) == "/app/conversion-protocol.json" or original_is_file(path)
    pathlib.Path.read_text = lambda path, *args, **kwargs: manifest if str(path) == "/app/conversion-protocol.json" else original_read_text(path, *args, **kwargs)
    exec(compile(script, "/app/parser.py", "exec"), {"__file__": "/app/parser.py", "__name__": "__main__"})
else:
    runpy.run_path(parser, run_name="__main__")
`;

async function parse(
  root: string,
  name: string,
  payload: Record<string, unknown> = {},
  version = '2.150.0',
) {
  const source = resolve(root, `parser-input.${name.split('.').at(-1)}`);
  const tracePath = resolve(root, 'parser-trace.json');
  await writeFile(source, JSON.stringify(payload));
  await rm(tracePath, { force: true });
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    const result = await execute(
      'python3',
      [
        '-I',
        '-c',
        pythonHarness,
        resolve('src/server/conversion/parser.py'),
        source,
        name,
        tracePath,
        version,
      ],
      {
        maxBuffer: 70000000,
        timeout: 10000,
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    ({ stdout, stderr } = result);
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = typeof failure.code === 'number' ? failure.code : -1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  }
  const trace = JSON.parse(await readFile(tracePath, 'utf8').catch(() => '{}')) as {
    distributions?: string[];
    options?: Record<
      string,
      {
        ocr: boolean;
        languages: string[];
        downloads: boolean | null;
        remote: boolean | null;
      }
    >;
  };
  let frame: unknown;
  try {
    frame = JSON.parse(stdout);
  } catch {
    frame = null;
  }
  return { exitCode, stdout, stderr, frame, trace };
}

/** @id TEST-DRT-001 @verifies REQ-DRT-001 */
it('TEST-DRT-001 converts six formats with pinned ja/en OCR and rejects failed, partial, encrypted and unsupported documents', async () => {
  const { root, config } = await fixture();
  const mounted = await parse(root, 'mounted.pdf', { mountedParserPath: true });
  expect(mounted.exitCode, mounted.stdout + mounted.stderr).toBe(0);
  const daemon = new DockerDouble();
  const runtime = new DoclingRuntime(config, daemon);
  for (const extension of ['pdf', 'docx', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg']) {
    const parsed = await parse(root, `synthetic.${extension}`);
    expect(parsed.exitCode, parsed.stdout + parsed.stderr).toBe(0);
    expect(parsed.frame).toMatchObject({ version: 1 });
    const frame = parsed.frame as { markdownBase64: string; documentJsonBase64: string };
    expect(Buffer.from(frame.markdownBase64, 'base64').toString('utf8')).toBe(markdown);
    expect(JSON.parse(Buffer.from(frame.documentJsonBase64, 'base64').toString('utf8'))).toEqual(
      JSON.parse(documentJson),
    );
    expect(parsed.trace.distributions).toContain('docling-slim');
    if (['pdf', 'png', 'jpg', 'jpeg'].includes(extension)) {
      const options = Object.values(parsed.trace.options ?? {});
      expect(
        options.some(
          (item) =>
            item.ocr &&
            item.languages.includes('en') &&
            (item.languages.includes('ja') || item.languages.includes('japan')),
        ),
      ).toBe(true);
      expect(options.every((item) => item.downloads === false && item.remote === false)).toBe(true);
    }
    expectSuccess(await convert(runtime, input({ name: `synthetic.${extension}` })));
  }
  for (const [name, payload, expected] of [
    ['synthetic.exe', {}, 'unsupported_type'],
    ['synthetic.pdf', { encrypted: true }, 'invalid_document'],
    ['synthetic.pdf', { raises: true }, 'invalid_document'],
    ['synthetic.docx', { status: 'partial_success' }, 'conversion_failed'],
    ['synthetic.xlsx', { status: 'failure' }, 'conversion_failed'],
    ['synthetic.pptx', { markdown: '' }, 'conversion_failed'],
    ['synthetic.png', { document: {} }, 'conversion_failed'],
  ] as const) {
    const parsed = await parse(root, name, payload);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.frame).toEqual({ version: 1, error: expected });
    expect(parsed.stdout + parsed.stderr).not.toMatch(/PRIVATE_|Traceback|secret-source/);
  }
  const wrongPin = await parse(root, 'synthetic.pdf', {}, '2.149.0');
  expect(wrongPin).toMatchObject({
    exitCode: 2,
    frame: { version: 1, error: 'runtime_unavailable' },
  });
  expectSuccess(await convert(runtime));
});

/** @id TEST-DRT-002 @verifies REQ-DRT-002 */
it('TEST-DRT-002 enforces source identity, 25MB, PDF page boundaries and a 300s execution deadline without partial artifacts', async () => {
  const { root, config } = await fixture();
  const daemon = new DockerDouble();
  const runtime = new DoclingRuntime(config, daemon);
  expectSuccess(await convert(runtime));
  const boundary = new Uint8Array(25000000);
  expectSuccess(
    await convert(
      runtime,
      input({
        bytes: boundary,
        size: boundary.length,
        sha256: digest(boundary),
        etag: `"${digest(boundary)}"`,
      }),
    ),
  );
  for (const [change, expected] of [
    [{ size: bytes.length + 1 }, 'source_changed'],
    [{ sha256: '0'.repeat(64) }, 'source_changed'],
    [{ etag: `"${'0'.repeat(64)}"` }, 'source_changed'],
    [{ etag: `W/"${digest(bytes)}"` }, 'source_changed'],
    [{ bytes: new Uint8Array(25000001), size: 25000001 }, 'input_too_large'],
  ] as const) {
    const before = daemon.calls.length;
    expectFailure(await convert(runtime, input(change)), expected);
    expect(daemon.calls.slice(before).some((call) => call.argv[0] === 'create')).toBe(false);
  }
  const atLimit = await parse(root, 'synthetic.pdf', { pages: 200 });
  expect(atLimit.exitCode).toBe(0);
  const overLimit = await parse(root, 'synthetic.pdf', { pages: 201 });
  expect(overLimit).toMatchObject({ exitCode: 2, frame: { version: 1, error: 'page_limit' } });
  vi.useFakeTimers();
  let started!: () => void;
  const attached = new Promise<void>((done) => {
    started = done;
  });
  daemon.start = ({ options }) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_timeout')), {
        once: true,
      });
      started();
    });
  const from = daemon.calls.length;
  const pending = convert(runtime);
  await attached;
  await vi.advanceTimersByTimeAsync(299999);
  expect(
    daemon.calls.slice(from).filter((call) => call.argv[0] === 'stop' || call.argv[0] === 'kill'),
  ).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expectFailure(await pending, 'timeout');
  expect(daemon.calls.some((call) => call.argv[0] === 'rm')).toBe(true);
  vi.useRealTimers();
  daemon.start = undefined;
  expectSuccess(await convert(runtime));
});

/** @id TEST-DRT-003 @verifies REQ-DRT-003 */
it('TEST-DRT-003 launches fixed immutable hermetic containers and never interpolates names, credentials or arbitrary host paths', async () => {
  const { config } = await fixture();
  vi.stubEnv('HTTPS_PROXY', 'http://PRIVATE_password.invalid');
  vi.stubEnv('DATABASE_URL', 'postgres://PRIVATE_password.invalid');
  vi.stubEnv('DOCKER_HOST', 'tcp://PRIVATE_socket.invalid');
  vi.stubEnv('DOCLING_EXECUTABLE', '/PRIVATE_arbitrary-command');
  const daemon = new DockerDouble();
  const runtime = new DoclingRuntime(config, daemon);
  expectSuccess(await convert(runtime, input({ name: 'a;touch owned-marker.pdf' })));
  const create = daemon.calls.find((call) => call.argv[0] === 'create');
  expect(create).toBeDefined();
  const argv = create!.argv;
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  expect(argv).toContain(imageId);
  expect(flag('--user')).toBe('65532:65532');
  expect(flag('--network')).toBe('none');
  expect(argv).toContain('--read-only');
  expect(flag('--cap-drop')).toBe('ALL');
  expect(flag('--security-opt')).toBe('no-new-privileges');
  expect(flag('--cpus')).toBe('1');
  expect(flag('--memory')).toBe('4096m');
  expect(flag('--memory-swap')).toBe('4096m');
  expect(flag('--pids-limit')).toBe('96');
  const tmpfs = argv.flatMap((item, index) => (item === '--tmpfs' ? [argv[index + 1]!] : []));
  expect(tmpfs).toHaveLength(1);
  expect(tmpfs[0]).toMatch(/^\/tmp:.*size=536870912(?:,|$)/);
  expect(tmpfs[0]).toContain('noexec');
  expect(tmpfs[0]).toContain('nosuid');
  const mounts = argv.flatMap((item, index) => (item === '--mount' ? [argv[index + 1]!] : []));
  expect(mounts.length).toBeGreaterThanOrEqual(2);
  expect(mounts.every((mount) => mount.includes('readonly'))).toBe(true);
  expect(mounts.some((mount) => mount.includes(`src=${config.modelsPath},`))).toBe(true);
  expect(argv.join(' ')).not.toMatch(
    /PRIVATE_|docker\.sock|\/run\/secrets|--privileged|--env-file/,
  );
  expect(argv.some((argument) => ['sh', 'bash', '-c', '-lc'].includes(argument))).toBe(false);
  expect(daemon.calls.every((call) => !['exec', 'run', 'cp'].includes(call.argv[0]!))).toBe(true);
  for (const bad of ['docling:latest', 'sha256:abc', 'registry/image@sha256:' + '8'.repeat(64)]) {
    const other = new DockerDouble();
    expectFailure(
      await outcome(
        new DoclingRuntime({ ...config, imageId: bad }, other).convert(
          input(),
          new AbortController().signal,
        ),
      ),
      'runtime_unavailable',
    );
    expect(other.calls).toHaveLength(0);
  }
});

/** @id TEST-DRT-004 @verifies REQ-DRT-004 */
it('TEST-DRT-004 accepts only bounded canonical v1 IPC, rejects malformed bytes and never exposes private stderr', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { config } = await fixture();
  const daemon = new DockerDouble();
  const runtime = new DoclingRuntime(config, daemon);
  expectSuccess(await convert(runtime));
  const valid = JSON.parse(envelope()) as Record<string, unknown>;
  const invalid = [
    reply('not JSON'),
    reply(JSON.stringify({ ...valid, version: 2 })),
    reply(JSON.stringify({ ...valid, extra: 'PRIVATE_content' })),
    reply(JSON.stringify({ ...valid, markdownBase64: 'Zg' })),
    reply(JSON.stringify({ ...valid, markdownBase64: 'Zh==' })),
    reply(JSON.stringify({ ...valid, markdownBase64: 'Zg==\n' })),
    reply(JSON.stringify({ ...valid, markdownBase64: '/w==' })),
    reply(JSON.stringify({ ...valid, markdownBase64: '' })),
    reply(envelope(markdown, 'not JSON')),
    reply(envelope(markdown, 'null')),
    reply(envelope(markdown, '[]')),
    reply(envelope(markdown, '{}')),
    reply(`{"version":1,"version":1,"markdownBase64":"Zg==","documentJsonBase64":"e30="}`),
    reply(envelope() + '\n' + envelope()),
    reply(envelope(), 2),
    reply(JSON.stringify({ version: 1, error: 'PRIVATE_arbitrary' }), 2),
    reply(
      JSON.stringify({ version: 1, error: 'invalid_document', diagnostic: 'PRIVATE_content' }),
      2,
    ),
    reply(JSON.stringify({ ...valid, error: 'invalid_document' })),
  ];
  for (const frame of invalid) {
    frame.stderr = encoder.encode('PRIVATE_document /home/owner/secret-source Traceback');
    daemon.frames.push(frame);
    expectFailure(await convert(runtime), 'output_invalid');
  }
  for (const key of ['markdownBase64', 'documentJsonBase64']) {
    daemon.frames.push(
      reply(JSON.stringify({ ...valid, [key]: Buffer.alloc(25000001, 65).toString('base64') })),
    );
    expectFailure(await convert(runtime), 'output_too_large');
  }
  const boundaryMarkdown = 'a'.repeat(25000000);
  const boundaryJson = JSON.stringify({ text: 'a'.repeat(25000000 - '{"text":""}'.length) });
  daemon.frames.push(reply(envelope(boundaryMarkdown, boundaryJson)));
  const boundaryOutput = await convert(runtime);
  expect(boundaryOutput.ok).toBe(true);
  if (boundaryOutput.ok) {
    expect(boundaryOutput.value.markdown.length).toBe(25000000);
    expect(boundaryOutput.value.documentJson.length).toBe(25000000);
  }
  daemon.frames.push(reply(envelope(), 0, 'x'.repeat(65536)));
  expectSuccess(await convert(runtime));
  daemon.frames.push(reply(' '.repeat(70000001)));
  expectFailure(await convert(runtime), 'output_too_large');
  daemon.frames.push(reply(envelope(), 0, 'x'.repeat(65537)));
  expectFailure(await convert(runtime), 'output_too_large');
  for (const code of protocol.failureCodes) {
    daemon.frames.push(reply(JSON.stringify({ version: 1, error: code }), 2));
    expectFailure(await convert(runtime), code);
  }
  for (const call of daemon.calls.filter((call) => call.argv[0] === 'start')) {
    expect(call.options.stdoutLimit).toBe(70000000);
    expect(call.options.stderrLimit).toBe(65536);
  }
  expectSuccess(await convert(runtime));
  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toMatch(
    /PRIVATE_|secret-source|Traceback/,
  );
});

/** @id TEST-DRT-005 @verifies REQ-DRT-005 */
it('TEST-DRT-005 confirms exact-owned cleanup before abort settlement and shares one absolute 15s deadline', async () => {
  const { config } = await fixture();
  const daemon = new DockerDouble();
  const runtime = new DoclingRuntime(config, daemon);
  expectSuccess(await convert(runtime));
  for (const reason of ['cancel', 'lost-lease', 'shutdown']) {
    const controller = new AbortController();
    let started!: () => void;
    const attached = new Promise<void>((done) => {
      started = done;
    });
    daemon.start = ({ options }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_aborted')), {
          once: true,
        });
        started();
      });
    let confirmRemoval!: () => void;
    const removal = new Promise<void>((done) => {
      confirmRemoval = done;
    });
    daemon.cleanup = async (call) => {
      if (call.argv[0] === 'rm') await removal;
      return undefined;
    };
    const from = daemon.calls.length;
    const pending = convert(runtime, input(), controller.signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await attached;
    const cancelledAt = Date.now();
    controller.abort(reason);
    await vi.waitFor(() =>
      expect(daemon.calls.slice(from).some((call) => call.argv[0] === 'rm')).toBe(true),
    );
    expect(settled).toBe(false);
    confirmRemoval();
    expectFailure(await pending, 'interrupted');
    const cleanup = daemon.calls
      .slice(from)
      .filter((call) => ['stop', 'kill', 'wait', 'inspect', 'rm'].includes(call.argv[0]!));
    expect(cleanup.some((call) => call.argv[0] === 'stop' || call.argv[0] === 'kill')).toBe(true);
    expect(cleanup.some((call) => call.argv[0] === 'wait' || call.argv[0] === 'inspect')).toBe(
      true,
    );
    expect(cleanup.at(-1)?.argv[0]).toBe('rm');
    expect(new Set(cleanup.map((call) => call.argv.at(-1))).size).toBe(1);
    expect(new Set(cleanup.map((call) => call.options.deadlineMs)).size).toBe(1);
    expect(cleanup[0]!.options.deadlineMs).toBeGreaterThanOrEqual(cancelledAt);
    expect(cleanup[0]!.options.deadlineMs).toBeLessThanOrEqual(cancelledAt + 15000);
  }
  daemon.start = undefined;
  daemon.cleanup = undefined;
  let createdId = '';
  let creationSignal: AbortSignal | undefined;
  let creationStarted!: () => void;
  const creating = new Promise<void>((done) => {
    creationStarted = done;
  });
  const delayed: DockerTransport = {
    async run(argv, options) {
      if (argv[0] === 'inspect' && argv.at(-1)?.startsWith(`${namespace}-`))
        return daemon.run(['inspect', createdId], options);
      const result = await daemon.run(argv, options);
      if (argv[0] !== 'create' || argv.includes('--check')) return result;
      createdId = decoder.decode(result.stdout).trim();
      creationSignal = options.signal;
      creationStarted();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('create interrupted')), {
          once: true,
        });
      });
    },
  };
  const createRuntime = new DoclingRuntime(config, delayed);
  const createController = new AbortController();
  const creatingConversion = convert(createRuntime, input(), createController.signal);
  await creating;
  vi.useFakeTimers();
  try {
    createController.abort();
    expect(creationSignal?.aborted).toBe(true);
  } finally {
    await vi.advanceTimersByTimeAsync(30001);
    await creatingConversion;
    vi.useRealTimers();
  }
  expect(daemon.containers.has(createdId)).toBe(false);
  vi.useFakeTimers();
  daemon.cleanup = async (call) => {
    if (call.argv[0] === 'stop' || call.argv[0] === 'kill') {
      await new Promise((done) =>
        setTimeout(done, Math.min(14000, Math.max(0, call.options.deadlineMs - Date.now()))),
      );
      return reply('', 1, 'PRIVATE_stop_unconfirmed');
    }
    if (call.argv[0] === 'inspect') return reply(JSON.stringify([container(call.argv.at(-1)!)]));
    return reply('', 1, 'PRIVATE_cleanup_unconfirmed');
  };
  const controller = new AbortController();
  let started!: () => void;
  const attached = new Promise<void>((done) => {
    started = done;
  });
  daemon.start = ({ options }) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_aborted')), {
        once: true,
      });
      started();
    });
  const pending = convert(runtime, input(), controller.signal);
  let stoppedWithinBudget = false;
  void pending.then(() => {
    stoppedWithinBudget = true;
  });
  await attached;
  const abortedAt = Date.now();
  controller.abort();
  await vi.advanceTimersByTimeAsync(15001);
  expect(stoppedWithinBudget).toBe(true);
  expectFailure(await pending, 'cancellation_unconfirmed', false);
  const cleanup = daemon.calls.filter(
    (call) =>
      call.at >= abortedAt && ['stop', 'kill', 'wait', 'inspect', 'rm'].includes(call.argv[0]!),
  );
  expect(cleanup.every((call) => call.options.deadlineMs <= abortedAt + 15000)).toBe(true);
  vi.useRealTimers();
  expectSuccess(await convert(new DoclingRuntime(config, new DockerDouble())));
});

/** @id TEST-DRT-006 @verifies REQ-DRT-006 */
it('TEST-DRT-006 validates exact assets and reconciles only proven namespace/job/fence orphans without killing current claims', async () => {
  const { root, config } = await fixture();
  const daemon = new DockerDouble();
  expect(await outcome(new DoclingRuntime(config, daemon).ready())).toEqual({
    ok: true,
    value: undefined,
  });
  const inspect = daemon.calls.find((call) => call.argv[0] === 'image');
  expect(inspect?.argv).toContain(imageId);
  expect(
    daemon.calls.some((call) => call.argv[0] === 'create' && call.argv.includes('--check')),
  ).toBe(true);
  for (const badNamespace of [
    '',
    '../worker',
    'bad value',
    'a'.repeat(65),
    'worker\n--privileged',
  ]) {
    const isolated = new DockerDouble();
    expect(
      await outcome(new DoclingRuntime({ ...config, namespace: badNamespace }, isolated).ready()),
    ).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(isolated.calls).toHaveLength(0);
  }
  for (const manifest of [
    { 'ocr/model.bin': '0'.repeat(64) },
    { '../outside.bin': digest('outside') },
    { '/etc/passwd': digest('outside') },
    { 'ocr/model.bin': digest('synthetic-model').toUpperCase() },
    {},
    { 'missing.bin': digest('synthetic-model') },
  ]) {
    await writeFile(config.modelManifestPath, JSON.stringify(manifest));
    expect(await outcome(new DoclingRuntime(config, new DockerDouble()).ready())).toMatchObject({
      ok: false,
      code: 'runtime_unavailable',
    });
  }
  await writeFile(
    config.modelManifestPath,
    JSON.stringify({ 'ocr/model.bin': digest('synthetic-model') }),
  );
  await writeFile(resolve(config.modelsPath, 'unlisted.bin'), 'PRIVATE_unlisted');
  expect(await outcome(new DoclingRuntime(config, new DockerDouble()).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  await rm(resolve(config.modelsPath, 'unlisted.bin'));
  await rm(resolve(config.modelsPath, 'ocr/model.bin'));
  await writeFile(resolve(root, 'outside.bin'), 'synthetic-model');
  await symlink(resolve(root, 'outside.bin'), resolve(config.modelsPath, 'ocr/model.bin'));
  expect(await outcome(new DoclingRuntime(config, new DockerDouble()).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  await rm(resolve(config.modelsPath, 'ocr/model.bin'));
  await writeFile(resolve(config.modelsPath, 'ocr/model.bin'), 'synthetic-model');
  const wrongPin = new DockerDouble();
  wrongPin.probe.doclingVersion = '2.149.0';
  expect(await outcome(new DoclingRuntime(config, wrongPin).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  const wrongDistribution = new DockerDouble();
  wrongDistribution.probe.doclingDistribution = 'docling';
  expect(await outcome(new DoclingRuntime(config, wrongDistribution).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  const wrongImage = new DockerDouble();
  wrongImage.inspectedImageId = `sha256:${'0'.repeat(64)}`;
  expect(await outcome(new DoclingRuntime(config, wrongImage).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  const offline = new DockerDouble();
  offline.run = async () => {
    throw new Error('PRIVATE_docker_socket /home/owner');
  };
  expect(await outcome(new DoclingRuntime(config, offline).ready())).toMatchObject({
    ok: false,
    code: 'runtime_unavailable',
  });
  const orphans = new DockerDouble();
  const staleId = containerId(101);
  const currentId = containerId(102);
  const foreignNamespaceId = containerId(103);
  const foreignConverterId = containerId(104);
  const unlabelledId = containerId(105);
  const missingJobId = containerId(106);
  const missingFenceId = containerId(107);
  orphans.containers.set(staleId, container(staleId));
  orphans.containers.set(
    currentId,
    container(currentId, { 'aira.conversion.fence': 'current-fence' }),
  );
  orphans.containers.set(
    foreignNamespaceId,
    container(foreignNamespaceId, { 'aira.conversion.namespace': 'other-worker' }),
  );
  orphans.containers.set(
    foreignConverterId,
    container(foreignConverterId, { 'aira.conversion.converter': 'other' }),
  );
  const unlabelled = container(unlabelledId);
  unlabelled.Config.Labels = {};
  orphans.containers.set(unlabelledId, unlabelled);
  for (const [key, id] of [
    ['aira.conversion.job', missingJobId],
    ['aira.conversion.fence', missingFenceId],
  ] as const) {
    const missing = container(id);
    delete missing.Config.Labels[key];
    orphans.containers.set(missing.Id, missing);
  }
  orphans.discoveryIds = [...orphans.containers.keys()];
  const isCurrentClaim = vi.fn(async (_job: string, token: string) => token === 'current-fence');
  expect(await outcome(new DoclingRuntime(config, orphans).ready(isCurrentClaim))).toEqual({
    ok: true,
    value: undefined,
  });
  expect(isCurrentClaim).toHaveBeenCalledWith(jobId, fence);
  expect(isCurrentClaim).toHaveBeenCalledWith(jobId, 'current-fence');
  expect(orphans.containers.has(staleId)).toBe(false);
  for (const id of [
    currentId,
    foreignNamespaceId,
    foreignConverterId,
    unlabelledId,
    missingJobId,
    missingFenceId,
  ]) {
    expect(orphans.containers.has(id)).toBe(true);
    expect(
      orphans.calls.some(
        (call) => ['stop', 'kill', 'rm'].includes(call.argv[0]!) && call.argv.at(-1) === id,
      ),
    ).toBe(false);
  }
  const unresolvedClaim = new DockerDouble();
  unresolvedClaim.containers.set(staleId, container(staleId));
  unresolvedClaim.discoveryIds = [staleId];
  expect(
    await outcome(
      new DoclingRuntime(config, unresolvedClaim).ready(async () => {
        throw new Error('PRIVATE_claim_lookup');
      }),
    ),
  ).toMatchObject({ ok: false, code: 'runtime_unavailable' });
  expect(
    unresolvedClaim.calls.some(
      (call) => ['stop', 'kill', 'rm'].includes(call.argv[0]!) && call.argv.at(-1) === staleId,
    ),
  ).toBe(false);
  const blocked = new DockerDouble();
  const blockedId = containerId(108);
  blocked.containers.set(blockedId, container(blockedId));
  blocked.discoveryIds = [blockedId];
  blocked.cleanup = async (call) =>
    call.argv.at(-1) === blockedId ? reply('', 1, 'PRIVATE_cleanup_failed') : undefined;
  expect(await outcome(new DoclingRuntime(config, blocked).ready(async () => false))).toMatchObject(
    { ok: false, code: 'cancellation_unconfirmed', settled: false },
  );
  expect(await outcome(new DoclingRuntime(config, new DockerDouble()).ready())).toEqual({
    ok: true,
    value: undefined,
  });
});
