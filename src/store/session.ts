import { create } from 'zustand';

import type { BackendId, ChatBackend, ChatUser } from '@/backends/types';

/**
 * Global session state (Zustand). Server data — conversations, messages,
 * users — lives in TanStack Query; this store only holds who is signed in
 * and which backend is active.
 */

export type SessionStatus = 'booting' | 'signedOut' | 'signedIn' | 'backendError';

interface SessionState {
  status: SessionStatus;
  backendId: BackendId | null;
  backend: ChatBackend | null;
  user: ChatUser | null;
  error: string | null;
  setBooting: (backendId: BackendId) => void;
  setBackend: (backend: ChatBackend, user: ChatUser | null) => void;
  setUser: (user: ChatUser | null) => void;
  setBackendError: (backendId: BackendId, message: string) => void;
}

export const useSession = create<SessionState>((set) => ({
  status: 'booting',
  backendId: null,
  backend: null,
  user: null,
  error: null,
  setBooting: (backendId) => set({ status: 'booting', backendId, backend: null, user: null, error: null }),
  setBackend: (backend, user) =>
    set({ backend, backendId: backend.id, user, status: user ? 'signedIn' : 'signedOut', error: null }),
  setUser: (user) => set({ user, status: user ? 'signedIn' : 'signedOut' }),
  setBackendError: (backendId, message) => set({ status: 'backendError', backendId, backend: null, user: null, error: message }),
}));

/** The active backend. Only call from screens rendered after boot (inside the guarded stacks). */
export function useBackend(): ChatBackend {
  const backend = useSession((s) => s.backend);
  if (!backend) throw new Error('useBackend() called before a backend was loaded');
  return backend;
}

export function useCurrentUser(): ChatUser {
  const user = useSession((s) => s.user);
  if (!user) throw new Error('useCurrentUser() called while signed out');
  return user;
}
