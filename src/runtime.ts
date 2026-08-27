import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ResolvedScreenReaderOptions, RuntimeEndpoints } from './types.js';

const MAX_COMMAND_OUTPUT = 64 * 1024;

export class ScreenReaderRuntime {
  readonly endpoints: RuntimeEndpoints;
  readonly engine: 'docker' | 'podman' | 'external';
  readonly containerName: string | undefined;

  private readonly keepContainer: boolean;
  private stopped = false;

  private constructor(
    endpoints: RuntimeEndpoints,
    engine: 'docker' | 'podman' | 'external',
    containerName: string | undefined,
    keepContainer: boolean,
  ) {
    this.endpoints = endpoints;
    this.engine = engine;
    this.containerName = containerName;
    this.keepContainer = keepContainer;
  }

  static async start(
    options: ResolvedScreenReaderOptions,
    workerIndex: number,
  ): Promise<ScreenReaderRuntime> {
    if (options.runtime === 'external') {
      const runtime = new ScreenReaderRuntime(
        {
          controlEndpoint: requireValue(options.controlEndpoint, 'controlEndpoint'),
          cdpEndpoint: requireValue(options.cdpEndpoint, 'cdpEndpoint'),
          controlToken: requireValue(options.controlToken, 'controlToken'),
        },
        'external',
        undefined,
        true,
      );
      await waitUntilReady(runtime.endpoints, options.startupTimeoutMs, options.screenReader);
      return runtime;
    }

    const engine = await resolveEngine(options.runtime);
    const [controlPort, cdpPort] = await reserveTwoPorts();
    const token = randomBytes(32).toString('base64url');
    const suffix = randomBytes(5).toString('hex');
    const containerName = `hoosaidthat-${options.screenReader}-w${workerIndex}-${suffix}`;
    const endpoints: RuntimeEndpoints = {
      controlEndpoint: `http://127.0.0.1:${controlPort}`,
      cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
      controlToken: token,
    };
    const args = buildContainerArguments(options, {
      containerName,
      token,
      controlPort,
      cdpPort,
    });
    const launch = await runCommand(engine, args, 30_000);
    if (launch.code !== 0) {
      throw new Error(
        `failed to start ${options.screenReader} container with ${engine}: ${launch.stderr || launch.stdout}`,
      );
    }
    const runtime = new ScreenReaderRuntime(
      endpoints,
      engine,
      containerName,
      options.keepContainer,
    );
    try {
      await waitUntilReady(endpoints, options.startupTimeoutMs, options.screenReader);
      return runtime;
    } catch (error) {
      const logs = await runCommand(
        engine,
        ['logs', '--tail', '100', containerName],
        5_000,
      );
      let cleanupFailure = '';
      try {
        await runtime.stop();
      } catch (cleanupError) {
        cleanupFailure = `\nContainer cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`;
      }
      const detail = (logs.stdout || logs.stderr).trim();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          detail ? `\nContainer log tail:\n${detail}` : ''
        }${cleanupFailure}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped || this.engine === 'external' || !this.containerName) {
      this.stopped = true;
      return;
    }
    this.stopped = true;
    let stopFailure = '';
    try {
      const stop = await runCommand(
        this.engine,
        ['stop', '--time', '5', this.containerName],
        10_000,
      );
      if (stop.code !== 0) stopFailure = stop.stderr || stop.stdout;
    } catch (error) {
      stopFailure = error instanceof Error ? error.message : String(error);
    }
    if (!this.keepContainer) {
      const remove = await runCommand(
        this.engine,
        ['rm', '--force', this.containerName],
        5_000,
      );
      if (remove.code !== 0) {
        throw new Error(
          `failed to remove screen-reader container ${this.containerName}: ${
            remove.stderr || remove.stdout
          }${stopFailure ? `\nContainer stop also failed: ${stopFailure}` : ''}`,
        );
      }
    } else if (stopFailure) {
      throw new Error(
        `failed to stop screen-reader container ${this.containerName}: ${stopFailure}`,
      );
    }
  }
}

export function buildContainerArguments(
  options: ResolvedScreenReaderOptions,
  runtime: {
    containerName: string;
    token: string;
    controlPort: number;
    cdpPort: number;
  },
): string[] {
  return [
    'run',
    '--detach',
    '--name',
    runtime.containerName,
    '--label',
    'dev.hoosaidthat.managed=true',
    '--platform',
    'linux/amd64',
    '--env',
    `HST_CONTROL_TOKEN=${runtime.token}`,
    '--shm-size=1g',
    '--network=host',
    '--env',
    `HST_CONTROL_PORT=${runtime.controlPort}`,
    '--env',
    `HST_CDP_PORT=${runtime.cdpPort}`,
    '--env',
    `HST_DISPLAY_NUMBER=${runtime.controlPort}`,
    '--env',
    `HST_VIEWPORT_WIDTH=${options.viewport.width}`,
    '--env',
    `HST_VIEWPORT_HEIGHT=${options.viewport.height}`,
    '--env',
    `HOOVDA_PROFILE=${options.profile}`,
    '--env',
    `HOOVDA_LOCALE=${options.locale}`,
    '--env',
    `HOOVDA_KEYBOARD_LAYOUT=${options.keyboardLayout}`,
    '--env',
    `HOOVDA_ACTION_TIMEOUT=${options.actionTimeoutMs}ms`,
    ...options.containerEngineArgs,
    options.image,
  ];
}

async function resolveEngine(
  requested: ResolvedScreenReaderOptions['runtime'],
): Promise<'docker' | 'podman'> {
  if (requested === 'docker' || requested === 'podman') {
    if (!(await commandWorks(requested))) {
      throw new Error(`${requested} is not available`);
    }
    return requested;
  }
  for (const candidate of ['docker', 'podman'] as const) {
    if (await commandWorks(candidate)) {
      return candidate;
    }
  }
  throw new Error('no Docker-compatible runtime found; install Docker or Podman');
}

async function commandWorks(command: 'docker' | 'podman'): Promise<boolean> {
  try {
    return (await runCommand(command, ['version'], 5_000)).code === 0;
  } catch {
    return false;
  }
}

async function waitUntilReady(
  endpoints: RuntimeEndpoints,
  timeoutMs: number,
  screenReader: ResolvedScreenReaderOptions['screenReader'],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'runtime did not respond';
  while (Date.now() < deadline) {
    try {
      const [control, cdp] = await Promise.all([
        fetch(`${endpoints.controlEndpoint}/${screenReader === 'hoovda' ? 'v2' : 'v1'}/health`, {
          headers: { authorization: `Bearer ${endpoints.controlToken}` },
          signal: AbortSignal.timeout(1_000),
        }),
        fetch(`${endpoints.cdpEndpoint}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        }),
      ]);
      const [controlBody, cdpBody] = await Promise.all([control.text(), cdp.text()]);
      if (control.ok && cdp.ok) {
        const controlValue: unknown = JSON.parse(controlBody);
        const cdpValue: unknown = JSON.parse(cdpBody);
        if (
          isObject(controlValue) &&
          ((screenReader === 'orca' &&
            controlValue.protocolVersion === 1 &&
            controlValue.status === 'ready') ||
            (screenReader === 'hoovda' &&
              controlValue.protocolVersion === '2.0' &&
              controlValue.status === 'ok' &&
              controlValue.ready === true)) &&
          isObject(cdpValue) &&
          typeof cdpValue.webSocketDebuggerUrl === 'string' &&
          cdpValue.webSocketDebuggerUrl.length > 0
        ) {
          return;
        }
        lastError = 'runtime readiness payload was invalid';
      } else {
        lastError = `control=${control.status} ${boundedBody(controlBody)}, cdp=${cdp.status} ${boundedBody(cdpBody)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(
    `screen-reader runtime did not become ready within ${timeoutMs}ms: ${lastError}`,
  );
}

function boundedBody(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 1_000 ? `${normalized.slice(0, 1_000)}...` : normalized;
}

async function reserveTwoPorts(): Promise<[number, number]> {
  const first = await reservePort();
  let second = await reservePort();
  while (second === first) {
    second = await reservePort();
  }
  return [first, second];
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve a TCP port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function boundedAppend(previous: string, chunk: string): string {
  const value = previous + chunk;
  return value.length <= MAX_COMMAND_OUTPUT
    ? value
    : value.slice(value.length - MAX_COMMAND_OUTPUT);
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
