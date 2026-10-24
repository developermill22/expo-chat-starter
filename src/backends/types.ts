/**
 * The contract every chat backend implements.
 *
 * The UI only ever talks to `ChatBackend`. Firebase, Supabase, Appwrite and
 * local SQLite are adapters behind it, so swapping providers is a config
 * change, not a rewrite. To add a new provider (PocketBase, Convex, your own
 * REST API...), implement this interface and register it in `./registry.ts`.
 *
 * Conventions shared by all adapters:
 * - Timestamps are epoch milliseconds (number), never provider-specific types.
 * - IDs are opaque strings.
 * - `subscribe*` methods return an `Unsubscribe` function and must be safe to
 *   call more than once.
 * - Message pages are returned NEWEST FIRST (ready for an inverted FlatList).
 */

export type BackendId = 'firebase' | 'supabase' | 'appwrite' | 'sqlite';

export type Unsubscribe = () => void;

export interface ChatUser {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface MessagePreview {
  text: string;
  senderId: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  /** Set for group chats; direct chats derive their title from the other member. */
  title: string | null;
  isGroup: boolean;
  memberIds: string[];
  lastMessage: MessagePreview | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: number;
  /**
   * Generated on the device before sending. Lets the UI reconcile its
   * optimistic bubble with the copy that comes back over realtime.
   */
  clientId: string | null;
}

export interface SendMessageInput {
  conversationId: string;
  text: string;
  clientId: string;
}

export interface MessagePageParams {
  /** Return messages strictly older than this timestamp. Omit for the latest page. */
  before?: number;
  limit: number;
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
}

export interface BackendCapabilities {
  /** Pushes changes to other devices in real time. */
  realtime: boolean;
  /** Users on different devices can talk to each other. False for local SQLite. */
  multiDevice: boolean;
}

export interface AuthApi {
  /** Resolve the persisted session, if any. Called once on startup. */
  getCurrentUser(): Promise<ChatUser | null>;
  /** Fires on sign-in, sign-out and token-expiry. */
  onAuthStateChanged(listener: (user: ChatUser | null) => void): Unsubscribe;
  signIn(email: string, password: string): Promise<ChatUser>;
  signUp(input: SignUpInput): Promise<ChatUser>;
  signOut(): Promise<void>;
  updateProfile(patch: { displayName?: string; avatarUrl?: string | null }): Promise<ChatUser>;
}

export interface UsersApi {
  /** Find people to start a chat with. Excludes the current user. */
  searchUsers(query: string): Promise<ChatUser[]>;
  getUsers(ids: string[]): Promise<ChatUser[]>;
}

export interface ConversationsApi {
  /** Live list of the current user's conversations, most recent first. */
  subscribeToConversations(
    onChange: (conversations: Conversation[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe;
  getConversation(id: string): Promise<Conversation | null>;
  /** Idempotent: returns the existing 1:1 chat when there is one. */
  getOrCreateDirectConversation(otherUserId: string): Promise<Conversation>;
  createGroupConversation(title: string, memberIds: string[]): Promise<Conversation>;
}

export interface MessagesApi {
  listMessages(conversationId: string, page: MessagePageParams): Promise<Message[]>;
  /** Emits each message created after subscribing, including the sender's own. */
  subscribeToMessages(
    conversationId: string,
    onMessage: (message: Message) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe;
  sendMessage(input: SendMessageInput): Promise<Message>;
}

export interface ChatBackend {
  readonly id: BackendId;
  readonly label: string;
  readonly capabilities: BackendCapabilities;
  readonly auth: AuthApi;
  readonly users: UsersApi;
  readonly conversations: ConversationsApi;
  readonly messages: MessagesApi;
  /** Tear down sockets/listeners. Called when switching backends. */
  dispose(): Promise<void>;
}

/** Thrown by adapters for errors the UI should show verbatim. */
export class ChatBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatBackendError';
    this.code = code;
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return new Error(value.message);
  }
  return new Error('Unknown error');
}
