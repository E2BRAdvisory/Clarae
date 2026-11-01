import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect } from '@playwright/test';

// A headless desktop device (apps/desktop/cmd/e2e-device): the real desktop core, driven over the
// loopback HTTP API the binary prints on start. Its bindings are the ones Wails exposes, so a spec
// calls them exactly as the desktop UI does.

export interface VaultInfo {
  id: string;
  name: string;
  path: string;
}

export interface SyncStatus {
  phase: string;
  pending: number;
  conflicts: number;
  error: string;
}

export class Device {
  private constructor(
    readonly user: string,
    readonly dataDir: string,
    private readonly base: string,
    private readonly proc: ChildProcess,
  ) {}

  /** Starts a device signed in as `user` (password grant of the throwaway realm). */
  static async start(user: string, label = user): Promise<Device> {
    const bin = process.env['MEMOBRAIN_E2E_DEVICE'];
    if (!bin)
      throw new Error('MEMOBRAIN_E2E_DEVICE is not set: run the suite with scripts/e2e-mixed.sh');
    const root = process.env['MEMOBRAIN_E2E_DEVICE_DATA'] ?? tmpdir();
    mkdirSync(root, { recursive: true });
    const dataDir = mkdtempSync(join(root, `${label}-`));
    const server = process.env['MEMOBRAIN_CLOUD_URL'] ?? 'http://localhost:18091';
    const args = ['-server', server, '-user', user, '-data', dataDir];
    if (process.env['MEMOBRAIN_E2E_DEVICE_VERBOSE']) args.push('-v');
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const base = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: proc.stdout });
      const timer = setTimeout(
        () => reject(new Error(`${label}: the device did not start`)),
        60_000,
      );
      lines.on('line', (line) => {
        const m = /^LISTEN (\S+)/.exec(line);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.on('exit', (code) => reject(new Error(`${label}: the device exited (${code})`)));
    });
    const d = new Device(user, dataDir, base, proc);
    await expect
      .poll(async () => (await d.call<{ status: string }>('AuthAPI', 'Status')).status, {
        timeout: 60_000,
        message: `${label} signs in`,
      })
      .toBe('ready');
    return d;
  }

  /** Calls a binding (`service.method(...args)`), rejecting with the binding's error. */
  async call<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`${this.base}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, method, args }),
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (body.error !== undefined) throw new Error(`${service}.${method}: ${body.error}`);
    return body.result as T;
  }

  /** The events the core emitted so far. */
  async events(): Promise<{ name: string; payload: unknown }[]> {
    return (await fetch(`${this.base}/events`)).json() as never;
  }

  /** Opens (creating it) a folder of this device as a vault. */
  async openFolder(name: string): Promise<VaultInfo> {
    const dir = join(this.dataDir, 'vaults', name);
    mkdirSync(dir, { recursive: true });
    return this.call<VaultInfo>('VaultAPI', 'OpenVault', dir);
  }

  /** A file of a vault on disk ('' when missing). */
  async read(vaultId: string, path: string): Promise<string> {
    const res = await fetch(`${this.base}/file?vault=${vaultId}&path=${encodeURIComponent(path)}`);
    return res.ok ? res.text() : '';
  }

  /** Writes a file on disk, as an editor outside the app would. */
  async write(vaultId: string, path: string, content: string): Promise<void> {
    const res = await fetch(`${this.base}/file?vault=${vaultId}&path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: content,
    });
    if (!res.ok) throw new Error(`write ${path}: ${await res.text()}`);
  }

  /** The files of a vault folder. */
  async files(vaultId: string): Promise<string[]> {
    return (await fetch(`${this.base}/files?vault=${vaultId}`)).json() as never;
  }

  /**
   * Asks for a sync and waits until nothing is pending and the engine is idle. The sync is asked
   * again only every few seconds: asking on every poll would keep the engine busy.
   */
  async settle(vaultId: string, timeout = 90_000): Promise<void> {
    let asked = 0;
    let last: SyncStatus | undefined;
    await expect
      .poll(
        async () => {
          if (Date.now() - asked > 5_000) {
            asked = Date.now();
            await this.call('SyncAPI', 'SyncNow', vaultId).catch(() => undefined);
          }
          last = await this.call<SyncStatus>('SyncAPI', 'Status', vaultId);
          return last.pending === 0 && last.phase === 'idle';
        },
        {
          timeout,
          intervals: [500, 1000],
          message: `${this.user}: sync settles (last status ${JSON.stringify(last)})`,
        },
      )
      .toBe(true);
  }

  async stop(): Promise<void> {
    await fetch(`${this.base}/quit`, { method: 'POST' }).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 10_000);
      this.proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
