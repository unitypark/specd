import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same `@/…` the app imports by. Next resolves it from tsconfig paths;
  // vitest does not read those, so a component under test would fail on its
  // own imports rather than on anything it does.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url).href.replace(/\/$/, '')) },
  },
  // Next compiles JSX with the automatic runtime; tsconfig says `preserve`
  // because Next does that compiling. esbuild would otherwise fall back to the
  // classic runtime and every component test would fail on a missing `React`.
  esbuild: { jsx: 'automatic' },
  test: {
    // `lib/` reads window.localStorage to decide whether it has a session, and
    // returns null under SSR rather than throwing. Testing that distinction
    // needs a real `window` to exist for some cases and not others, so the
    // suite runs in jsdom and deletes the global where it wants the SSR path.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
