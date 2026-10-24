import {
  assertValidEmail,
  assertValidPassword,
  cleanDisplayName,
  cleanMessageText,
  createEmitter,
  directKey,
  normalizeEmail,
  once,
} from '../shared';
import {
  ChatBackendError,
  toError,
  type ChatBackend,
  type ChatUser,
  type Conversation,
  type Message,
} from '../types';

/**
 * Local SQLite adapter.
 *
 * Everything lives in one on-device database, so this backend is perfect for
 * offline-first prototyping, UI work and demos — but it is single-device by
 * definition. "Realtime" is an in-process event bus: writes made through this
 * adapter notify subscribers immediately.
 *
 * The adapter is written against the tiny `SqlDriver` interface rather than
 * expo-sqlite directly, so the same code runs in Node tests (node:sqlite)
 * and on device (expo-sqlite). See ./index.ts for the device wiring.
 *
 * Passwords are salted + SHA-256 hashed. That is fine for a local demo and is
 * NOT a substitute for a real auth server.
 */

export type SqlValue = string | number | null;

export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  transaction(task: () => Promise<void>): Promise<void>;
}

export interface SqliteBackendDeps {
  db: SqlDriver;
  hash(input: string): Promise<string>;
  randomId(): string;
  now?: () => number;
  /** Set to null to disable the demo echo bot. */
  botReplyDelayMs?: number | null;
  /** Seed demo users on first launch. Default true. */
  seedDemoData?: boolean;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      display_name_lower TEXT NOT NULL,
      avatar_url TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      direct_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_text TEXT,
      last_sender_id TEXT,
      last_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      client_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT);
  `,
};

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  password_hash: string;
  salt: string;
  is_bot: number;
}

interface ConversationRow {
  id: string;
  title: string | null;
  is_group: number;
  created_at: number;
  updated_at: number;
  last_text: string | null;
  last_sender_id: string | null;
  last_at: number | null;
  member_ids: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  client_id: string | null;
  created_at: number;
}

const DEMO_PASSWORD = 'password123';
const BOT_EMAIL = 'echo-bot@local.chat';
export const DEMO_ACCOUNTS = [
  { email: 'alex@demo.local', displayName: 'Alex Rivera' },
  { email: 'priya@demo.local', displayName: 'Priya Shah' },
] as const;
export { DEMO_PASSWORD };

const toUser = (row: UserRow): ChatUser => ({
  id: row.id,
  displayName: row.display_name,
  email: row.email,
  avatarUrl: row.avatar_url,
});

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  text: row.text,
  createdAt: row.created_at,
  clientId: row.client_id,
});

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  isGroup: row.is_group === 1,
  memberIds: row.member_ids ? row.member_ids.split(',') : [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastMessage:
    row.last_text !== null && row.last_sender_id !== null && row.last_at !== null
      ? { text: row.last_text, senderId: row.last_sender_id, createdAt: row.last_at }
      : null,
});

const CONVERSATION_SELECT = `
  SELECT c.*, (SELECT group_concat(user_id) FROM conversation_members m WHERE m.conversation_id = c.id) AS member_ids
  FROM conversations c`;

export async function createSqliteBackendFromDriver(deps: SqliteBackendDeps): Promise<ChatBackend> {
  const { db, hash, randomId } = deps;
  const now = deps.now ?? Date.now;
  const botDelay = deps.botReplyDelayMs === undefined ? 700 : deps.botReplyDelayMs;

  const authEvents = createEmitter<ChatUser | null>();
  const messageEvents = createEmitter<Message>();
  const conversationEvents = createEmitter<void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let currentUser: ChatUser | null = null;
  let lastTimestamp = 0;

  /** Monotonic clock so messages never tie on created_at (keeps pagination exact). */
  const tick = () => {
    lastTimestamp = Math.max(now(), lastTimestamp + 1);
    return lastTimestamp;
  };

  // ---- schema -------------------------------------------------------------
  await db.exec('PRAGMA foreign_keys = ON;');
  const versionRow = await db.first<{ user_version: number }>('PRAGMA user_version;');
  let version = versionRow?.user_version ?? 0;
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const sql = MIGRATIONS[next];
    if (!sql) throw new Error(`Missing SQLite migration ${next}`);
    await db.exec(sql);
    await db.exec(`PRAGMA user_version = ${next};`);
    version = next;
  }

  const latest = await db.first<{ t: number | null }>('SELECT max(created_at) AS t FROM messages');
  lastTimestamp = latest?.t ?? 0;

  // ---- internal helpers ---------------------------------------------------
  const findUserByEmail = (email: string) =>
    db.first<UserRow>('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);

  const findUser = (id: string) => db.first<UserRow>('SELECT * FROM users WHERE id = ?', [id]);

  async function insertUser(email: string, password: string, displayName: string, isBot = false) {
    const id = randomId();
    const salt = randomId();
    await db.run(
      `INSERT INTO users (id, email, display_name, display_name_lower, avatar_url, password_hash, salt, is_bot, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [id, normalizeEmail(email), displayName, displayName.toLowerCase(), await hash(salt + password), salt, isBot ? 1 : 0, now()],
    );
    const row = await findUser(id);
    if (!row) throw new Error('Failed to create user');
    return row;
  }

  async function loadConversation(id: string) {
    const row = await db.first<ConversationRow>(`${CONVERSATION_SELECT} WHERE c.id = ?`, [id]);
    return row ? toConversation(row) : null;
  }

  async function insertConversation(opts: {
    title: string | null;
    isGroup: boolean;
    memberIds: string[];
    directKey: string | null;
  }) {
    const id = randomId();
    const t = now();
    await db.transaction(async () => {
      await db.run(
        'INSERT INTO conversations (id, title, is_group, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, opts.title, opts.isGroup ? 1 : 0, opts.directKey, t, t],
      );
      for (const userId of opts.memberIds) {
        await db.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', [id, userId, t]);
      }
    });
    conversationEvents.emit();
    const conversation = await loadConversation(id);
    if (!conversation) throw new Error('Failed to create conversation');
    return conversation;
  }

  async function insertMessage(conversationId: string, senderId: string, text: string, clientId: string | null) {
    const message: Message = { id: randomId(), conversationId, senderId, text, clientId, createdAt: tick() };
    await db.transaction(async () => {
      await db.run(
        'INSERT INTO messages (id, conversation_id, sender_id, text, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [message.id, conversationId, senderId, text, clientId, message.createdAt],
      );
      await db.run(
        'UPDATE conversations SET last_text = ?, last_sender_id = ?, last_at = ?, updated_at = ? WHERE id = ?',
        [text, senderId, message.createdAt, message.createdAt, conversationId],
      );
    });
    messageEvents.emit(message);
    conversationEvents.emit();
    return message;
  }

  async function isMember(conversationId: string, userId: string) {
    const row = await db.first<{ ok: number }>(
      'SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId],
    );
    return row !== null;
  }

  async function directWith(meId: string, otherId: string) {
    const key = directKey(meId, otherId);
    const existing = await db.first<{ id: string }>('SELECT id FROM conversations WHERE direct_key = ?', [key]);
    if (existing) {
      const conversation = await loadConversation(existing.id);
      if (conversation) return conversation;
    }
    return insertConversation({ title: null, isGroup: false, memberIds: [meId, otherId], directKey: key });
  }

  function requireUser(): ChatUser {
    if (!currentUser) throw new ChatBackendError('not-signed-in', 'You need to sign in first.');
    return currentUser;
  }

  async function setSession(user: ChatUser | null) {
    currentUser = user;
    if (user) await db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', ['session_user_id', user.id]);
    else await db.run('DELETE FROM kv WHERE key = ?', ['session_user_id']);
    authEvents.emit(user);
  }

  // ---- demo bot -----------------------------------------------------------
  const botRow = async () => findUserByEmail(BOT_EMAIL);

  function scheduleBotReply(conversation: Conversation, text: string, botId: string) {
    if (botDelay === null || conversation.isGroup || !conversation.memberIds.includes(botId)) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void insertMessage(conversation.id, botId, `Echo: ${text}`, null).catch(() => undefined);
    }, botDelay);
    timers.add(timer);
  }

  async function welcome(user: ChatUser) {
    const bot = await botRow();
    if (!bot) return;
    const conversation = await directWith(user.id, bot.id);
    await insertMessage(
      conversation.id,
      bot.id,
      `Hi ${user.displayName}! I'm a local echo bot. Everything you send here is stored in SQLite on this device. Switch backends from Settings.`,
      null,
    );
  }

  // ---- seed ----------------------------------------------------------------
  if (deps.seedDemoData !== false) {
    const count = await db.first<{ n: number }>('SELECT count(*) AS n FROM users');
    if ((count?.n ?? 0) === 0) {
      await insertUser(BOT_EMAIL, randomId(), 'Echo Bot', true);
      for (const account of DEMO_ACCOUNTS) {
        const row = await insertUser(account.email, DEMO_PASSWORD, account.displayName);
        await welcome(toUser(row));
      }
    }
  }

  // ---- restore session -------------------------------------------------------
  const session = await db.first<{ value: string }>('SELECT value FROM kv WHERE key = ?', ['session_user_id']);
  if (session) {
    const row = await findUser(session.value);
    currentUser = row ? toUser(row) : null;
  }

  return {
    id: 'sqlite',
    label: 'Local SQLite',
    capabilities: { realtime: true, multiDevice: false },

    auth: {
      async getCurrentUser() {
        return currentUser;
      },
      onAuthStateChanged(listener) {
        return authEvents.on(listener);
      },
      async signIn(email, password) {
        const row = await findUserByEmail(email);
        if (!row || row.is_bot === 1 || (await hash(row.salt + password)) !== row.password_hash) {
          throw new ChatBackendError('invalid-credentials', 'Email or password is incorrect.');
        }
        const user = toUser(row);
        await setSession(user);
        return user;
      },
      async signUp({ email, password, displayName }) {
        const normalized = normalizeEmail(email);
        assertValidEmail(normalized);
        assertValidPassword(password);
        const name = cleanDisplayName(displayName);
        if (await findUserByEmail(normalized)) {
          throw new ChatBackendError('email-in-use', 'An account with this email already exists.');
        }
        const user = toUser(await insertUser(normalized, password, name));
        await welcome(user);
        await setSession(user);
        return user;
      },
      async signOut() {
        await setSession(null);
      },
      async updateProfile(patch) {
        const me = requireUser();
        const displayName = patch.displayName !== undefined ? cleanDisplayName(patch.displayName) : me.displayName;
        const avatarUrl = patch.avatarUrl !== undefined ? patch.avatarUrl : me.avatarUrl;
        await db.run('UPDATE users SET display_name = ?, display_name_lower = ?, avatar_url = ? WHERE id = ?', [
          displayName,
          displayName.toLowerCase(),
          avatarUrl,
          me.id,
        ]);
        const updated: ChatUser = { ...me, displayName, avatarUrl };
        currentUser = updated;
        authEvents.emit(updated);
        return updated;
      },
    },

    users: {
      async searchUsers(query) {
        const me = requireUser();
        const q = `%${query.trim().toLowerCase()}%`;
        const rows = await db.all<UserRow>(
          `SELECT * FROM users WHERE id != ? AND (display_name_lower LIKE ? OR email LIKE ?)
           ORDER BY is_bot DESC, display_name_lower LIMIT 25`,
          [me.id, q, q],
        );
        return rows.map(toUser);
      },
      async getUsers(ids) {
        if (ids.length === 0) return [];
        const rows = await db.all<UserRow>(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        return rows.map(toUser);
      },
    },

    conversations: {
      subscribeToConversations(onChange, onError) {
        const me = requireUser();
        let active = true;
        const load = () =>
          db
            .all<ConversationRow>(
              `${CONVERSATION_SELECT}
               WHERE c.id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)
               ORDER BY c.updated_at DESC`,
              [me.id],
            )
            .then((rows) => active && onChange(rows.map(toConversation)))
            .catch((error: unknown) => active && onError?.(toError(error)));
        void load();
        const off = conversationEvents.on(() => void load());
        return once(() => {
          active = false;
          off();
        });
      },
      async getConversation(id) {
        const me = requireUser();
        const conversation = await loadConversation(id);
        return conversation && conversation.memberIds.includes(me.id) ? conversation : null;
      },
      async getOrCreateDirectConversation(otherUserId) {
        const me = requireUser();
        if (otherUserId === me.id) throw new ChatBackendError('invalid-member', "You can't start a chat with yourself.");
        if (!(await findUser(otherUserId))) throw new ChatBackendError('not-found', 'User not found.');
        return directWith(me.id, otherUserId);
      },
      async createGroupConversation(title, memberIds) {
        const me = requireUser();
        const members = [...new Set([me.id, ...memberIds])];
        if (members.length < 3) {
          throw new ChatBackendError('invalid-member', 'Pick at least two people for a group.');
        }
        const name = title.trim();
        if (!name) throw new ChatBackendError('invalid-title', 'Give the group a name.');
        return insertConversation({ title: name.slice(0, 80), isGroup: true, memberIds: members, directKey: null });
      },
    },

    messages: {
      async listMessages(conversationId, { before, limit }) {
        const me = requireUser();
        if (!(await isMember(conversationId, me.id))) throw new ChatBackendError('forbidden', 'Not a member of this chat.');
        const rows = await db.all<MessageRow>(
          `SELECT * FROM messages WHERE conversation_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [conversationId, before ?? Number.MAX_SAFE_INTEGER, limit],
        );
        return rows.map(toMessage);
      },
      subscribeToMessages(conversationId, onMessage) {
        const off = messageEvents.on((message) => {
          if (message.conversationId === conversationId) onMessage(message);
        });
        return once(off);
      },
      async sendMessage({ conversationId, text, clientId }) {
        const me = requireUser();
        const body = cleanMessageText(text);
        const conversation = await loadConversation(conversationId);
        if (!conversation || !conversation.memberIds.includes(me.id)) {
          throw new ChatBackendError('forbidden', 'Not a member of this chat.');
        }
        const message = await insertMessage(conversationId, me.id, body, clientId);
        const bot = await botRow();
        if (bot) scheduleBotReply(conversation, body, bot.id);
        return message;
      },
    },

    async dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      authEvents.clear();
      messageEvents.clear();
      conversationEvents.clear();
    },
  };
}
