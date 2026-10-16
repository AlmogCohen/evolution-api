import axios, { AxiosRequestConfig } from 'axios';
import { DEFAULT_CONNECTION_CONFIG, fetchLatestBaileysVersion, WAVersion } from 'baileys';

// Every connect waits on this. An exit that accepts the connection and never answers would
// otherwise hold the connect (and every reconnect) forever: axios' default timeout is none.
export const WA_VERSION_FETCH_TIMEOUT_MS = 10_000;

type VersionResult = { version: WAVersion; isLatest: boolean; error?: unknown };

/**
 * `options` go to the sw.js request (axios); `fallbackOptions` to Baileys'
 * fallback fetch, which takes only an undici `dispatcher` for a proxy.
 * Past `timeoutMs` the answer is the version this Baileys ships with.
 */
export const fetchLatestWaWebVersion = async (
  options: AxiosRequestConfig<{}>,
  fallbackOptions: RequestInit = {},
  timeoutMs = WA_VERSION_FETCH_TIMEOUT_MS,
): Promise<VersionResult> => {
  const abort = new AbortController();
  let timer: NodeJS.Timeout;
  const deadline = new Promise<VersionResult>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve({
        version: DEFAULT_CONNECTION_CONFIG.version,
        isLatest: false,
        error: { message: `WhatsApp Web version fetch timed out after ${timeoutMs} ms` },
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchVersion(options, fallbackOptions, abort.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const fetchVersion = async (
  options: AxiosRequestConfig<{}>,
  fallbackOptions: RequestInit,
  signal: AbortSignal,
): Promise<VersionResult> => {
  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      ...options,
      signal,
      responseType: 'json',
    });

    const regex = /\\?"client_revision\\?":\s*(\d+)/;
    const match = data.match(regex);

    if (!match?.[1]) {
      return {
        version: (await fetchLatestBaileysVersion(fallbackOptions)).version as WAVersion,
        isLatest: false,
        error: {
          message: 'Could not find client revision in the fetched content',
        },
      };
    }

    const clientRevision = match[1];

    return {
      version: [2, 3000, +clientRevision] as WAVersion,
      isLatest: true,
    };
  } catch (error) {
    // Timed out: the deadline has already answered, so do not start the fallback.
    if (signal.aborted) return { version: DEFAULT_CONNECTION_CONFIG.version, isLatest: false, error };
    return {
      version: (await fetchLatestBaileysVersion(fallbackOptions)).version as WAVersion,
      isLatest: false,
      error,
    };
  }
};
