import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP включают cross-origin isolation: без неё Chrome огрубляет
// performance.now() до 100 мкс, Firefox — до 1 мс (см. metrics/env.ts).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // React Compiler НЕ подключается: автоматическая мемоизация изменила бы
  // поведение намеренно наивных вариантов (mode=state).
  plugins: [react()],
  server: { port: 5174, strictPort: true, headers: isolation },
  preview: { port: 4174, strictPort: true, headers: isolation },
  build: { target: 'es2022', sourcemap: true },
});
