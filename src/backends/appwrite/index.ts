import {
  Account,
  AppwriteException,
  Channel,
  Client,
  Functions,
  ID,
  Permission,
  Query,
  Role,
  TablesDB,
  type Models,
} from 'react-native-appwrite';

import type { AppwriteConfig } from '../config';
import {
  assertValidEmail,
  assertValidPassword,
  cleanDisplayName,
  cleanMessageText,
  createEmitter,
  normalizeEmail,
  once,
} from '../shared';
import { ChatBackendError, toError, type ChatBackend, type ChatUser, type Conversation, type Message } from '../types';

/**
 * Appwrite adapter: Appwrite Account (email/password) + TablesDB + Realtime.
 *
 * Privacy model: every conversation has an Appwrite Team with the same id.
 * Conversation and message rows are readable only by that team. Client SDKs
 * can't add *other* users to a team or grant them permissions, so creating a
 * conversation goes through the small `chat-conversations` Function
 * (backend/appwrite/functions). Sending messages and updating the preview
 * happen directly from the client, scoped by the team permission.
 *
 * Run `npm run appwrite:setup` once to create the database, tables, indexes
 * and the Function.
 */

export const APPWRITE_TABLES = {
  profiles: 'profiles',
  conversations: 'conversations',
  messages: 'messages',
} as const;
export const APPWRITE_CONVERSATION_FUNCTION = 'chat-conversations';

type ProfileRow = Models.Row & {
  displayName: string;
  displayNameLower: string;
  email: string | null;
  avatarUrl: string | null;
};

type ConversationRow = Models.Row & {
  title: string | null;
  isGroup: boolean;
  memberIds: string[];
  lastMessageText: string | null;
  lastMessageSenderId: string | null;
  lastMessageAt: number | null;
};

type MessageRow = Models.Row & {
  conversationId: string;
  senderId: string;
  text: string;
  clientId: string | null;
};

const toUser = (row: ProfileRow): ChatUser => ({
  id: row.$id,
  displayName: row.displayName,
  email: row.email,
  avatarUrl: row.avatarUrl,
});

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.$id,
  title: row.title,
  isGroup: row.isGroup,
  memberIds: row.memberIds,
  createdAt: Date.parse(row.$createdAt),
  updatedAt: Date.parse(row.$updatedAt),
  lastMessage:
    row.lastMessageText !== null && row.lastMessageSenderId !== null
      ? { text: row.lastMessageText, senderId: row.lastMessageSenderId, createdAt: row.lastMessageAt ?? Date.parse(row.$updatedAt) }
      : null,
});

const toMessage = (row: MessageRow): Message => ({
  id: row.$id,
  conversationId: row.conversationId,
  senderId: row.senderId,
  text: row.text,
  clientId: row.clientId,
  // $createdAt is set by the server, so ordering is immune to device clock skew.
  createdAt: Date.parse(row.$createdAt),
});

function mapError(error: unknown): Error {
  if (error instanceof ChatBackendError) return error;
  if (error instanceof AppwriteException) {
    const friendly: Record<string, string> = {
      user_invalid_credentials: 'Email or password is incorrect.',
      user_already_exists: 'An account with this email already exists.',
      user_password_mismatch: 'Email or password is incorrect.',
      password_recently_used: 'Choose a password you have not used recently.',
      database_not_found: 'Appwrite database not found. Run `npm run appwrite:setup`.',
      table_not_found: 'Appwrite tables not found. Run `npm run appwrite:setup`.',
      function_not_found: 'The chat-conversations Function is missing. Run `npm run appwrite:setup`.',
      general_unauthorized_scope: 'You are not signed in.',
    };
    return new ChatBackendError(error.type || String(error.code), friendly[error.type] ?? error.message);
  }
  return toError(error);
}

async function guard<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw mapError(error);
  }
}

export async function createAppwriteBackend(config: AppwriteConfig): Promise<ChatBackend> {
  const client = new Client().setEndpoint(config.endpoint).setProject(config.projectId).setPlatform(config.platform);
  const account = new Account(client);
  const tables = new TablesDB(client);
  const functions = new Functions(client);
  const databaseId = config.databaseId;

  // Appwrite has no auth listener on the client, so the adapter emits its own.
  const authEvents = createEmitter<ChatUser | null>();
  const subscriptions = new Set<() => void>();
  let currentUserId: string | null = null;

  const requireUid = () => {
    if (!currentUserId) throw new ChatBackendError('not-signed-in', 'You need to sign in first.');
    return currentUserId;
  };

  async function profileFor(user: Models.User<Models.Preferences>): Promise<ChatUser> {
    try {
      const row = await tables.getRow<ProfileRow>({ databaseId, tableId: APPWRITE_TABLES.profiles, rowId: user.$id });
      return toUser(row);
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404) return ensureProfile(user.$id, user.name, user.email);
      throw error;
    }
  }

  async function ensureProfile(userId: string, displayName: string, email: string): Promise<ChatUser> {
    const name = displayName || email.split('@')[0] || 'User';
    const row = await tables.upsertRow<ProfileRow>({
      databaseId,
      tableId: APPWRITE_TABLES.profiles,
      rowId: userId,
      data: { displayName: name, displayNameLower: name.toLowerCase(), email, avatarUrl: null },
      permissions: [Permission.read(Role.users()), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
    });
    return toUser(row);
  }

  async function startSession(email: string, password: string) {
    try {
      await account.createEmailPasswordSession({ email, password });
    } catch (error) {
      // A stale session blocks creating a new one; clear it and retry once.
      if (error instanceof AppwriteException && error.type === 'user_session_already_exists') {
        await account.deleteSession({ sessionId: 'current' });
        await account.createEmailPasswordSession({ email, password });
      } else {
        throw error;
      }
    }
    const user = await account.get();
    currentUserId = user.$id;
    return user;
  }

  async function runConversationFunction(body: Record<string, unknown>): Promise<Conversation> {
    const execution = await functions.createExecution({
      functionId: APPWRITE_CONVERSATION_FUNCTION,
      body: JSON.stringify(body),
      async: false,
    });
    const parsed: unknown = JSON.parse(execution.responseBody || '{}');
    if (execution.responseStatusCode >= 400 || !parsed || typeof parsed !== 'object' || !('conversationId' in parsed)) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
          ? parsed.error
          : 'Could not create the conversation.';
      throw new ChatBackendError('function-error', message);
    }
    const row = await tables.getRow<ConversationRow>({
      databaseId,
      tableId: APPWRITE_TABLES.conversations,
      rowId: String(parsed.conversationId),
    });
    return toConversation(row);
  }

  function subscribe(channel: string, callback: (event: { events: string[]; payload: unknown }) => void) {
    const off = client.subscribe(channel, callback);
    const stop = once(() => {
      subscriptions.delete(stop);
      off();
    });
    subscriptions.add(stop);
    return stop;
  }

  const rowsChannel = (tableId: string) => Channel.tablesdb(databaseId).table(tableId).row().toString();

  // Restore the persisted session (the SDK keeps the session cookie itself).
  try {
    currentUserId = (await account.get()).$id;
  } catch {
    currentUserId = null;
  }

  return {
    id: 'appwrite',
    label: 'Appwrite',
    capabilities: { realtime: true, multiDevice: true },

    auth: {
      async getCurrentUser() {
        if (!currentUserId) return null;
        try {
          return await profileFor(await account.get());
        } catch {
          currentUserId = null;
          return null;
        }
      },
      onAuthStateChanged: (listener) => authEvents.on(listener),
      signIn: (email, password) =>
        guard(async () => {
          const user = await profileFor(await startSession(normalizeEmail(email), password));
          authEvents.emit(user);
          return user;
        }),
      signUp: ({ email, password, displayName }) =>
        guard(async () => {
          const normalized = normalizeEmail(email);
          assertValidEmail(normalized);
          assertValidPassword(password);
          const name = cleanDisplayName(displayName);
          await account.create({ userId: ID.unique(), email: normalized, password, name });
          const created = await startSession(normalized, password);
          const user = await ensureProfile(created.$id, name, normalized);
          authEvents.emit(user);
          return user;
        }),
      signOut: () =>
        guard(async () => {
          try {
            await account.deleteSession({ sessionId: 'current' });
          } finally {
            currentUserId = null;
            authEvents.emit(null);
          }
        }),
      updateProfile: (patch) =>
        guard(async () => {
          const uid = requireUid();
          const data: Partial<ProfileRow> = {};
          if (patch.displayName !== undefined) {
            const name = cleanDisplayName(patch.displayName);
            await account.updateName({ name });
            data.displayName = name;
            data.displayNameLower = name.toLowerCase();
          }
          if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl;
          const row = await tables.updateRow<ProfileRow>({ databaseId, tableId: APPWRITE_TABLES.profiles, rowId: uid, data });
          const user = toUser(row);
          authEvents.emit(user);
          return user;
        }),
    },

    users: {
      searchUsers: (text) =>
        guard(async () => {
          const uid = requireUid();
          const q = text.trim().toLowerCase();
          const queries = [Query.notEqual('$id', uid), Query.orderAsc('displayNameLower'), Query.limit(25)];
          if (q.includes('@')) queries.push(Query.equal('email', q));
          else if (q) queries.push(Query.startsWith('displayNameLower', q));
          const result = await tables.listRows<ProfileRow>({ databaseId, tableId: APPWRITE_TABLES.profiles, queries });
          return result.rows.map(toUser);
        }),
      getUsers: (ids) =>
        guard(async () => {
          if (ids.length === 0) return [];
          const result = await tables.listRows<ProfileRow>({
            databaseId,
            tableId: APPWRITE_TABLES.profiles,
            queries: [Query.equal('$id', [...new Set(ids)]), Query.limit(100)],
          });
          return result.rows.map(toUser);
        }),
    },

    conversations: {
      subscribeToConversations(onChange, onError) {
        const uid = requireUid();
        let active = true;
        const load = async () => {
          try {
            // Row permissions already restrict this to the user's chats.
            const result = await tables.listRows<ConversationRow>({
              databaseId,
              tableId: APPWRITE_TABLES.conversations,
              queries: [Query.orderDesc('$updatedAt'), Query.limit(100)],
            });
            if (active) onChange(result.rows.filter((r) => r.memberIds.includes(uid)).map(toConversation));
          } catch (error) {
            if (active) onError?.(mapError(error));
          }
        };
        void load();
        const off = subscribe(rowsChannel(APPWRITE_TABLES.conversations), () => void load());
        return once(() => {
          active = false;
          off();
        });
      },
      getConversation: (id) =>
        guard(async () => {
          try {
            return toConversation(await tables.getRow<ConversationRow>({ databaseId, tableId: APPWRITE_TABLES.conversations, rowId: id }));
          } catch (error) {
            if (error instanceof AppwriteException && (error.code === 404 || error.code === 401)) return null;
            throw error;
          }
        }),
      getOrCreateDirectConversation: (otherUserId) =>
        guard(() => runConversationFunction({ type: 'direct', otherUserId })),
      createGroupConversation: (title, memberIds) =>
        guard(() => runConversationFunction({ type: 'group', title, memberIds })),
    },

    messages: {
      listMessages: (conversationId, { before, limit }) =>
        guard(async () => {
          const queries = [Query.equal('conversationId', conversationId), Query.orderDesc('$createdAt'), Query.limit(limit)];
          if (before !== undefined) queries.push(Query.lessThan('$createdAt', new Date(before).toISOString()));
          const result = await tables.listRows<MessageRow>({ databaseId, tableId: APPWRITE_TABLES.messages, queries });
          return result.rows.map(toMessage);
        }),
      subscribeToMessages(conversationId, onMessage) {
        return subscribe(rowsChannel(APPWRITE_TABLES.messages), (event) => {
          if (!event.events.some((e) => e.endsWith('.create'))) return;
          const row = event.payload as MessageRow;
          if (row.conversationId === conversationId) onMessage(toMessage(row));
        });
      },
      sendMessage: ({ conversationId, text, clientId }) =>
        guard(async () => {
          const uid = requireUid();
          const body = cleanMessageText(text);
          const team = Role.team(conversationId);
          const row = await tables.createRow<MessageRow>({
            databaseId,
            tableId: APPWRITE_TABLES.messages,
            rowId: ID.unique(),
            data: { conversationId, senderId: uid, text: body, clientId },
            permissions: [Permission.read(team)],
          });
          const message = toMessage(row);
          await tables.updateRow<ConversationRow>({
            databaseId,
            tableId: APPWRITE_TABLES.conversations,
            rowId: conversationId,
            data: { lastMessageText: body.slice(0, 200), lastMessageSenderId: uid, lastMessageAt: message.createdAt },
          });
          return message;
        }),
    },

    async dispose() {
      for (const stop of [...subscriptions]) stop();
      authEvents.clear();
    },
  };
}
