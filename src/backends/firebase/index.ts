import AsyncStorage from '@react-native-async-storage/async-storage';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  // Only exported from the React Native build of firebase/auth, which Metro
  // and TypeScript pick via the "react-native" export condition.
  getReactNativePersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  Timestamp,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type QueryConstraint,
} from 'firebase/firestore';

import type { FirebaseConfig } from '../config';
import {
  assertValidEmail,
  assertValidPassword,
  cleanDisplayName,
  cleanMessageText,
  normalizeEmail,
  once,
} from '../shared';
import { ChatBackendError, toError, type ChatBackend, type ChatUser, type Conversation, type Message } from '../types';

/**
 * Firebase adapter: Firebase Auth (email/password) + Cloud Firestore.
 *
 * Data layout (rules + indexes in /backend/firebase):
 *   users/{uid}                          profile, readable by signed-in users
 *   conversations/{id}                   memberIds[], isGroup, title, lastMessage, updatedAt
 *   conversations/{id}/messages/{msgId}  senderId, text, clientId, createdAt
 *
 * Direct chats use a deterministic id (dm_<uidA>_<uidB>, sorted) so both
 * people always land in the same document.
 */

const APP_NAME = 'chat-starter';
const MESSAGE_STREAM_WINDOW = 25;

interface UserDoc {
  displayName?: string;
  email?: string | null;
  avatarUrl?: string | null;
}

function millis(value: unknown, fallback = Date.now()): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number') return value;
  return fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toChatUser(id: string, data: UserDoc | undefined, fallbackEmail: string | null = null): ChatUser {
  const email = data?.email ?? fallbackEmail;
  return {
    id,
    displayName: data?.displayName || email?.split('@')[0] || 'Unknown',
    email,
    avatarUrl: data?.avatarUrl ?? null,
  };
}

function fromAuthUser(user: User): ChatUser {
  return toChatUser(user.uid, { displayName: user.displayName ?? undefined, email: user.email, avatarUrl: user.photoURL });
}

function toConversation(snap: DocumentSnapshot<DocumentData>): Conversation | null {
  const data = snap.data({ serverTimestamps: 'estimate' });
  if (!data) return null;
  const last = data.lastMessage as Record<string, unknown> | null | undefined;
  return {
    id: snap.id,
    title: str(data.title),
    isGroup: data.isGroup === true,
    memberIds: Array.isArray(data.memberIds) ? data.memberIds.filter((m): m is string => typeof m === 'string') : [],
    createdAt: millis(data.createdAt),
    updatedAt: millis(data.updatedAt),
    lastMessage:
      last && typeof last.text === 'string' && typeof last.senderId === 'string'
        ? { text: last.text, senderId: last.senderId, createdAt: millis(last.createdAt) }
        : null,
  };
}

function toMessage(conversationId: string, snap: DocumentSnapshot<DocumentData>): Message | null {
  const data = snap.data({ serverTimestamps: 'estimate' });
  if (!data || typeof data.text !== 'string' || typeof data.senderId !== 'string') return null;
  return {
    id: snap.id,
    conversationId,
    senderId: data.senderId,
    text: data.text,
    createdAt: millis(data.createdAt),
    clientId: str(data.clientId),
  };
}

const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password is too weak.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Try again in a minute.',
  'auth/network-request-failed': 'Network error. Check your connection.',
  'permission-denied': 'You do not have access to this. Did you deploy firestore.rules?',
  'failed-precondition': 'Firestore needs an index. Deploy backend/firebase/firestore.indexes.json.',
};

function mapError(error: unknown): Error {
  if (error instanceof ChatBackendError) return error;
  if (error instanceof FirebaseError) {
    return new ChatBackendError(error.code, AUTH_MESSAGES[error.code] ?? error.message);
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

function initAuth(app: FirebaseApp): Auth {
  try {
    return initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    // Already initialised (fast refresh).
    return getAuth(app);
  }
}

export async function createFirebaseBackend(config: FirebaseConfig): Promise<ChatBackend> {
  const app = getApps().find((a) => a.name === APP_NAME) ?? initializeApp(config, APP_NAME);
  const auth = initAuth(app);
  // Long-polling auto-detection keeps Firestore streams reliable on Android emulators and some proxies.
  let db: Firestore;
  try {
    db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch {
    const { getFirestore } = await import('firebase/firestore');
    db = getFirestore(app);
  }
  await auth.authStateReady();

  const requireUid = () => {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new ChatBackendError('not-signed-in', 'You need to sign in first.');
    return uid;
  };

  async function loadProfile(user: User): Promise<ChatUser> {
    const snap = await getDoc(doc(db, 'users', user.uid));
    return snap.exists() ? toChatUser(user.uid, snap.data() as UserDoc, user.email) : fromAuthUser(user);
  }

  async function writeProfile(uid: string, profile: { displayName: string; email: string | null; avatarUrl: string | null }) {
    await setDoc(
      doc(db, 'users', uid),
      { ...profile, displayNameLower: profile.displayName.toLowerCase(), updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  const conversationRef = (id: string) => doc(db, 'conversations', id);
  const messagesRef = (conversationId: string) => collection(db, 'conversations', conversationId, 'messages');

  return {
    id: 'firebase',
    label: 'Firebase',
    capabilities: { realtime: true, multiDevice: true },

    auth: {
      async getCurrentUser() {
        return auth.currentUser ? guard(() => loadProfile(auth.currentUser as User)) : null;
      },
      onAuthStateChanged(listener) {
        return onAuthStateChanged(auth, (user) => {
          if (!user) return listener(null);
          loadProfile(user).then(listener, () => listener(fromAuthUser(user)));
        });
      },
      signIn: (email, password) =>
        guard(async () => {
          const { user } = await signInWithEmailAndPassword(auth, normalizeEmail(email), password);
          return loadProfile(user);
        }),
      signUp: ({ email, password, displayName }) =>
        guard(async () => {
          const normalized = normalizeEmail(email);
          assertValidEmail(normalized);
          assertValidPassword(password);
          const name = cleanDisplayName(displayName);
          const { user } = await createUserWithEmailAndPassword(auth, normalized, password);
          await updateProfile(user, { displayName: name });
          await writeProfile(user.uid, { displayName: name, email: normalized, avatarUrl: null });
          return toChatUser(user.uid, { displayName: name, email: normalized, avatarUrl: null });
        }),
      signOut: () => guard(() => signOut(auth)),
      updateProfile: (patch) =>
        guard(async () => {
          const user = auth.currentUser;
          if (!user) throw new ChatBackendError('not-signed-in', 'You need to sign in first.');
          const current = await loadProfile(user);
          const displayName = patch.displayName !== undefined ? cleanDisplayName(patch.displayName) : current.displayName;
          const avatarUrl = patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl;
          await updateProfile(user, { displayName, photoURL: avatarUrl });
          await writeProfile(user.uid, { displayName, email: user.email, avatarUrl });
          return { ...current, displayName, avatarUrl };
        }),
    },

    users: {
      searchUsers: (text) =>
        guard(async () => {
          const uid = requireUid();
          const q = text.trim().toLowerCase();
          const constraints: QueryConstraint[] = q.includes('@')
            ? [where('email', '==', q), limit(25)]
            : q
              ? [where('displayNameLower', '>=', q), where('displayNameLower', '<=', `${q}`), orderBy('displayNameLower'), limit(25)]
              : [orderBy('displayNameLower'), limit(25)];
          const snap = await getDocs(query(collection(db, 'users'), ...constraints));
          return snap.docs.filter((d) => d.id !== uid).map((d) => toChatUser(d.id, d.data() as UserDoc));
        }),
      getUsers: (ids) =>
        guard(async () => {
          const unique = [...new Set(ids)];
          const chunks: string[][] = [];
          // Firestore "in" queries accept at most 30 values.
          for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
          const snaps = await Promise.all(
            chunks.map((chunk) => getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)))),
          );
          return snaps.flatMap((s) => s.docs.map((d) => toChatUser(d.id, d.data() as UserDoc)));
        }),
    },

    conversations: {
      subscribeToConversations(onChange, onError) {
        const uid = requireUid();
        const q = query(collection(db, 'conversations'), where('memberIds', 'array-contains', uid), orderBy('updatedAt', 'desc'));
        const off = onSnapshot(
          q,
          (snap) => onChange(snap.docs.map(toConversation).filter((c): c is Conversation => c !== null)),
          (error) => onError?.(mapError(error)),
        );
        return once(off);
      },
      getConversation: (id) =>
        guard(async () => {
          requireUid();
          try {
            return toConversation(await getDoc(conversationRef(id)));
          } catch (error) {
            if (error instanceof FirebaseError && error.code === 'permission-denied') return null;
            throw error;
          }
        }),
      getOrCreateDirectConversation: (otherUserId) =>
        guard(async () => {
          const uid = requireUid();
          if (otherUserId === uid) throw new ChatBackendError('invalid-member', "You can't start a chat with yourself.");
          const memberIds = [uid, otherUserId].sort();
          const ref = conversationRef(`dm_${memberIds.join('_')}`);
          // Transaction so two people tapping "message" at once can't clobber each other.
          await runTransaction(db, async (tx) => {
            const existing = await tx.get(ref);
            if (existing.exists()) return;
            tx.set(ref, {
              memberIds,
              isGroup: false,
              title: null,
              lastMessage: null,
              createdBy: uid,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          });
          const conversation = toConversation(await getDoc(ref));
          if (!conversation) throw new ChatBackendError('not-found', 'Could not open the conversation.');
          return conversation;
        }),
      createGroupConversation: (title, memberIds) =>
        guard(async () => {
          const uid = requireUid();
          const members = [...new Set([uid, ...memberIds])];
          if (members.length < 3) throw new ChatBackendError('invalid-member', 'Pick at least two people for a group.');
          const name = title.trim().slice(0, 80);
          if (!name) throw new ChatBackendError('invalid-title', 'Give the group a name.');
          const ref = doc(collection(db, 'conversations'));
          await setDoc(ref, {
            memberIds: members,
            isGroup: true,
            title: name,
            lastMessage: null,
            createdBy: uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          const conversation = toConversation(await getDoc(ref));
          if (!conversation) throw new ChatBackendError('not-found', 'Could not create the group.');
          return conversation;
        }),
    },

    messages: {
      listMessages: (conversationId, { before, limit: pageSize }) =>
        guard(async () => {
          requireUid();
          const constraints: QueryConstraint[] = [orderBy('createdAt', 'desc'), limit(pageSize)];
          if (before !== undefined) constraints.unshift(where('createdAt', '<', Timestamp.fromMillis(before)));
          const snap = await getDocs(query(messagesRef(conversationId), ...constraints));
          return snap.docs.map((d) => toMessage(conversationId, d)).filter((m): m is Message => m !== null);
        }),
      subscribeToMessages(conversationId, onMessage, onError) {
        requireUid();
        // Listen to the newest N messages instead of "createdAt > now" so device
        // clock skew can never hide a message. The UI de-duplicates by id.
        const q = query(messagesRef(conversationId), orderBy('createdAt', 'desc'), limit(MESSAGE_STREAM_WINDOW));
        const off = onSnapshot(
          q,
          (snap) => {
            for (const change of snap.docChanges()) {
              if (change.type === 'removed') continue;
              const message = toMessage(conversationId, change.doc);
              if (message) onMessage(message);
            }
          },
          (error) => onError?.(mapError(error)),
        );
        return once(off);
      },
      sendMessage: ({ conversationId, text, clientId }) =>
        guard(async () => {
          const uid = requireUid();
          const body = cleanMessageText(text);
          const ref = doc(messagesRef(conversationId));
          const batch = writeBatch(db);
          batch.set(ref, { senderId: uid, text: body, clientId, createdAt: serverTimestamp() });
          batch.update(conversationRef(conversationId), {
            lastMessage: { text: body.slice(0, 200), senderId: uid, createdAt: serverTimestamp() },
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
          return { id: ref.id, conversationId, senderId: uid, text: body, clientId, createdAt: Date.now() };
        }),
    },

    async dispose() {
      await deleteApp(app).catch(() => undefined);
    },
  };
}
