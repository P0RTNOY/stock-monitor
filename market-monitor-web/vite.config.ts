import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

function bindingConfig(developmentServer: boolean) {
  return {
  main: './worker/index.ts',
  compatibility_flags: ['nodejs_compat'],
  triggers: { crons: ['30 6 * * *'] },
  vars: {
    NORTHSTAR_ENVIRONMENT: developmentServer
      ? process.env.NORTHSTAR_ENVIRONMENT ?? 'production' : 'production',
    NORTHSTAR_AUTH_MODE: developmentServer
      ? process.env.NORTHSTAR_AUTH_MODE ?? 'deny_all' : 'deny_all',
    ...(process.env.NORTHSTAR_SYSTEM_PROFILE_ID
      ? { NORTHSTAR_SYSTEM_PROFILE_ID: process.env.NORTHSTAR_SYSTEM_PROFILE_ID }
      : {}),
    FORECAST_SCHEDULER_ENABLED: 'false',
    FORECAST_SCHEDULER_ENVIRONMENT: 'local',
    FORECAST_SCHEDULER_PAGE_SIZE: '10',
    FORECAST_SCHEDULER_MAX_PAGES: '3',
    FORECAST_SCHEDULER_MAX_ITEMS: '25',
    FORECAST_SCHEDULER_MAX_RUNTIME_MS: '480000',
    FORECAST_SCHEDULER_MIN_REMAINING_MS: '45000',
    FORECAST_SCHEDULER_VERSION: 'forecast-scheduler-1.0.0',
    FORECAST_COORDINATOR_VERSION: 'forecast-coordinator-1.0.0',
    FORECAST_EMAIL_ENVIRONMENT: 'local',
    FORECAST_EMAIL_DISPATCH_ENABLED: 'false',
    FORECAST_EMAIL_PROVIDER_TIMEOUT_MS: '10000',
    FORECAST_EMAIL_RESPONSE_MAX_BYTES: '16384',
    FORECAST_EMAIL_DISPATCH_LIMIT: '10',
    FORECAST_EMAIL_WEBHOOK_MAX_BYTES: '65536',
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
  };
}

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    // Operator tests import Wrangler-backed modules, but Wrangler is never an
    // application runtime dependency and must not be browser-prebundled.
    optimizeDeps: { exclude: ['wrangler', 'blake3-wasm'] },
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: bindingConfig(command === 'serve'),
        ...(process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH
          ? { persistState: { path: process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH } }
          : {}),
      }),
    ],
  };
});
