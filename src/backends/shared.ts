import { ChatBackendError, type Conversation, type Message, type Unsubscribe } from './types';

/** Helpers shared by every adapter. Kept free of React Native imports so tests can run in Node. */

export const MAX_MESSAGE_LENGTH = 4000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ChatBackendError('invalid-email', 'Enter a valid email address.');
  }
}

export function assertValidPassword(password: string): void {
  if (password.length < 8) {
    throw new ChatBackendError('weak-password', 'Password must be at least 8 characters.');
  }
}

export function cleanDisplayName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2) {
    throw new ChatBackendError('invalid-name', 'Display name must be at least 2 characters.');
  }
  return trimmed.slice(0, 60);
}

export function cleanMessageText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new ChatBackendError('empty-message', 'Message is empty.');
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ChatBackendError('message-too-long', `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return trimmed;
}

/** Stable key for a 1:1 chat, independent of who started it. */
export function directKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sortNewestFirst(list: Message[]): Message[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** Minimal typed event emitter used by adapters without native push (SQLite) and for auth fan-out. */
export function createEmitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value: T) {
      for (const listener of [...listeners]) listener(value);
    },
    on(listener: (value: T) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}

/** Wrap an unsubscribe so double-calls (React strict mode, fast refresh) are harmless. */
export function once(fn: () => void): Unsubscribe {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
