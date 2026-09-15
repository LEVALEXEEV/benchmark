import { defineConfig } from 'vite';

// COOP/COEP включают cross-origin isolation: без неё Chrome огрубляет
// performance.now() до 100 мкс, Firefox — до 1 мс (см. metrics/env.ts).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: { target: 'es2022', sourcemap: true },
});
