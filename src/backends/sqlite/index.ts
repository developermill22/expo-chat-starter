import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

import type { ChatBackend } from '../types';
import { createSqliteBackendFromDriver, type SqlDriver } from './core';

export const SQLITE_DB_NAME = 'chat-starter.db';

/** Wire the driver-agnostic SQLite adapter to expo-sqlite + expo-crypto. */
export async function createSqliteBackend(): Promise<ChatBackend> {
  const database = await SQLite.openDatabaseAsync(SQLITE_DB_NAME);
  await database.execAsync('PRAGMA journal_mode = WAL;');

  const driver: SqlDriver = {
    exec: (sql) => database.execAsync(sql),
    run: async (sql, params = []) => {
      await database.runAsync(sql, params);
    },
    all: (sql, params = []) => database.getAllAsync(sql, params),
    first: (sql, params = []) => database.getFirstAsync(sql, params),
    transaction: (task) => database.withTransactionAsync(task),
  };

  const backend = await createSqliteBackendFromDriver({
    db: driver,
    hash: (input) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input),
    randomId: () => Crypto.randomUUID(),
  });

  return {
    ...backend,
    async dispose() {
      await backend.dispose();
      await database.closeAsync();
    },
  };
}

/** Dev helper: wipe the local database (used by Settings → "Reset local data"). */
export async function resetSqliteDatabase() {
  await SQLite.deleteDatabaseAsync(SQLITE_DB_NAME);
}
