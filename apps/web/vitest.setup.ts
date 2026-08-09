/**
 * Give the tests a working `localStorage`.
 *
 * Node 22 ships its own experimental `localStorage` global, disabled unless
 * the process was started with `--localstorage-file`. It is defined on
 * `globalThis` either way, and vitest's jsdom environment does not overwrite
 * globals that already exist — so jsdom's own implementation never lands and
 * `window.localStorage` reads as `undefined`, which is neither browser nor
 * server behaviour.
 *
 * This installs a plain in-memory Storage so the session helpers are exercised
 * against something that behaves like a browser's. It is a substitute for the
 * environment, not for anything under test: `lib/api.ts`'s own logic runs
 * unmodified.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

if (typeof window !== 'undefined' && !window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
