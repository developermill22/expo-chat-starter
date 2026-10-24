import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type RealtimeChannel, type User } from '@supabase/supabase-js';
import { AppState, type NativeEventSubscription } from 'react-native';

import type { SupabaseConfig } from '../config';
import {
  assertValidEmail,
  assertValidPassword,
  cleanDisplayName,
  cleanMessageText,
  normalizeEmail,
  once,
} from '../shared';
import { ChatBackendError, toError, type ChatBackend, type ChatUser, type Conversation, type Message } from '../types';
import type { ConversationRow, Database, MessageRow } from './database.types';

/**
 * Supabase adapter: Supabase Auth (email/password) + Postgres + Realtime.
 *
 * Run backend/supabase/schema.sql first. All access control lives in Row
 * Level Security; conversations are created through SECURITY DEFINER RPCs so
 * a client can never add itself to someone else's chat.
 */

type ProfileRow = Database['public']['Tables']['profiles']['Row'];
type SummaryRow = Database['public']['Views']['conversation_summaries']['Row'];

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Date.now());

const toUser = (row: ProfileRow): ChatUser => ({
  id: row.id,
  displayName: row.display_name,
  email: row.email,
  avatarUrl: row.avatar_url,
});

const toConversation = (row: SummaryRow): Conversation => ({
  id: row.id,
  title: row.title,
  isGroup: row.is_group,
  memberIds: row.member_ids ?? [],
  createdAt: ms(row.created_at),
  updatedAt: ms(row.updated_at),
  lastMessage:
    row.last_message_text !== null && row.last_message_sender_id !== null
      ? { text: row.last_message_text, senderId: row.last_message_sender_id, createdAt: ms(row.last_message_at) }
      : null,
});

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  text: row.text,
  createdAt: ms(row.created_at),
  clientId: row.client_id,
});

function fallbackUser(user: User): ChatUser {
  const meta = user.user_metadata as { display_name?: unknown } | undefined;
  return {
    id: user.id,
    displayName: typeof meta?.display_name === 'string' ? meta.display_name : (user.email?.split('@')[0] ?? 'Unknown'),
    email: user.email ?? null,
    avatarUrl: null,
  };
}

function mapError(error: unknown): Error {
  if (error instanceof ChatBackendError) return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'supabase-error';
    const friendly: Record<string, string> = {
      invalid_credentials: 'Email or password is incorrect.',
      user_already_exists: 'An account with this email already exists.',
      email_not_confirmed: 'Confirm your email address, then sign in.',
      weak_password: 'Password is too weak.',
      PGRST205: 'Chat tables not found. Run backend/supabase/schema.sql in your project.',
      PGRST202: 'Chat functions not found. Run backend/supabase/schema.sql in your project.',
    };
    return new ChatBackendError(code, friendly[code] ?? error.message);
  }
  return toError(error);
}

/** Supabase returns `{ data, error }`; turn it into throw-on-error. */
type Result = { data: unknown; error: unknown };

function unwrapMaybe<R extends Result>(result: R): NonNullable<R['data']> | null {
  if (result.error) throw mapError(result.error);
  return (result.data ?? null) as NonNullable<R['data']> | null;
}

function unwrap<R extends Result>(result: R): NonNullable<R['data']> {
  const data = unwrapMaybe(result);
  if (data === null) throw new ChatBackendError('empty-response', 'The server returned no data.');
  return data;
}

function throwIfError(result: { error: unknown }): void {
  if (result.error) throw mapError(result.error);
}

export async function createSupabaseBackend(config: SupabaseConfig): Promise<ChatBackend> {
  const supabase = createClient<Database>(config.url, config.key, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  // Refresh tokens only while the app is foregrounded (recommended for React Native).
  const appState: NativeEventSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
  if (AppState.currentState === 'active') void supabase.auth.startAutoRefresh();

  const channels = new Set<RealtimeChannel>();

  async function requireUid(): Promise<string> {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user.id;
    if (!uid) throw new ChatBackendError('not-signed-in', 'You need to sign in first.');
    return uid;
  }

  async function loadProfile(user: User): Promise<ChatUser> {
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return data ? toUser(data) : fallbackUser(user);
  }

  async function loadConversation(id: string): Promise<Conversation | null> {
    const row = unwrapMaybe(await supabase.from('conversation_summaries').select('*').eq('id', id).maybeSingle());
    return row ? toConversation(row) : null;
  }

  function track(channel: RealtimeChannel) {
    channels.add(channel);
    return once(() => {
      channels.delete(channel);
      void supabase.removeChannel(channel);
    });
  }

  return {
    id: 'supabase',
    label: 'Supabase',
    capabilities: { realtime: true, multiDevice: true },

    auth: {
      async getCurrentUser() {
        const { data } = await supabase.auth.getSession();
        return data.session ? loadProfile(data.session.user) : null;
      },
      onAuthStateChanged(listener) {
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === 'INITIAL_SESSION') return; // handled by getCurrentUser()
          if (!session) return listener(null);
          if (event === 'TOKEN_REFRESHED') return;
          // Never await Supabase calls inside this callback (it can deadlock the auth lock).
          setTimeout(() => {
            loadProfile(session.user).then(listener, () => listener(fallbackUser(session.user)));
          }, 0);
        });
        return once(() => data.subscription.unsubscribe());
      },
      async signIn(email, password) {
        const data = unwrap(await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password }));
        if (!data.user) throw new ChatBackendError('invalid-credentials', 'Email or password is incorrect.');
        return loadProfile(data.user);
      },
      async signUp({ email, password, displayName }) {
        const normalized = normalizeEmail(email);
        assertValidEmail(normalized);
        assertValidPassword(password);
        const name = cleanDisplayName(displayName);
        const data = unwrap(
          await supabase.auth.signUp({ email: normalized, password, options: { data: { display_name: name } } }),
        );
        if (!data.session || !data.user) {
          // Project has "Confirm email" enabled.
          throw new ChatBackendError('confirm-email', 'Check your inbox to confirm your email, then sign in.');
        }
        return loadProfile(data.user);
      },
      async signOut() {
        throwIfError(await supabase.auth.signOut());
      },
      async updateProfile(patch) {
        const uid = await requireUid();
        const update: Database['public']['Tables']['profiles']['Update'] = {};
        if (patch.displayName !== undefined) update.display_name = cleanDisplayName(patch.displayName);
        if (patch.avatarUrl !== undefined) update.avatar_url = patch.avatarUrl;
        const row = unwrap(await supabase.from('profiles').update(update).eq('id', uid).select('*').single());
        return toUser(row);
      },
    },

    users: {
      async searchUsers(text) {
        const uid = await requireUid();
        const q = text.trim().replace(/[%_,()]/g, '');
        let request = supabase.from('profiles').select('*').neq('id', uid).order('display_name').limit(25);
        if (q) request = request.or(`display_name.ilike.${q}%,email.ilike.${q}%`);
        return unwrap(await request).map(toUser);
      },
      async getUsers(ids) {
        if (ids.length === 0) return [];
        return unwrap(await supabase.from('profiles').select('*').in('id', ids)).map(toUser);
      },
    },

    conversations: {
      subscribeToConversations(onChange, onError) {
        let active = true;
        const load = async () => {
          try {
            const rows = unwrap(
              await supabase.from('conversation_summaries').select('*').order('updated_at', { ascending: false }),
            );
            if (active) onChange(rows.map(toConversation));
          } catch (error) {
            if (active) onError?.(mapError(error));
          }
        };
        void load();
        // RLS filters these events to chats the user belongs to. Any change
        // (new chat, new message bumping updated_at, being added to a group)
        // triggers a cheap refetch of the summary view.
        const channel = supabase
          .channel(`conversations:${Math.random().toString(36).slice(2)}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => void load())
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members' }, () => void load())
          .subscribe((status, error) => {
            if (status === 'CHANNEL_ERROR' && error) onError?.(mapError(error));
          });
        const off = track(channel);
        return once(() => {
          active = false;
          off();
        });
      },
      getConversation: (id) => loadConversation(id),
      async getOrCreateDirectConversation(otherUserId) {
        const id = unwrap(await supabase.rpc('get_or_create_direct_conversation', { other_user_id: otherUserId }));
        const conversation = await loadConversation(id);
        if (!conversation) throw new ChatBackendError('not-found', 'Could not open the conversation.');
        return conversation;
      },
      async createGroupConversation(title, memberIds) {
        const id = unwrap(await supabase.rpc('create_group_conversation', { group_title: title, member_ids: memberIds }));
        const conversation = await loadConversation(id);
        if (!conversation) throw new ChatBackendError('not-found', 'Could not create the group.');
        return conversation;
      },
    },

    messages: {
      async listMessages(conversationId, { before, limit }) {
        let request = supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (before !== undefined) request = request.lt('created_at', new Date(before).toISOString());
        return unwrap(await request).map(toMessage);
      },
      subscribeToMessages(conversationId, onMessage, onError) {
        const channel = supabase
          .channel(`messages:${conversationId}:${Math.random().toString(36).slice(2)}`)
          .on<MessageRow>(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
            (payload) => onMessage(toMessage(payload.new as MessageRow)),
          )
          .subscribe((status, error) => {
            if (status === 'CHANNEL_ERROR' && error) onError?.(mapError(error));
          });
        return track(channel);
      },
      async sendMessage({ conversationId, text, clientId }) {
        const body = cleanMessageText(text);
        const row = unwrap(
          await supabase
            .from('messages')
            .insert({ conversation_id: conversationId, text: body, client_id: clientId })
            .select('*')
            .single(),
        );
        return toMessage(row);
      },
    },

    async dispose() {
      appState.remove();
      await supabase.auth.stopAutoRefresh();
      await Promise.all([...channels].map((c) => supabase.removeChannel(c)));
      channels.clear();
    },
  };
}
