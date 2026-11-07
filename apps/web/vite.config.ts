import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // Local dev: same-origin proxy to the API so the refresh cookie just works.
    proxy: { '/v1': 'http://localhost:8080', '/health': 'http://localhost:8080' },
  },
});
