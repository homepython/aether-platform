import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';

export class NativeDesktopHelperClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pcmSocket: net.Socket | null = null;
  private pending = new Map<
    string,
    { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private pcmRemainder = Buffer.alloc(0);

  private resolveBinaryPath(): string | null {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'aether-native-helper.exe'),
      path.resolve(__dirname, '../resources/bin/aether-native-helper.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  public start(): void {
    if (process.platform !== 'win32') return;
    const binPath = this.resolveBinaryPath();
    if (!binPath) {
      console.warn('[NativeHelper] Binário aether-native-helper.exe não encontrado');
      return;
    }

    this.proc = spawn(binPath, ['--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === 'ready' && typeof msg.pcmPort === 'number') {
          this.connectPcmSocket(msg.pcmPort);
        } else if (msg.type === 'res' && typeof msg.reqId === 'string') {
          const entry = this.pending.get(msg.reqId);
          if (entry) {
            this.pending.delete(msg.reqId);
            entry.resolve(msg);
          }
        } else if (msg.type === 'ptt') {
          this.emit('ptt', Boolean(msg.pressed));
        } else if (msg.type === 'shortcut' && typeof msg.action === 'string') {
          this.emit('shortcut', msg.action);
        }
      } catch {
        // Ignore malformed line
      }
    });

    this.proc.on('exit', () => {
      this.proc = null;
      this.pcmSocket?.destroy();
      this.pcmSocket = null;
    });
  }

  private connectPcmSocket(port: number): void {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.setNoDelay(true);
    });
    this.pcmSocket = sock;

    sock.on('data', (chunk: Buffer) => {
      let buf = this.pcmRemainder.length > 0 ? Buffer.concat([this.pcmRemainder, chunk]) : chunk;
      let offset = 0;

      while (buf.length - offset >= 4) {
        const byteLen = buf.readInt32LE(offset);
        if (byteLen <= 0 || byteLen > 1024 * 1024) {
          offset = buf.length;
          break;
        }
        if (buf.length - offset - 4 < byteLen) {
          break;
        }
        const pcmSlice = buf.subarray(offset + 4, offset + 4 + byteLen);
        const alignedCopy = new Uint8Array(byteLen);
        alignedCopy.set(pcmSlice);
        this.emit('pcm', alignedCopy.buffer);
        offset += 4 + byteLen;
      }

      this.pcmRemainder = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
    });

    sock.on('error', () => {});
  }

  public async sendCommand(
    cmd: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<Record<string, unknown>> {
    if (!this.proc || !this.proc.stdin.writable) {
      return { ok: false, error: 'Helper nativo inativo' };
    }
    const reqId = crypto.randomUUID();
    const packet = JSON.stringify({ cmd, reqId, ...payload }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ ok: false, error: 'Timeout no helper nativo' });
      }, timeoutMs);

      this.pending.set(reqId, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc!.stdin.write(packet);
    });
  }

  public stop(): void {
    try {
      this.pcmSocket?.destroy();
      this.proc?.kill();
    } catch {
      // Ignore
    }
    this.pcmSocket = null;
    this.proc = null;
  }
}

export const nativeHelper = new NativeDesktopHelperClient();

app.on('will-quit', () => {
  nativeHelper.stop();
});

