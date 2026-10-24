import type { BackendId } from '@/backends/types';

/**
 * Every key starts with the backend id so caches from different providers
 * can never mix, even mid-switch.
 */
export const queryKeys = {
  conversations: (backend: BackendId, userId: string) => [backend, 'conversations', userId] as const,
  conversation: (backend: BackendId, id: string) => [backend, 'conversation', id] as const,
  messages: (backend: BackendId, conversationId: string) => [backend, 'messages', conversationId] as const,
  users: (backend: BackendId, ids: readonly string[]) => [backend, 'users', [...ids].sort().join(',')] as const,
  userSearch: (backend: BackendId, query: string) => [backend, 'user-search', query] as const,
};
