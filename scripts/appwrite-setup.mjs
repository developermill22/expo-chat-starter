#!/usr/bin/env node
/**
 * One-shot Appwrite provisioning for the chat starter. Idempotent: re-running
 * skips anything that already exists.
 *
 * Needs a SERVER API key (Console → Overview → API keys) with scopes:
 *   databases.read/write, tables.read/write, columns.read/write,
 *   indexes.read/write, functions.read/write
 * Never put this key in an EXPO_PUBLIC_ variable — it must not ship in the app.
 *
 *   APPWRITE_API_KEY=... npm run appwrite:setup
 *
 * Reads EXPO_PUBLIC_APPWRITE_ENDPOINT / EXPO_PUBLIC_APPWRITE_PROJECT_ID /
 * EXPO_PUBLIC_APPWRITE_DATABASE_ID from .env.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppwriteException, Client, Functions, Permission, Role, TablesDB } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.APPWRITE_ENDPOINT || process.env.EXPO_PUBLIC_APPWRITE_ENDPOINT;
const projectId = process.env.APPWRITE_PROJECT_ID || process.env.EXPO_PUBLIC_APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.EXPO_PUBLIC_APPWRITE_DATABASE_ID || 'chat';
const runtime = process.env.APPWRITE_FUNCTION_RUNTIME || 'node-22';
const FUNCTION_ID = 'chat-conversations';

if (!endpoint || !projectId || !apiKey) {
  console.error('Missing EXPO_PUBLIC_APPWRITE_ENDPOINT, EXPO_PUBLIC_APPWRITE_PROJECT_ID or APPWRITE_API_KEY.');
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tables = new TablesDB(client);
const functions = new Functions(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensure(label, create) {
  try {
    await create();
    console.log(`  + ${label}`);
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      console.log(`  = ${label} (exists)`);
      return;
    }
    throw error;
  }
}

/** Columns are created asynchronously; indexes need them to be available first. */
async function waitForColumns(tableId, keys) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const table = await tables.getTable({ databaseId, tableId });
    const pending = table.columns.filter((c) => keys.includes(c.key) && c.status !== 'available');
    const failed = table.columns.filter((c) => keys.includes(c.key) && c.status === 'failed');
    if (failed.length) throw new Error(`Columns failed on ${tableId}: ${failed.map((c) => c.key).join(', ')}`);
    if (pending.length === 0) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for columns on ${tableId}`);
}

const varchar = (tableId, key, size, required = false, array = false) =>
  ensure(`${tableId}.${key}`, () => tables.createVarcharColumn({ databaseId, tableId, key, size, required, array }));

async function main() {
  console.log(`Provisioning Appwrite project ${projectId} (database "${databaseId}")`);

  await ensure(`database ${databaseId}`, () => tables.create({ databaseId, name: 'Chat' }));

  // profiles: public directory, each user writes their own row (id = user id).
  await ensure('table profiles', () =>
    tables.createTable({
      databaseId,
      tableId: 'profiles',
      name: 'Profiles',
      rowSecurity: true,
      permissions: [Permission.create(Role.users())],
    }),
  );
  await varchar('profiles', 'displayName', 60, true);
  await varchar('profiles', 'displayNameLower', 60, true);
  await varchar('profiles', 'email', 320);
  await varchar('profiles', 'avatarUrl', 2048);
  await waitForColumns('profiles', ['displayName', 'displayNameLower', 'email', 'avatarUrl']);
  await ensure('index profiles.displayNameLower', () =>
    tables.createIndex({ databaseId, tableId: 'profiles', key: 'by_name', type: 'key', columns: ['displayNameLower'] }),
  );
  await ensure('index profiles.email', () =>
    tables.createIndex({ databaseId, tableId: 'profiles', key: 'by_email', type: 'key', columns: ['email'] }),
  );

  // conversations: created only by the Function, row permissions per Team.
  await ensure('table conversations', () =>
    tables.createTable({ databaseId, tableId: 'conversations', name: 'Conversations', rowSecurity: true, permissions: [] }),
  );
  await varchar('conversations', 'title', 80);
  await ensure('conversations.isGroup', () =>
    tables.createBooleanColumn({ databaseId, tableId: 'conversations', key: 'isGroup', required: true }),
  );
  await varchar('conversations', 'memberIds', 36, false, true);
  await varchar('conversations', 'lastMessageText', 200);
  await varchar('conversations', 'lastMessageSenderId', 36);
  await ensure('conversations.lastMessageAt', () =>
    tables.createIntegerColumn({ databaseId, tableId: 'conversations', key: 'lastMessageAt', required: false }),
  );
  await waitForColumns('conversations', ['title', 'isGroup', 'memberIds', 'lastMessageText', 'lastMessageSenderId', 'lastMessageAt']);

  // messages: any signed-in user may create; the client sets read permission to the conversation Team.
  await ensure('table messages', () =>
    tables.createTable({
      databaseId,
      tableId: 'messages',
      name: 'Messages',
      rowSecurity: true,
      permissions: [Permission.create(Role.users())],
    }),
  );
  await varchar('messages', 'conversationId', 36, true);
  await varchar('messages', 'senderId', 36, true);
  await ensure('messages.text', () => tables.createTextColumn({ databaseId, tableId: 'messages', key: 'text', required: true }));
  await varchar('messages', 'clientId', 64);
  await waitForColumns('messages', ['conversationId', 'senderId', 'text', 'clientId']);
  await ensure('index messages.conversation', () =>
    tables.createIndex({
      databaseId,
      tableId: 'messages',
      key: 'by_conversation',
      type: 'key',
      columns: ['conversationId', '$createdAt'],
      orders: ['asc', 'desc'],
    }),
  );

  // Function that creates conversations + Teams with server privileges.
  await ensure(`function ${FUNCTION_ID}`, () =>
    functions.create({
      functionId: FUNCTION_ID,
      name: 'Chat conversations',
      runtime,
      execute: [Role.users()],
      entrypoint: 'src/main.js',
      commands: 'npm install',
      timeout: 15,
      scopes: ['users.read', 'teams.read', 'teams.write', 'rows.read', 'rows.write'],
    }),
  );
  if (databaseId !== 'chat') {
    await ensure('function variable CHAT_DATABASE_ID', () =>
      functions.createVariable({ functionId: FUNCTION_ID, variableId: 'chat_database_id', key: 'CHAT_DATABASE_ID', value: databaseId }),
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'chat-fn-'));
  const archive = join(dir, 'code.tar.gz');
  try {
    execFileSync('tar', ['-czf', archive, '--exclude=node_modules', '-C', join(root, 'backend/appwrite/functions/chat-conversations'), '.']);
    const deployment = await functions.createDeployment({
      functionId: FUNCTION_ID,
      code: InputFile.fromPath(archive, 'code.tar.gz'),
      activate: true,
    });
    console.log(`  + deployment ${deployment.$id} (building — check the Console for status)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nDone. Remember to add your app as a platform (Console → Overview → Add platform)');
  console.log('using the same bundle id / package name as EXPO_PUBLIC_APPWRITE_PLATFORM.');
}

main().catch((error) => {
  console.error('\nSetup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
