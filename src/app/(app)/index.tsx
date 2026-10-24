import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { BACKENDS } from '@/backends/registry';
import type { Conversation } from '@/backends/types';
import { ConversationRow } from '@/components/chat';
import { Banner, Button, CenteredState, Header, Screen } from '@/components/ui';
import { useConversationStreamError, useConversations, useUsers } from '@/hooks/chat';
import { useBackend, useCurrentUser } from '@/store/session';
import { useTheme } from '@/theme';

export default function ConversationsScreen() {
  const backend = useBackend();
  const me = useCurrentUser();
  const { colors } = useTheme();
  const { data: conversations, isPending } = useConversations();
  const streamError = useConversationStreamError((s) => s.error);

  const memberIds = useMemo(() => (conversations ?? []).flatMap((c) => c.memberIds), [conversations]);
  const users = useUsers(memberIds);

  const renderItem = useCallback(
    ({ item }: { item: Conversation }) => (
      <ConversationRow
        conversation={item}
        meId={me.id}
        users={users}
        onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
      />
    ),
    [me.id, users],
  );

  return (
    <Screen edges={['top']}>
      <Header
        title="Chats"
        subtitle={`${me.displayName} · ${BACKENDS[backend.id].label}`}
        right={
          <>
            <Button label="Settings" variant="ghost" compact onPress={() => router.push('/settings')} />
            <Button label="New" compact onPress={() => router.push('/new')} accessibilityLabel="New chat" />
          </>
        }
      />
      {streamError ? <Banner message={streamError.message} /> : null}
      {isPending && !streamError ? (
        <CenteredState loading />
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          contentContainerStyle={!conversations?.length ? styles.emptyContainer : undefined}
          ListEmptyComponent={
            <CenteredState
              title="No conversations yet"
              body="Start a chat with someone, or create a group."
              action={{ label: 'Start a chat', onPress: () => router.push('/new') }}
            />
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
  emptyContainer: { flexGrow: 1 },
});
