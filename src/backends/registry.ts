import { readAppwriteConfig, readFirebaseConfig, readSupabaseConfig } from './config';
import { ChatBackendError, type BackendId, type ChatBackend } from './types';

export interface BackendDescriptor {
  id: BackendId;
  label: string;
  description: string;
  /** Env vars still missing for this backend. Empty means it can be loaded. */
  missingConfig: () => string[];
  /**
   * Adapters are loaded with dynamic import so a provider's SDK is only
   * evaluated when that provider is selected. Unused SDKs still ship in the
   * bundle; delete an adapter folder + its entry here to drop it entirely.
   */
  load: () => Promise<ChatBackend>;
}

export const BACKENDS: Record<BackendId, BackendDescriptor> = {
  sqlite: {
    id: 'sqlite',
    label: 'Local SQLite',
    description: 'On-device database. No setup, works offline, single device. Comes with demo users and an echo bot.',
    missingConfig: () => [],
    load: () => import('./sqlite').then((m) => m.createSqliteBackend()),
  },
  firebase: {
    id: 'firebase',
    label: 'Firebase',
    description: 'Firebase Auth + Cloud Firestore with realtime snapshot listeners.',
    missingConfig: () => readFirebaseConfig().missing,
    load: async () => {
      const { config, missing } = readFirebaseConfig();
      if (!config) throw missingError('Firebase', missing);
      const m = await import('./firebase');
      return m.createFirebaseBackend(config);
    },
  },
  supabase: {
    id: 'supabase',
    label: 'Supabase',
    description: 'Supabase Auth + Postgres with Row Level Security and Realtime.',
    missingConfig: () => readSupabaseConfig().missing,
    load: async () => {
      const { config, missing } = readSupabaseConfig();
      if (!config) throw missingError('Supabase', missing);
      const m = await import('./supabase');
      return m.createSupabaseBackend(config);
    },
  },
  appwrite: {
    id: 'appwrite',
    label: 'Appwrite',
    description: 'Appwrite Auth + TablesDB with row-level permissions and Realtime.',
    missingConfig: () => readAppwriteConfig().missing,
    load: async () => {
      const { config, missing } = readAppwriteConfig();
      if (!config) throw missingError('Appwrite', missing);
      const m = await import('./appwrite');
      return m.createAppwriteBackend(config);
    },
  },
};

export const BACKEND_ORDER: BackendId[] = ['sqlite', 'firebase', 'supabase', 'appwrite'];

function missingError(name: string, missing: string[]) {
  return new ChatBackendError(
    'backend-not-configured',
    `${name} is not configured. Add ${missing.join(', ')} to your .env file and restart Expo.`,
  );
}
