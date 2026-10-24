import type { BackendId } from './types';

/**
 * All backend settings come from EXPO_PUBLIC_* env vars (see .env.example).
 *
 * Expo only inlines env vars that are read as literal `process.env.EXPO_PUBLIC_X`
 * expressions, so every variable is spelled out here instead of looked up
 * dynamically. Client-side keys are public by design; protect data with the
 * security rules / RLS / permissions shipped in /backend.
 */

const env = {
  backend: process.env.EXPO_PUBLIC_CHAT_BACKEND,

  firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  firebaseMessagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,

  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseKey: process.env.EXPO_PUBLIC_SUPABASE_KEY,

  appwriteEndpoint: process.env.EXPO_PUBLIC_APPWRITE_ENDPOINT,
  appwriteProjectId: process.env.EXPO_PUBLIC_APPWRITE_PROJECT_ID,
  appwritePlatform: process.env.EXPO_PUBLIC_APPWRITE_PLATFORM,
  appwriteDatabaseId: process.env.EXPO_PUBLIC_APPWRITE_DATABASE_ID,
} as const;

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export interface SupabaseConfig {
  url: string;
  key: string;
}

export interface AppwriteConfig {
  endpoint: string;
  projectId: string;
  platform: string;
  databaseId: string;
}

const BACKEND_IDS: readonly BackendId[] = ['firebase', 'supabase', 'appwrite', 'sqlite'];

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === 'string' && (BACKEND_IDS as readonly string[]).includes(value);
}

/** Backend chosen at build time. Falls back to local SQLite so the app always boots. */
export function getDefaultBackendId(): BackendId {
  return isBackendId(env.backend) ? env.backend : 'sqlite';
}

type Required<T> = { [K in keyof T]: string };

function collect<T extends Record<string, string | undefined>>(
  values: T,
  names: Record<keyof T, string>,
): { config: Required<T> | null; missing: string[] } {
  const missing = (Object.keys(values) as (keyof T)[])
    .filter((key) => !values[key])
    .map((key) => names[key]);
  return { config: missing.length ? null : (values as Required<T>), missing };
}

export function readFirebaseConfig() {
  return collect<Record<keyof FirebaseConfig, string | undefined>>(
    {
      apiKey: env.firebaseApiKey,
      authDomain: env.firebaseAuthDomain,
      projectId: env.firebaseProjectId,
      storageBucket: env.firebaseStorageBucket,
      messagingSenderId: env.firebaseMessagingSenderId,
      appId: env.firebaseAppId,
    },
    {
      apiKey: 'EXPO_PUBLIC_FIREBASE_API_KEY',
      authDomain: 'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
      projectId: 'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
      storageBucket: 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
      messagingSenderId: 'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      appId: 'EXPO_PUBLIC_FIREBASE_APP_ID',
    },
  );
}

export function readSupabaseConfig() {
  return collect<Record<keyof SupabaseConfig, string | undefined>>(
    { url: env.supabaseUrl, key: env.supabaseKey },
    { url: 'EXPO_PUBLIC_SUPABASE_URL', key: 'EXPO_PUBLIC_SUPABASE_KEY' },
  );
}

export function readAppwriteConfig() {
  return collect<Record<keyof AppwriteConfig, string | undefined>>(
    {
      endpoint: env.appwriteEndpoint,
      projectId: env.appwriteProjectId,
      platform: env.appwritePlatform,
      // The setup script creates a database called "chat"; override if you renamed it.
      databaseId: env.appwriteDatabaseId || 'chat',
    },
    {
      endpoint: 'EXPO_PUBLIC_APPWRITE_ENDPOINT',
      projectId: 'EXPO_PUBLIC_APPWRITE_PROJECT_ID',
      platform: 'EXPO_PUBLIC_APPWRITE_PLATFORM',
      databaseId: 'EXPO_PUBLIC_APPWRITE_DATABASE_ID',
    },
  );
}
