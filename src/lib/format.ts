import type { ChatUser, Conversation } from '@/backends/types';

const DAY = 24 * 60 * 60 * 1000;

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "14:05" today, "Tue" this week, "12 Oct" otherwise — for the conversation list. */
export function formatListTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return formatClock(ms);
  if (now - ms < 6 * DAY) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Separator label between days inside a chat. */
export function formatDayLabel(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === new Date(now - DAY).toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function conversationTitle(
  conversation: Conversation,
  meId: string,
  users: ReadonlyMap<string, ChatUser>,
): string {
  if (conversation.isGroup) return conversation.title ?? 'Group';
  const otherId = conversation.memberIds.find((id) => id !== meId);
  return (otherId && users.get(otherId)?.displayName) || 'Conversation';
}

export function otherMemberId(conversation: Conversation, meId: string): string | undefined {
  return conversation.memberIds.find((id) => id !== meId);
}
