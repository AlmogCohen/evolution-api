// Everything the process prints while `fn` runs: console.* and raw stdout/stderr.
export async function captureOutput(fn: () => Promise<void>) {
  const out: string[] = [];
  const fmt = (args: any[]) => args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' ');
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = names.map((n) => console[n]);
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  names.forEach((n) => (console[n] = (...a: any[]) => void out.push(fmt(a))));
  (process.stdout as any).write = (c: any) => (out.push(String(c)), true);
  (process.stderr as any).write = (c: any) => (out.push(String(c)), true);
  try {
    await fn();
  } finally {
    names.forEach((n, i) => (console[n] = saved[i]));
    (process.stdout as any).write = stdout;
    (process.stderr as any).write = stderr;
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
