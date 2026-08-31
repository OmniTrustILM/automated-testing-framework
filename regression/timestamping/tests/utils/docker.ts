import { execFileSync } from 'child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function docker(args: string[]): CommandResult {
  try {
    const stdout = execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error), exitCode: failure.status ?? 1 };
  }
}

/** Health status when the container declares a healthcheck, otherwise its running state. */
export function containerState(name: string): string {
  const result = docker([
    'inspect',
    '-f',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    name,
  ]);
  return result.exitCode === 0 ? result.stdout.trim() : 'missing';
}

export function containerImageId(name: string): string {
  const result = docker(['inspect', '-f', '{{.Image}}', name]);
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

export function stopContainer(name: string): void {
  docker(['stop', name]);
}

export function startContainer(name: string): void {
  docker(['start', name]);
}

export interface QueueInfo {
  name: string;
  messages: number;
  consumers: number;
}

/** Queue depth and consumer count straight from RabbitMQ, the only reliable signal that
 *  Core actually subscribed to the time-quality exchange. */
export function listQueues(filter?: RegExp): QueueInfo[] {
  const result = docker(['exec', 'rabbitmq', 'rabbitmqctl', 'list_queues', 'name', 'messages', 'consumers']);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]))
    .map((parts) => ({ name: parts[0], messages: Number(parts[1]), consumers: Number(parts[2]) }))
    .filter((queue) => !filter || filter.test(queue.name));
}

export async function waitForContainerState(
  name: string,
  expected: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = containerState(name);
  while (Date.now() < deadline && !expected.includes(state)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state = containerState(name);
  }
  return state;
}

export async function waitFor<T>(
  probe: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (Date.now() < deadline && !accept(value)) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await probe();
  }
  return value;
}
