// Bundles each entry point into dist/<name>/index.mjs:
//  - api, webhook, jobs: AWS Lambda handlers (zipped by Terraform)
//  - server, migrate:    standalone Node server + migration CLI (Docker / any host)
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const entries = {
  api: 'src/handlers/api.ts',
  webhook: 'src/handlers/webhook.ts',
  jobs: 'src/handlers/jobs.ts',
  server: 'src/server/main.ts',
  migrate: 'src/server/migrate.ts',
};

await rm('dist', { recursive: true, force: true });

await Promise.all(
  Object.entries(entries).map(([name, entry]) =>
    build({
      entryPoints: [entry],
      outfile: `dist/${name}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: 'linked',
      minify: true,
      // The Node.js Lambda runtime ships AWS SDK v3, but bundling pins the version we tested.
      // PGlite is dev/test-only; pg-native is an optional pg addon we don't use.
      external: ['@electric-sql/pglite', 'pg-native'],
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    }),
  ),
);

console.info('Built lambda bundles:', Object.keys(entries).join(', '));
