/**
 * Appwrite Function: chat-conversations
 *
 * Creates direct and group conversations on behalf of the signed-in user.
 * Runs with the function's dynamic API key so it can:
 *   1. create a Team whose id equals the conversation id,
 *   2. add every member to that Team (server SDKs add members without an invite),
 *   3. create the conversation row readable/updatable only by that Team.
 *
 * Clients then send messages with Permission.read(Role.team(conversationId)).
 *
 * Request body (JSON):
 *   { "type": "direct", "otherUserId": "..." }
 *   { "type": "group", "title": "Weekend plans", "memberIds": ["...", "..."] }
 * Response: { "conversationId": "..." }
 */
import { createHash } from 'node:crypto';
import { AppwriteException, Client, ID, Permission, Role, TablesDB, Teams, Users } from 'node-appwrite';

const DATABASE_ID = process.env.CHAT_DATABASE_ID || 'chat';
const CONVERSATIONS = 'conversations';
const MAX_GROUP_SIZE = 50;

const isConflict = (e) => e instanceof AppwriteException && e.code === 409;
const isNotFound = (e) => e instanceof AppwriteException && e.code === 404;

export default async ({ req, res, error }) => {
  const callerId = req.headers['x-appwrite-user-id'];
  if (!callerId) return res.json({ error: 'Sign in first.' }, 401);

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const tables = new TablesDB(client);
  const teams = new Teams(client);
  const users = new Users(client);

  let body;
  try {
    body = typeof req.bodyJson === 'object' && req.bodyJson ? req.bodyJson : JSON.parse(req.bodyText || req.body || '{}');
  } catch {
    return res.json({ error: 'Invalid JSON body.' }, 400);
  }

  const assertUsersExist = async (ids) => {
    for (const id of ids) {
      try {
        await users.get({ userId: id });
      } catch (e) {
        if (isNotFound(e)) throw Object.assign(new Error('User not found.'), { status: 404 });
        throw e;
      }
    }
  };

  const createConversation = async ({ conversationId, memberIds, isGroup, title }) => {
    try {
      await teams.create({ teamId: conversationId, name: title || 'Direct chat' });
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
    for (const userId of memberIds) {
      try {
        await teams.createMembership({ teamId: conversationId, roles: ['member'], userId });
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    const team = Role.team(conversationId);
    try {
      await tables.createRow({
        databaseId: DATABASE_ID,
        tableId: CONVERSATIONS,
        rowId: conversationId,
        data: {
          title: title ?? null,
          isGroup,
          memberIds,
          lastMessageText: null,
          lastMessageSenderId: null,
          lastMessageAt: null,
        },
        permissions: [Permission.read(team), Permission.update(team)],
      });
    } catch (e) {
      if (!isConflict(e)) throw e; // another request created it first
    }
    return conversationId;
  };

  try {
    if (body.type === 'direct') {
      const otherUserId = String(body.otherUserId || '');
      if (!otherUserId || otherUserId === callerId) return res.json({ error: "You can't start a chat with yourself." }, 400);
      await assertUsersExist([otherUserId]);
      const memberIds = [callerId, otherUserId].sort();
      // Deterministic id (max 36 chars, must start with a letter or digit).
      const conversationId = 'dm' + createHash('sha256').update(memberIds.join(':')).digest('hex').slice(0, 34);
      try {
        await tables.getRow({ databaseId: DATABASE_ID, tableId: CONVERSATIONS, rowId: conversationId });
        return res.json({ conversationId });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await createConversation({ conversationId, memberIds, isGroup: false, title: null });
      return res.json({ conversationId });
    }

    if (body.type === 'group') {
      const title = String(body.title || '').trim().slice(0, 80);
      if (!title) return res.json({ error: 'Give the group a name.' }, 400);
      const requested = Array.isArray(body.memberIds) ? body.memberIds.map(String) : [];
      const memberIds = [...new Set([callerId, ...requested])];
      if (memberIds.length < 3) return res.json({ error: 'Pick at least two people for a group.' }, 400);
      if (memberIds.length > MAX_GROUP_SIZE) return res.json({ error: `Groups are limited to ${MAX_GROUP_SIZE} people.` }, 400);
      await assertUsersExist(memberIds.filter((id) => id !== callerId));
      const conversationId = await createConversation({ conversationId: ID.unique(), memberIds, isGroup: true, title });
      return res.json({ conversationId });
    }

    return res.json({ error: 'Unknown request type.' }, 400);
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) return res.json({ error: e.message }, e.status);
    error(e instanceof Error ? e.stack || e.message : String(e));
    return res.json({ error: 'Could not create the conversation.' }, 500);
  }
};
