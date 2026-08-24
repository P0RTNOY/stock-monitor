import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type Plugin } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;
const localAnalysisOrigin = new URL(
  process.env.ANALYSIS_API_URL ?? 'http://127.0.0.1:8502',
).origin;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

function localAnalysisBridge(): Plugin {
  return {
    name: 'northstar-local-analysis-bridge',
    configureServer(server) {
      server.middlewares.use('/api/analysis', async (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }

        const sendJson = (status: number, payload: Record<string, unknown>) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(payload));
        };

        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 4 * 1024) {
              sendJson(413, { error: 'Analysis request is too large.' });
              return;
            }
            chunks.push(bytes);
          }

          const body = Buffer.concat(chunks).toString('utf8');
          const payload = JSON.parse(body) as { symbol?: unknown };
          const symbol = typeof payload.symbol === 'string' ? payload.symbol.trim().toUpperCase() : '';
          const address = server.httpServer?.address();
          const port = typeof address === 'object' && address ? address.port : 8501;
          const workspaceResponse = await fetch(`http://localhost:${port}/api/workspace`, {
            headers: request.headers.cookie ? { Cookie: request.headers.cookie } : undefined,
          });
          const workspace = await workspaceResponse.json() as {
            positions?: Array<{ symbol?: string }>;
            watchlist?: Array<{ symbol?: string }>;
          };
          const allowed = new Set([
            ...(workspace.positions ?? []).map((item) => item.symbol),
            ...(workspace.watchlist ?? []).map((item) => item.symbol),
          ]);
          if (!workspaceResponse.ok || !symbol || !allowed.has(symbol)) {
            sendJson(400, { error: 'Save this symbol as a position or watchlist item first.' });
            return;
          }

          const upstream = await fetch(`${localAnalysisOrigin}/v1/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          });
          const upstreamBody = await upstream.arrayBuffer();
          response.statusCode = upstream.status;
          response.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(Buffer.from(upstreamBody));
        } catch (error) {
          console.error('local analysis bridge failed', error instanceof Error ? error.name : 'UnknownError');
          sendJson(503, { error: 'Technical analysis service is unavailable.' });
        }
      });
    },
  };
}

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
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

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      localAnalysisBridge(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
