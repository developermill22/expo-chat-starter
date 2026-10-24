# Expo Chat Starter

A production-shaped chat app for **Expo SDK 58 / React Native 0.88** with **pluggable backends**. The UI talks to one `ChatBackend` interface. Firebase, Supabase, Appwrite and on-device SQLite are adapters behind it, so switching providers is an env change.

**Features:** email/password auth with persisted sessions, user search, 1:1 and group chats, realtime messages, optimistic sending with retry, paginated history, light and dark mode, and a backend switcher for development builds.

**Stack:** Expo Router (typed routes, `Stack.Protected` auth guards), TypeScript strict, Zustand (session), TanStack Query (server cache + realtime merge), expo-sqlite, expo-crypto.

---

## Quick start (no backend needed)

```bash
npm install
cp .env.example .env        # EXPO_PUBLIC_CHAT_BACKEND=sqlite
npx expo start
```

Local SQLite seeds two demo accounts (`alex@demo.local` / `priya@demo.local`, password `password123`) and an **Echo Bot** that replies to you. Sign in as one person, send a message, then sign out and sign in as the other to see it arrive.

> The local backend works offline on a single device. It's meant for UI work, demos and offline prototypes. It is not a real auth server.

---

## How it fits together

```
src/app/ (screens)  ──►  src/hooks/chat.ts (TanStack Query + realtime merge)
                                   │
                         src/store/session.ts (Zustand: active backend + user)
                                   │
                         src/backends/types.ts  ◄── the ChatBackend contract
             ┌───────────────┬────────────┴───┬─────────────────┐
         sqlite/          firebase/       supabase/          appwrite/
```

- **`src/backends/types.ts`** is the only contract the UI knows: `auth`, `users`, `conversations`, `messages`, `dispose()`. Timestamps are epoch ms, message pages are newest-first, and `subscribe*` returns an unsubscribe function.
- **`src/backends/registry.ts`** lists the backends. Each adapter is loaded with a dynamic `import()`, so only the selected SDK is initialised.
- **`src/providers/backend.ts`** loads the backend, restores the session, wires auth events into Zustand, and clears the query cache on switch or sign-out.
- **`src/hooks/chat.ts`** streams conversations into the query cache (one subscription for the whole signed-in area). It also merges realtime messages into an infinite query and handles optimistic sends. Bubbles are reconciled by a `clientId` generated on the device.

### Switching backends

- **Build time:** set `EXPO_PUBLIC_CHAT_BACKEND` in `.env`.
- **At runtime (dev builds only):** open Settings → Backend. Only providers whose env vars are filled in can be selected. Release builds always use the env value.

---

## Backend setup

### Firebase (Auth + Firestore)

1. Create a project. Enable **Authentication → Email/Password** and create a **Firestore** database.
2. Add a **Web app** and copy its config into the `EXPO_PUBLIC_FIREBASE_*` vars.
3. Deploy the rules and the composite index:
   ```bash
   cd backend/firebase
   npx firebase-tools login
   npx firebase-tools deploy --only firestore --project <your-project-id>
   ```

**Data model:** `users/{uid}`, `conversations/{id}` (with `memberIds[]`), and `conversations/{id}/messages/{id}`. Direct chats use the deterministic id `dm_<uidA>_<uidB>`. The rules enforce membership, sender identity, message length and server timestamps. They only let members change the `lastMessage` preview.

Works in **Expo Go**. Uses the Firebase JS SDK with AsyncStorage persistence.

### Supabase (Auth + Postgres + Realtime)

1. Create a project and copy the URL and **publishable/anon** key into `.env`.
2. Open **SQL Editor**, paste `backend/supabase/schema.sql` and run it. It's safe to re-run.
3. For a fast dev loop, turn off **Auth → Providers → Email → Confirm email**. If you keep it on, the app tells new users to confirm their email and then sign in.

**What the schema sets up:**
- `profiles` (auto-created by a trigger on sign-up)
- `conversations`, `conversation_members` and `messages`, all with **RLS**
- `SECURITY DEFINER` RPCs for creating direct and group chats, so clients can never add themselves to someone else's chat
- a trigger that keeps the conversation preview in sync
- a `security_invoker` summary view
- realtime publication

Works in **Expo Go**.

### Appwrite (Account + TablesDB + Realtime + Function)

1. Create a project. Under **Overview → Add platform**, add an Android and/or Apple app with the bundle id / package from `app.json` (default `com.example.chatstarter`).
2. Fill in the `EXPO_PUBLIC_APPWRITE_*` vars.
3. Create a **server API key** with scopes for databases, tables, columns, indexes and functions. Put it in `APPWRITE_API_KEY` (no `EXPO_PUBLIC_` prefix), then run:
   ```bash
   npm run appwrite:setup
   ```
   This creates the `chat` database, the `profiles` / `conversations` / `messages` tables and their indexes. It also deploys the `chat-conversations` Function.

**Privacy model:** every conversation has an Appwrite **Team** with the same id. Rows are readable only by that team. Client SDKs can't add other users to a team, so creating a chat goes through the Function. Sending messages happens directly from the client and is scoped to the team.

`react-native-appwrite` ships native code, so Appwrite needs a **development build**: `npx expo run:android` / `run:ios`, or `eas build --profile development`. It doesn't work in Expo Go.

---

## Adding another backend

1. Create `src/backends/<name>/index.ts` that exports `create<Name>Backend(config): Promise<ChatBackend>`.
2. Add its id to `BackendId` in `types.ts`, its env vars to `config.ts`, and an entry to `BACKENDS` / `BACKEND_ORDER` in `registry.ts`.
3. Use the scenarios in `tests/sqlite-backend.test.ts` as the behavioural spec:
   - direct chats are idempotent from either side
   - non-members can't read or write
   - pages don't skip messages
   - your own sends are echoed to subscribers

To drop a backend you don't need, delete its folder and its registry entry, then uninstall its SDK.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Expo dev server |
| `npm test` | Runs the SQLite adapter test suite in Node (built-in `node:sqlite`, no simulator) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run appwrite:setup` | Provisions Appwrite (see above) |

---

## Project layout

```
src/
  app/                  Expo Router screens
    _layout.tsx         providers, boot, auth guards
    sign-in.tsx  sign-up.tsx
    (app)/              signed-in area: index (chats), chat/[id], new, settings
  backends/             the contract + one folder per provider
  components/           ui.tsx (primitives), chat.tsx (rows, bubbles, composer), AuthForm.tsx
  hooks/chat.ts         data hooks
  providers/backend.ts  backend lifecycle
  store/session.ts      Zustand session store
  theme/                semantic light/dark palette
backend/
  firebase/             firestore.rules, firestore.indexes.json, firebase.json
  supabase/schema.sql
  appwrite/functions/chat-conversations/
scripts/appwrite-setup.mjs
tests/sqlite-backend.test.ts
```

---

## Notes and limits

- **Web:** works with the SQLite backend. `metro.config.js` adds the `.wasm` asset and the COOP/COEP headers that expo-sqlite needs. Your production web host must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
- **Profiles are visible to every signed-in user, emails included.** That's how people find each other. Remove `email` from profiles if that doesn't suit your app.
- **Appwrite trusts the client on `senderId`.** Members of a conversation can technically write rows claiming another member's `senderId`. Move message creation into the Function if you need that guaranteed. Firebase and Supabase enforce sender identity on the server.
- **Not included yet:** typing indicators, read receipts, attachments and push notifications. These are natural next additions to the `ChatBackend` interface.
