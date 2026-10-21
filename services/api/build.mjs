// Bundles each Lambda entry point into dist/<name>/index.mjs for Terraform to zip.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const entries = {
  api: 'src/handlers/api.ts',
  webhook: 'src/handlers/webhook.ts',
  jobs: 'src/handlers/jobs.ts',
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
      external: [],
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    }),
  ),
);

console.info('Built lambda bundles:', Object.keys(entries).join(', '));
