import axios, { AxiosRequestConfig } from 'axios';
import { fetchLatestBaileysVersion, WAVersion } from 'baileys';

/**
 * `options` go to the sw.js request (axios); `fallbackOptions` to Baileys'
 * fallback fetch, which takes only an undici `dispatcher` for a proxy.
 */
export const fetchLatestWaWebVersion = async (options: AxiosRequestConfig<{}>, fallbackOptions: RequestInit = {}) => {
  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      ...options,
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
    return {
      version: (await fetchLatestBaileysVersion(fallbackOptions)).version as WAVersion,
      isLatest: false,
      error,
    };
  }
};
