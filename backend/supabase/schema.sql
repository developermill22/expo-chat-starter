-- Chat starter schema for Supabase.
-- Run once in the SQL editor (Dashboard → SQL → New query), or save it as a
-- migration: supabase migration new chat && paste this file, then `supabase db push`.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  email text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text check (title is null or char_length(title) between 1 and 80),
  is_group boolean not null default false,
  -- "<uuidA>:<uuidB>" (sorted) for 1:1 chats, so each pair has exactly one.
  direct_key text unique,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_text text,
  last_message_sender_id uuid references auth.users (id),
  last_message_at timestamptz
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null default auth.uid() references auth.users (id),
  text text not null check (char_length(text) between 1 and 4000),
  client_id text,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index if not exists members_user_idx on public.conversation_members (user_id);
create index if not exists profiles_display_name_idx on public.profiles (lower(display_name) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so RLS policies can check membership without recursing
-- into conversation_members' own policy.
create or replace function public.is_conversation_member(conv uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = auth.uid()
  );
$$;

-- Create a profile row whenever someone signs up. The app passes
-- display_name in the sign-up metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  name text := left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 60);
begin
  -- Never let a short/missing name fail the sign-up itself.
  if name is null or char_length(name) < 2 then name := 'User'; end if;
  insert into public.profiles (id, display_name, email)
  values (new.id, name, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the conversation preview + ordering in sync with new messages.
create or replace function public.handle_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_text = left(new.text, 200),
         last_message_sender_id = new.sender_id,
         last_message_at = new.created_at,
         updated_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute function public.handle_new_message();

-- ---------------------------------------------------------------------------
-- RPCs (called by the app)
-- ---------------------------------------------------------------------------

create or replace function public.get_or_create_direct_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  key text;
  conv uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if other_user_id = me then raise exception 'You can''t start a chat with yourself.'; end if;
  if not exists (select 1 from public.profiles where id = other_user_id) then
    raise exception 'User not found.';
  end if;

  key := case when me::text < other_user_id::text
              then me::text || ':' || other_user_id::text
              else other_user_id::text || ':' || me::text end;

  insert into public.conversations (is_group, direct_key, created_by)
  values (false, key, me)
  on conflict (direct_key) do nothing
  returning id into conv;

  if conv is null then
    select id into conv from public.conversations where direct_key = key;
  else
    insert into public.conversation_members (conversation_id, user_id)
    values (conv, me), (conv, other_user_id);
  end if;

  return conv;
end;
$$;

create or replace function public.create_group_conversation(group_title text, member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  conv uuid;
  members uuid[];
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  members := array(select distinct unnest(array_append(member_ids, me)));
  if array_length(members, 1) < 3 then raise exception 'Pick at least two people for a group.'; end if;
  if array_length(members, 1) > 50 then raise exception 'Groups are limited to 50 people.'; end if;
  if coalesce(trim(group_title), '') = '' then raise exception 'Give the group a name.'; end if;

  insert into public.conversations (title, is_group, created_by)
  values (left(trim(group_title), 80), true, me)
  returning id into conv;

  insert into public.conversation_members (conversation_id, user_id)
  select conv, p.id from public.profiles p where p.id = any (members);

  return conv;
end;
$$;

-- One row per conversation with its member ids, for the list screen.
-- security_invoker makes the view respect the caller's RLS.
create or replace view public.conversation_summaries
with (security_invoker = true) as
  select c.*,
         coalesce((select array_agg(m.user_id) from public.conversation_members m where m.conversation_id = c.id), '{}') as member_ids
  from public.conversations c;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles are readable by signed-in users" on public.profiles;
create policy "profiles are readable by signed-in users" on public.profiles
  for select to authenticated using (true);

drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations
  for select to authenticated using (public.is_conversation_member(id));

drop policy if exists "members read memberships" on public.conversation_members;
create policy "members read memberships" on public.conversation_members
  for select to authenticated using (public.is_conversation_member(conversation_id));

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated using (public.is_conversation_member(conversation_id));

drop policy if exists "members send messages as themselves" on public.messages;
create policy "members send messages as themselves" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

-- Conversations and memberships are only created through the RPCs above.

grant execute on function public.get_or_create_direct_conversation(uuid) to authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
revoke execute on function public.get_or_create_direct_conversation(uuid) from anon;
revoke execute on function public.create_group_conversation(text, uuid[]) from anon;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversation_members') then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;
