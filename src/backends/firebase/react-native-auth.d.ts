import type { Persistence } from 'firebase/auth';

/**
 * `getReactNativePersistence` ships in firebase/auth's React Native build,
 * but the package's top-level "types" entry points at the web typings, so
 * TypeScript can't see it. Metro resolves the RN build at runtime.
 */
declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }): Persistence;
}
