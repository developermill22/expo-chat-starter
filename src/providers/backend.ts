import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';

import { getDefaultBackendId, isBackendId } from '@/backends/config';
import { BACKENDS } from '@/backends/registry';
import { toError, type BackendId, type ChatBackend, type Unsubscribe } from '@/backends/types';
import { useSession } from '@/store/session';

/**
 * Backend lifecycle: load → restore session → listen for auth changes.
 *
 * The build-time default comes from EXPO_PUBLIC_CHAT_BACKEND. In development
 * you can switch backends from Settings; the choice is remembered on the
 * device. Production builds ignore the stored override (see resolveBackendId)
 * so users can't land on an unconfigured provider.
 */

const OVERRIDE_KEY = 'chat-starter:backend-override';

let active: ChatBackend | null = null;
let authListener: Unsubscribe | null = null;
let generation = 0;

async function teardown() {
  authListener?.();
  authListener = null;
  const previous = active;
  active = null;
  await previous?.dispose().catch(() => undefined);
}

export async function resolveBackendId(): Promise<BackendId> {
  if (!__DEV__) return getDefaultBackendId();
  try {
    const stored = await AsyncStorage.getItem(OVERRIDE_KEY);
    return isBackendId(stored) ? stored : getDefaultBackendId();
  } catch {
    return getDefaultBackendId();
  }
}

export async function activateBackend(id: BackendId, queryClient: QueryClient): Promise<void> {
  const run = ++generation;
  const session = useSession.getState();
  session.setBooting(id);
  await teardown();
  queryClient.clear();

  try {
    const backend = await BACKENDS[id].load();
    if (run !== generation) {
      // A newer switch started while this one was loading.
      await backend.dispose();
      return;
    }
    const user = await backend.auth.getCurrentUser();
    active = backend;
    authListener = backend.auth.onAuthStateChanged((next) => {
      const { user: current, setUser } = useSession.getState();
      if (!next && current) queryClient.clear(); // never leak one user's cache into the next session
      setUser(next);
    });
    useSession.getState().setBackend(backend, user);
  } catch (error) {
    if (run === generation) useSession.getState().setBackendError(id, toError(error).message);
  }
}

export async function switchBackend(id: BackendId, queryClient: QueryClient): Promise<void> {
  try {
    await AsyncStorage.setItem(OVERRIDE_KEY, id);
  } catch {
    // Non-fatal: the switch still applies for this session.
  }
  await activateBackend(id, queryClient);
}

/** Wipe the on-device SQLite database and start fresh with demo data. */
export async function resetLocalData(queryClient: QueryClient): Promise<void> {
  generation++;
  await teardown();
  const { resetSqliteDatabase } = await import('@/backends/sqlite');
  await resetSqliteDatabase();
  await activateBackend('sqlite', queryClient);
}
