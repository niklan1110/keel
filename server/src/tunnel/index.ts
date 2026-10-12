import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../lib/config.js';
import { log } from '../lib/log.js';

/**
 * keel-tunnel: runs Cloudflare's tunnel client (cloudflared) once a tunnel
 * token has been saved in Studio, and reports how it's doing. The container
 * only joins the keel-public network, so the tunnel can reach the gateway and
 * Studio and nothing else on the machine.
 *
 * Studio and this service share one folder (KEEL_TUNNEL_DIR):
 *   token        the tunnel token, written by Studio (readable by its owner only)
 *   status.json  written here: state, connections, last error, recent log lines
 */

export type TunnelState = 'off' | 'starting' | 'connected' | 'error';
export type TunnelStatus = {
  state: TunnelState;
  connections: number;
  error: string | null;
  tunnelId: string | null;
  log: string[];
  updatedAt: string;
};

/** The tunnel's ID, from the token (base64 JSON with a, t and s). */
export function tunnelIdOf(token: string): string | null {
  try {
    const j = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    return typeof j.t === 'string' ? j.t : null;
  } catch {
    return null;
  }
}

/** cloudflared's log line without its timestamp, e.g. "INF Registered tunnel connection ...". */
const tidy = (line: string) => line.replace(/^\S+T\S+Z\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 300);

export async function main(): Promise<void> {
  const dir = config.tunnel.dir;
  const tokenFile = path.join(dir, 'token');
  const statusFile = path.join(dir, 'status.json');

  const status: TunnelStatus = { state: 'off', connections: 0, error: null, tunnelId: null, log: [], updatedAt: '' };
  let child: ChildProcess | null = null;
  let token = '';
  let restarts = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  const write = async () => {
    status.updatedAt = new Date().toISOString();
    try {
      await fs.writeFile(`${statusFile}.tmp`, JSON.stringify(status));
      await fs.rename(`${statusFile}.tmp`, statusFile);
    } catch (err) {
      log.debug('could not write tunnel status', { error: (err as Error).message });
    }
  };

  const remember = (line: string) => {
    const t = tidy(line).replaceAll(token, '<token>');
    if (!t) return;
    status.log = [...status.log.slice(-29), t];
    if (/Registered tunnel connection/i.test(t)) {
      status.connections++;
      status.state = 'connected';
      status.error = null;
      restarts = 0;
    } else if (/Unregistered tunnel connection|Connection terminated|Lost connection/i.test(t)) {
      status.connections = Math.max(0, status.connections - 1);
      if (!status.connections) status.state = 'starting';
    } else if (/^ERR\b|not valid|Unauthorized|failed to/i.test(t) && !status.connections) {
      status.state = 'error';
      status.error = t.replace(/^ERR\s+/, '');
    }
    void write();
  };

  const stop = () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const c = child;
    child = null;
    if (c && c.exitCode === null) c.kill('SIGTERM');
  };

  const start = () => {
    status.state = 'starting';
    status.connections = 0;
    status.tunnelId = tunnelIdOf(token);
    void write();
    const c = spawn(config.tunnel.bin, ['tunnel', '--no-autoupdate', 'run'], {
      env: { PATH: process.env.PATH, HOME: '/tmp', TUNNEL_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    for (const stream of [c.stdout, c.stderr]) readline.createInterface({ input: stream! }).on('line', remember);
    c.on('error', (err) => remember(`ERR ${err.message}`));
    c.on('exit', (code) => {
      if (child !== c) return; // stopped on purpose
      child = null;
      status.connections = 0;
      status.state = 'error';
      status.error = status.error || `The tunnel client stopped (exit code ${code})`;
      void write();
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(restarts++, 5));
      restartTimer = setTimeout(() => {
        if (token) start();
      }, delay);
    });
    log.info('tunnel starting', { tunnel: status.tunnelId });
  };

  const check = async () => {
    const next = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim();
    if (next === token) return;
    stop();
    token = next;
    status.log = [];
    status.error = null;
    restarts = 0;
    if (token) start();
    else {
      status.state = 'off';
      status.connections = 0;
      status.tunnelId = null;
      log.info('tunnel off');
      await write();
    }
  };

  log.info('keel-tunnel ready; waiting for a token from Studio', { dir });
  await check();
  await write();
  setInterval(() => void check().catch(() => {}), 2000);
  // A heartbeat, so Studio can tell this service is running.
  setInterval(() => void write(), 10_000);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stop());
}
