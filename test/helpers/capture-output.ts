// Everything the process prints while `fn` runs: console.* and raw
// stdout/stderr, including direct writes to file descriptors 1 and 2 (pino,
// which Baileys logs through, writes to the fd with sonic-boom and never
// touches process.stdout).
import fs from 'node:fs';

export async function captureOutput(fn: () => Promise<void>) {
  const out: string[] = [];
  const fmt = (args: any[]) => args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' ');
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = names.map((n) => console[n]);
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const fsWrite = fs.write;
  const fsWriteSync = fs.writeSync;
  const isStd = (fd: any) => fd === 1 || fd === 2;
  names.forEach((n) => (console[n] = (...a: any[]) => void out.push(fmt(a))));
  (process.stdout as any).write = (c: any) => (out.push(String(c)), true);
  (process.stderr as any).write = (c: any) => (out.push(String(c)), true);
  (fs as any).writeSync = (fd: any, data: any, ...rest: any[]) => {
    if (!isStd(fd)) return (fsWriteSync as any)(fd, data, ...rest);
    out.push(String(data));
    return typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  };
  (fs as any).write = (fd: any, data: any, ...rest: any[]) => {
    if (!isStd(fd)) return (fsWrite as any)(fd, data, ...rest);
    out.push(String(data));
    const cb = rest.find((r) => typeof r === 'function');
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    if (cb) process.nextTick(cb, null, n, data);
  };
  try {
    await fn();
  } finally {
    names.forEach((n, i) => (console[n] = saved[i]));
    (process.stdout as any).write = stdout;
    (process.stderr as any).write = stderr;
    (fs as any).write = fsWrite;
    (fs as any).writeSync = fsWriteSync;
  }
  return out.join('\n');
}

function safe(v: any) {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
  } catch {
    return String(v);
  }
}
