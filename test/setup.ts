// Every test starts from the `minimal` production configuration (test/helpers/profiles.ts).
// A test that needs Evolution to store data asks for the `stored` profile.
import { applyProfile } from './helpers/profiles';

process.env.DATABASE_PROVIDER ??= 'postgresql';
process.env.DATABASE_CONNECTION_URI ??= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.CHATWOOT_ENABLED ??= 'false';
process.env.TELEMETRY_ENABLED ??= 'false';
applyProfile('minimal');
