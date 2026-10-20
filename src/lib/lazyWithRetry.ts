import { lazy, type ComponentType } from 'react';

/**
 * Robust lazy wrapper that handles deployment updates.
 * When a new deployment occurs (e.g. on Vercel), old chunk hashes are replaced.
 * If a user navigates to a code-split route while having an older index.html,
 * this catches the dynamic import failure, forces a reload to pull the latest
 * deployment bundle, and avoids showing a broken "Failed to fetch module" screen.
 */
type ComponentModule<T> = { default: T } | Record<string, unknown>;

export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<ComponentModule<T>>,
  exportName = 'default'
) {
  return lazy(async () => {
    const sessionKey = `retry_chunk_${exportName}`;
    try {
      const module = await factory();
      sessionStorage.removeItem(sessionKey);
      const modRecord = module as Record<string, unknown>;
      const component = (modRecord[exportName] || modRecord.default) as T;
      return { default: component };
    } catch (err: unknown) {
      const errorMsg = String(err);
      const isChunkError =
        errorMsg.includes('Failed to fetch dynamically imported module') ||
        errorMsg.includes('Loading chunk') ||
        errorMsg.includes('Importing a module script failed') ||
        errorMsg.includes('error loading dynamically imported module');

      const alreadyRetried = sessionStorage.getItem(sessionKey);
      if (isChunkError && !alreadyRetried) {
        sessionStorage.setItem(sessionKey, String(Date.now()));
        // Force refresh to pull new manifest from server
        window.location.reload();
        return new Promise(() => {}); // Hold until reload triggers
      }

      throw err;
    }
  });
}
