import { defineConfig } from 'vitest/config';

export default defineConfig({
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
