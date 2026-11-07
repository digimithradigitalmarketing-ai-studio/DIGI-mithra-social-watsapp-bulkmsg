import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/scripts/migrate.ts', 'src/scripts/provision-admin.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // The shared workspace package ships TypeScript source, so bundle it in.
  noExternal: ['@socialpilot/shared'],
});
