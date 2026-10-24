import * as Crypto from 'expo-crypto';
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { sortNewestFirst } from '@/backends/shared';
import { toError, type ChatUser, type Conversation, type Message } from '@/backends/types';
import { queryKeys } from '@/lib/queryKeys';
import { useBackend, useCurrentUser } from '@/store/session';

export const MESSAGE_PAGE_SIZE = 30;

/** A message as the UI sees it: server messages plus optimistic ones. */
export type ChatMessage = Message & { pending?: 'sending' | 'failed' };
type MessagePages = InfiniteData<ChatMessage[], number | undefined>;

/** Bumps whenever the app returns to the foreground, to resync realtime streams. */
function useForegroundTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);
  return tick;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Error from the live conversation stream, readable by any screen. */
export const useConversationStreamError = create<{ error: Error | null }>(() => ({ error: null }));
const setError = (error: Error | null) => useConversationStreamError.setState({ error });

/**
 * Mount ONCE (in the signed-in layout). Streams the conversation list into
 * the query cache so every screen reads the same live data.
 */
export function useConversationsSubscription(): void {
  const backend = useBackend();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const foreground = useForegroundTick();

  useEffect(() => {
    const key = queryKeys.conversations(backend.id, me.id);
    const unsubscribe = backend.conversations.subscribeToConversations(
      (list) => {
        setError(null);
        queryClient.setQueryData<Conversation[]>(key, list);
      },
      setError,
    );
    return () => {
      unsubscribe();
      setError(null);
    };
  }, [backend, me.id, queryClient, foreground]);
}

export function useConversations() {
  const backend = useBackend();
  const me = useCurrentUser();
  // Data arrives through the subscription above; skipToken keeps this query passive.
  return useQuery<Conversation[]>({ queryKey: queryKeys.conversations(backend.id, me.id), queryFn: skipToken });
}

export function useConversation(id: string) {
  const backend = useBackend();
  const fromList = useConversations().data?.find((c) => c.id === id);
  const fetched = useQuery({
    queryKey: queryKeys.conversation(backend.id, id),
    queryFn: () => backend.conversations.getConversation(id),
    enabled: !fromList,
  });
  return { conversation: fromList ?? fetched.data ?? null, isLoading: !fromList && fetched.isLoading, error: fetched.error };
}

export function useStartDirectChat() {
  const backend = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (otherUserId: string) => backend.conversations.getOrCreateDirectConversation(otherUserId),
    onSuccess: (conversation) => queryClient.setQueryData(queryKeys.conversation(backend.id, conversation.id), conversation),
  });
}

export function useCreateGroup() {
  const backend = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ title, memberIds }: { title: string; memberIds: string[] }) =>
      backend.conversations.createGroupConversation(title, memberIds),
    onSuccess: (conversation) => queryClient.setQueryData(queryKeys.conversation(backend.id, conversation.id), conversation),
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Resolve user ids to profiles (cached). Always includes the current user. */
export function useUsers(ids: readonly string[]): ReadonlyMap<string, ChatUser> {
  const backend = useBackend();
  const me = useCurrentUser();
  const unique = useMemo(() => [...new Set(ids)].filter((id) => id !== me.id).sort(), [ids, me.id]);
  const query = useQuery({
    queryKey: queryKeys.users(backend.id, unique),
    queryFn: () => backend.users.getUsers(unique),
    enabled: unique.length > 0,
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });
  return useMemo(() => {
    const map = new Map<string, ChatUser>([[me.id, me]]);
    for (const user of query.data ?? []) map.set(user.id, user);
    return map;
  }, [query.data, me]);
}

export function useUserSearch(text: string) {
  const backend = useBackend();
  const [debounced, setDebounced] = useState(text.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  return useQuery({
    queryKey: queryKeys.userSearch(backend.id, debounced),
    queryFn: () => backend.users.searchUsers(debounced),
    placeholderData: (previous) => previous,
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Insert or replace a message (matched by id or clientId), keeping newest-first order. */
function upsertMessage(data: MessagePages | undefined, message: ChatMessage): MessagePages | undefined {
  if (!data) return data;
  let replaced = false;
  const pages = data.pages.map((page) => {
    let touched = false;
    const next = page.map((existing) => {
      const same = existing.id === message.id || (message.clientId !== null && existing.clientId === message.clientId);
      if (!same) return existing;
      replaced = touched = true;
      return message;
    });
    return touched ? sortNewestFirst(next) : next;
  });
  if (!replaced) pages[0] = sortNewestFirst([message, ...(pages[0] ?? [])]);
  return { ...data, pages };
}

function updateByClientId(data: MessagePages | undefined, clientId: string, patch: Partial<ChatMessage>) {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => page.map((m) => (m.clientId === clientId ? { ...m, ...patch } : m))),
  };
}

function removeByClientId(data: MessagePages | undefined, clientId: string) {
  if (!data) return data;
  return { ...data, pages: data.pages.map((page) => page.filter((m) => m.clientId !== clientId)) };
}

/** Paged history + live updates for one conversation. */
export function useMessages(conversationId: string) {
  const backend = useBackend();
  const queryClient = useQueryClient();
  const foreground = useForegroundTick();
  const key = queryKeys.messages(backend.id, conversationId);
  const [streamError, setStreamError] = useState<Error | null>(null);

  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }): Promise<ChatMessage[]> =>
      backend.messages.listMessages(conversationId, { before: pageParam, limit: MESSAGE_PAGE_SIZE }),
    getNextPageParam: (lastPage) => (lastPage.length < MESSAGE_PAGE_SIZE ? undefined : lastPage.at(-1)?.createdAt),
  });

  useEffect(() => {
    return backend.messages.subscribeToMessages(
      conversationId,
      (message) => {
        setStreamError(null);
        queryClient.setQueryData<MessagePages>(key, (old) => upsertMessage(old, message));
      },
      setStreamError,
    );
    // `key` is derived from these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, conversationId, queryClient, foreground]);

  // Pages can overlap by a message when timestamps tie; de-duplicate by id.
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatMessage[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const message of page) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        out.push(message);
      }
    }
    return out;
  }, [query.data]);

  return { ...query, messages, streamError };
}

/** Optimistic send: the bubble appears instantly, then is swapped for the server copy. */
export function useSendMessage(conversationId: string) {
  const backend = useBackend();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const key = queryKeys.messages(backend.id, conversationId);

  const mutation = useMutation({
    mutationFn: ({ text, clientId }: { text: string; clientId: string }) =>
      backend.messages.sendMessage({ conversationId, text, clientId }),
    onMutate: async ({ text, clientId }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const optimistic: ChatMessage = {
        id: `local:${clientId}`,
        conversationId,
        senderId: me.id,
        text: text.trim(),
        clientId,
        createdAt: Date.now(),
        pending: 'sending',
      };
      queryClient.setQueryData<MessagePages>(key, (old) => upsertMessage(old, optimistic));
    },
    onSuccess: (message) => queryClient.setQueryData<MessagePages>(key, (old) => upsertMessage(old, message)),
    onError: (_error, { clientId }) =>
      queryClient.setQueryData<MessagePages>(key, (old) => updateByClientId(old, clientId, { pending: 'failed' })),
  });

  return {
    send: (text: string) => mutation.mutate({ text, clientId: Crypto.randomUUID() }),
    retry: (message: ChatMessage) => {
      if (!message.clientId) return;
      queryClient.setQueryData<MessagePages>(key, (old) => removeByClientId(old, message.clientId as string));
      mutation.mutate({ text: message.text, clientId: message.clientId });
    },
    error: mutation.error ? toError(mutation.error) : null,
  };
}
