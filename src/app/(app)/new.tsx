import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatUser } from '@/backends/types';
import { Avatar, Banner, Button, CenteredState, Header, Screen, TextField } from '@/components/ui';
import { useCreateGroup, useStartDirectChat, useUserSearch } from '@/hooks/chat';
import { useTheme } from '@/theme';

/** Pick one person for a direct chat, or switch to group mode and pick several. */
export default function NewChatScreen() {
  const { colors, font, spacing } = useTheme();
  const [search, setSearch] = useState('');
  const [groupMode, setGroupMode] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [selected, setSelected] = useState<Map<string, ChatUser>>(new Map());
  const results = useUserSearch(search);
  const startDirect = useStartDirectChat();
  const createGroup = useCreateGroup();
  const busy = startDirect.isPending || createGroup.isPending;
  const error = startDirect.error ?? createGroup.error;

  const openChat = (id: string) => router.replace({ pathname: '/chat/[id]', params: { id } });

  const onPick = (user: ChatUser) => {
    if (!groupMode) {
      startDirect.mutate(user.id, { onSuccess: (c) => openChat(c.id) });
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user);
      return next;
    });
  };

  const submitGroup = () =>
    createGroup.mutate({ title: groupTitle, memberIds: [...selected.keys()] }, { onSuccess: (c) => openChat(c.id) });

  return (
    <Screen>
      <Header
        title={groupMode ? 'New group' : 'New chat'}
        back
        right={
          <Button
            label={groupMode ? 'Direct' : 'Group'}
            variant="ghost"
            compact
            accessibilityLabel={groupMode ? 'Switch to direct chat' : 'Switch to group chat'}
            onPress={() => {
              setGroupMode((g) => !g);
              setSelected(new Map());
            }}
          />
        }
      />
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        {groupMode ? <TextField label="Group name" value={groupTitle} onChangeText={setGroupTitle} placeholder="Weekend plans" /> : null}
        <TextField
          label="Search people"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Name or email"
        />
      </View>
      {error ? <Banner message={error.message} /> : null}

      <FlatList
        data={results.data ?? []}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const checked = selected.has(item.id);
          return (
            <Pressable
              accessibilityRole={groupMode ? 'checkbox' : 'button'}
              accessibilityState={groupMode ? { checked } : undefined}
              accessibilityLabel={item.displayName}
              disabled={busy}
              onPress={() => onPick(item)}
              style={({ pressed }) => [
                styles.row,
                { paddingHorizontal: spacing.lg, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
              ]}
            >
              <Avatar id={item.id} name={item.displayName} url={item.avatarUrl} size={40} />
              <View style={styles.flex}>
                <Text style={[font.heading, { color: colors.text }]}>{item.displayName}</Text>
                {item.email ? <Text style={[font.small, { color: colors.muted }]}>{item.email}</Text> : null}
              </View>
              {groupMode ? (
                <View
                  style={[
                    styles.check,
                    { borderColor: checked ? colors.accent : colors.border, backgroundColor: checked ? colors.accent : 'transparent' },
                  ]}
                >
                  {checked ? <Text style={{ color: colors.onAccent, fontWeight: '700' }}>✓</Text> : null}
                </View>
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          results.isPending ? (
            <CenteredState loading />
          ) : results.isError ? (
            <CenteredState title="Search failed" body={results.error.message} />
          ) : (
            <CenteredState title="No one found" body={search ? 'Try a different name or the full email address.' : 'Nobody else has signed up yet.'} />
          )
        }
      />

      {groupMode ? (
        <View style={[styles.footer, { padding: spacing.lg, borderTopColor: colors.border }]}>
          <Button
            label={
              selected.size < 2 ? 'Pick at least 2 people' : !groupTitle.trim() ? 'Name the group' : `Create group (${selected.size + 1})`
            }
            onPress={submitGroup}
            disabled={selected.size < 2 || !groupTitle.trim()}
            loading={createGroup.isPending}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 8 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
});
