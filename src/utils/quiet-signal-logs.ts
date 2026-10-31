import { configService, Log, LogLevel } from '@config/env.config';

// libsignal (which Baileys encrypts with) prints whole SessionEntry objects
// with console.info and console.warn when a session closes, opens or is
// dropped: "Closing session:", "Opening session:", "Removing old closed
// session:", "Session already closed". Node prints them in full, private
// ratchet key, root key, chain keys and the contact's identity key among them.
// They bypass Evolution's logger, so LOG_LEVEL never saw them, and on a busy
// account they reached stdout every few seconds.
//
// A console call that carries a session prints the line without it, and only
// when LOG_LEVEL has the call's level (console.info is INFO). Every other call,
// Evolution's own logger included, goes through untouched.

const LEVELS = { log: 'LOG', info: 'INFO', debug: 'DEBUG', warn: 'WARN', error: 'ERROR' } as const;
const QUIET = Symbol.for('evolution.quietSignalSessionLogs');

/** A libsignal SessionEntry, whichever copy of libsignal made it. */
function isSignalSession(value: unknown) {
  return typeof value === 'object' && value !== null && '_chains' in value && 'indexInfo' in value;
}

export function quietSignalSessionLogs(levels: LogLevel[] = configService.get<Log>('LOG').LEVEL) {
  for (const [method, level] of Object.entries(LEVELS) as [keyof typeof LEVELS, LogLevel][]) {
    const print = console[method];
    if ((print as any)[QUIET]) continue;
    const quiet = (...args: any[]) => {
      if (!args.some(isSignalSession)) return print(...args);
      if (!levels.includes(level)) return;
      print(...args.map((a) => (isSignalSession(a) ? '[signal session]' : a)));
    };
    (quiet as any)[QUIET] = true;
    console[method] = quiet;
  }
}
