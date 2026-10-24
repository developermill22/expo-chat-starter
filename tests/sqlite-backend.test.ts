/**
 * Behavioural tests for the local SQLite adapter, run in Node against the
 * built-in node:sqlite module (no simulator needed): `npm test`.
 *
 * They double as an executable spec of the ChatBackend contract — copy the
 * scenarios when you add a new adapter.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createSqliteBackendFromDriver, DEMO_ACCOUNTS, DEMO_PASSWORD, type SqlDriver, type SqlValue } from '../src/backends/sqlite/core';
import type { ChatBackend, Conversation, Message } from '../src/backends/types';

function nodeDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:');
  return {
    exec: async (sql) => {
      db.exec(sql);
    },
    run: async (sql, params: SqlValue[] = []) => {
      db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: SqlValue[] = []) => db.prepare(sql).all(...params) as T[],
    first: async <T,>(sql: string, params: SqlValue[] = []) => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    transaction: async (task) => {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function makeBackend(opts: { bot?: boolean; seed?: boolean } = {}) {
  return createSqliteBackendFromDriver({
    db: nodeDriver(),
    hash: async (s) => createHash('sha256').update(s).digest('hex'),
    randomId: randomUUID,
    botReplyDelayMs: opts.bot ? 5 : null,
    seedDemoData: opts.seed ?? false,
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function twoUsers(backend: ChatBackend) {
  const bob = await backend.auth.signUp({ email: 'bob@test.dev', password: 'password1', displayName: 'Bob' });
  await backend.auth.signOut();
  const alice = await backend.auth.signUp({ email: 'Alice@Test.dev', password: 'password1', displayName: '  Alice   Liddell ' });
  return { alice, bob };
}

describe('auth', () => {
  it('signs up, persists the session, signs out and back in', async () => {
    const backend = await makeBackend();
    const events: (string | null)[] = [];
    backend.auth.onAuthStateChanged((u) => events.push(u?.id ?? null));

    const user = await backend.auth.signUp({ email: 'Me@Example.com', password: 'hunter2hunter2', displayName: 'Me' });
    assert.equal(user.email, 'me@example.com');
    assert.deepEqual(await backend.auth.getCurrentUser(), user);

    await backend.auth.signOut();
    assert.equal(await backend.auth.getCurrentUser(), null);

    const again = await backend.auth.signIn('me@example.com', 'hunter2hunter2');
    assert.equal(again.id, user.id);
    assert.deepEqual(events, [user.id, null, user.id]);
  });

  it('rejects bad credentials, duplicates and weak input', async () => {
    const backend = await makeBackend();
    await backend.auth.signUp({ email: 'a@b.co', password: 'password1', displayName: 'Ann' });
    await assert.rejects(backend.auth.signIn('a@b.co', 'nope-nope'), { code: 'invalid-credentials' });
    await assert.rejects(backend.auth.signUp({ email: 'A@B.co', password: 'password1', displayName: 'Ann' }), { code: 'email-in-use' });
    await assert.rejects(backend.auth.signUp({ email: 'bad', password: 'password1', displayName: 'Ann' }), { code: 'invalid-email' });
    await assert.rejects(backend.auth.signUp({ email: 'c@d.co', password: 'short', displayName: 'Ann' }), { code: 'weak-password' });
  });

  it('updates the profile and normalises the display name', async () => {
    const backend = await makeBackend();
    const { alice } = await twoUsers(backend);
    assert.equal(alice.displayName, 'Alice Liddell');
    const updated = await backend.auth.updateProfile({ displayName: 'Alice L.' });
    assert.equal(updated.displayName, 'Alice L.');
    const [fetched] = await backend.users.getUsers([alice.id]);
    assert.equal(fetched?.displayName, 'Alice L.');
  });
});

describe('users', () => {
  it('searches by name or email and excludes the current user', async () => {
    const backend = await makeBackend();
    const { bob } = await twoUsers(backend);
    assert.deepEqual((await backend.users.searchUsers('bo')).map((u) => u.id), [bob.id]);
    assert.deepEqual((await backend.users.searchUsers('test.dev')).map((u) => u.id), [bob.id]);
    assert.equal((await backend.users.searchUsers('alice')).length, 0);
  });
});

describe('conversations', () => {
  it('creates one direct chat per pair, from either side', async () => {
    const backend = await makeBackend();
    const { alice, bob } = await twoUsers(backend);
    const first = await backend.conversations.getOrCreateDirectConversation(bob.id);
    const second = await backend.conversations.getOrCreateDirectConversation(bob.id);
    assert.equal(first.id, second.id);
    assert.deepEqual([...first.memberIds].sort(), [alice.id, bob.id].sort());

    await backend.auth.signOut();
    await backend.auth.signIn('bob@test.dev', 'password1');
    const fromBob = await backend.conversations.getOrCreateDirectConversation(alice.id);
    assert.equal(fromBob.id, first.id);
  });

  it('validates groups and hides chats from non-members', async () => {
    const backend = await makeBackend();
    const { bob } = await twoUsers(backend);
    await assert.rejects(backend.conversations.createGroupConversation('Team', [bob.id]), { code: 'invalid-member' });

    await backend.auth.signOut();
    const carol = await backend.auth.signUp({ email: 'carol@test.dev', password: 'password1', displayName: 'Carol' });
    await backend.auth.signOut();
    await backend.auth.signIn('alice@test.dev', 'password1');
    const group = await backend.conversations.createGroupConversation('  Team  ', [bob.id, carol.id]);
    assert.equal(group.title, 'Team');
    assert.equal(group.isGroup, true);
    assert.equal(group.memberIds.length, 3);

    const direct = await backend.conversations.getOrCreateDirectConversation(bob.id);
    await backend.auth.signOut();
    await backend.auth.signIn('carol@test.dev', 'password1');
    assert.equal(await backend.conversations.getConversation(direct.id), null);
    await assert.rejects(backend.messages.listMessages(direct.id, { limit: 10 }), { code: 'forbidden' });
    await assert.rejects(backend.messages.sendMessage({ conversationId: direct.id, text: 'hi', clientId: 'x' }), { code: 'forbidden' });
  });

  it('streams the conversation list, most recent first', async () => {
    const backend = await makeBackend();
    const { bob } = await twoUsers(backend);
    const snapshots: Conversation[][] = [];
    const off = backend.conversations.subscribeToConversations((list) => snapshots.push(list));

    const direct = await backend.conversations.getOrCreateDirectConversation(bob.id);
    await backend.auth.signOut();
    const carol = await backend.auth.signUp({ email: 'carol@test.dev', password: 'password1', displayName: 'Carol' });
    await backend.auth.signOut();
    await backend.auth.signIn('alice@test.dev', 'password1');
    const group = await backend.conversations.createGroupConversation('Team', [bob.id, carol.id]);
    await backend.messages.sendMessage({ conversationId: direct.id, text: 'bump', clientId: 'c1' });
    await wait(5);
    off();

    const last = snapshots.at(-1)!;
    assert.deepEqual(last.map((c) => c.id), [direct.id, group.id]);
    assert.equal(last[0]?.lastMessage?.text, 'bump');
  });
});

describe('messages', () => {
  it('delivers to subscribers and pages newest-first without gaps', async () => {
    const backend = await makeBackend();
    const { alice, bob } = await twoUsers(backend);
    const chat = await backend.conversations.getOrCreateDirectConversation(bob.id);
    const received: Message[] = [];
    const off = backend.messages.subscribeToMessages(chat.id, (m) => received.push(m));

    for (let i = 1; i <= 25; i++) {
      await backend.messages.sendMessage({ conversationId: chat.id, text: ` msg ${i} `, clientId: `c${i}` });
    }
    off();
    off(); // double unsubscribe is safe
    await backend.messages.sendMessage({ conversationId: chat.id, text: 'after unsubscribe', clientId: 'z' });

    assert.equal(received.length, 25);
    assert.equal(received[0]?.text, 'msg 1');
    assert.equal(received[0]?.clientId, 'c1');
    assert.equal(received[0]?.senderId, alice.id);

    const page1 = await backend.messages.listMessages(chat.id, { limit: 10 });
    const page2 = await backend.messages.listMessages(chat.id, { limit: 10, before: page1.at(-1)!.createdAt });
    const page3 = await backend.messages.listMessages(chat.id, { limit: 10, before: page2.at(-1)!.createdAt });
    const all = [...page1, ...page2, ...page3].map((m) => m.text);
    assert.equal(all.length, 26);
    assert.equal(all[0], 'after unsubscribe');
    assert.equal(all.at(-1), 'msg 1');
    assert.equal(new Set(all).size, 26);
  });

  it('rejects empty messages', async () => {
    const backend = await makeBackend();
    const { bob } = await twoUsers(backend);
    const chat = await backend.conversations.getOrCreateDirectConversation(bob.id);
    await assert.rejects(backend.messages.sendMessage({ conversationId: chat.id, text: '   ', clientId: 'x' }), { code: 'empty-message' });
  });
});

describe('demo data', () => {
  it('seeds demo accounts that can sign in and get echo replies', async () => {
    const backend = await makeBackend({ seed: true, bot: true });
    const account = DEMO_ACCOUNTS[0];
    await backend.auth.signIn(account.email, DEMO_PASSWORD);

    const lists: Conversation[][] = [];
    const off = backend.conversations.subscribeToConversations((l) => lists.push(l));
    await wait(5);
    const botChat = lists.at(-1)?.[0];
    if (!botChat) throw new Error('welcome chat with the bot should exist');

    const replies: Message[] = [];
    const offMessages = backend.messages.subscribeToMessages(botChat.id, (m) => replies.push(m));
    await backend.messages.sendMessage({ conversationId: botChat.id, text: 'ping', clientId: 'p' });
    await wait(30);
    off();
    offMessages();
    assert.deepEqual(replies.map((m) => m.text), ['ping', 'Echo: ping']);
    await backend.dispose();
  });
});
