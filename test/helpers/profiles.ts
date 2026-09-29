// Configuration profiles. Evolution's behaviour branches on these flags, so a
// test that only ever runs with storage on says nothing about a deployment
// that has it off, and the reverse.
//
// `minimal` is a production configuration that keeps its own data outside
// Evolution: only the instance is stored, local cache, no Redis, no S3, WARN and above.
// `stored` turns on everything Evolution can store, as a default install does.
export const PROFILES = {
  minimal: {
    DATABASE_SAVE_DATA_INSTANCE: 'true',
    DATABASE_SAVE_DATA_NEW_MESSAGE: 'false',
    DATABASE_SAVE_MESSAGE_UPDATE: 'false',
    DATABASE_SAVE_DATA_CONTACTS: 'false',
    DATABASE_SAVE_DATA_CHATS: 'false',
    DATABASE_SAVE_DATA_LABELS: 'false',
    DATABASE_SAVE_DATA_HISTORIC: 'false',
    DATABASE_SAVE_IS_ON_WHATSAPP: 'false',
    DATABASE_DELETE_MESSAGE: 'true',
    CACHE_REDIS_ENABLED: 'false',
    CACHE_LOCAL_ENABLED: 'true',
    S3_ENABLED: 'false',
    LOG_LEVEL: 'ERROR,WARN',
    LOG_BAILEYS: 'error',
  },
  stored: {
    DATABASE_SAVE_DATA_INSTANCE: 'true',
    DATABASE_SAVE_DATA_NEW_MESSAGE: 'true',
    DATABASE_SAVE_MESSAGE_UPDATE: 'true',
    DATABASE_SAVE_DATA_CONTACTS: 'true',
    DATABASE_SAVE_DATA_CHATS: 'true',
    DATABASE_SAVE_DATA_LABELS: 'true',
    DATABASE_SAVE_DATA_HISTORIC: 'true',
    DATABASE_SAVE_IS_ON_WHATSAPP: 'true',
    DATABASE_DELETE_MESSAGE: 'true',
    CACHE_REDIS_ENABLED: 'false',
    CACHE_LOCAL_ENABLED: 'true',
    S3_ENABLED: 'false',
    LOG_LEVEL: 'ERROR,WARN',
    LOG_BAILEYS: 'error',
  },
} as const;

export type Profile = keyof typeof PROFILES;

/** Set every flag of the profile, so nothing leaks from the previous test. */
export function applyProfile(profile: Profile) {
  Object.assign(process.env, PROFILES[profile]);
}
