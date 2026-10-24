import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Composer, DaySeparator, MessageBubble } from '@/components/chat';
import { Banner, CenteredState, Header, Screen } from '@/components/ui';
import { useConversation, useMessages, useSendMessage, useUsers, type ChatMessage } from '@/hooks/chat';
import { conversationTitle } from '@/lib/format';
import { useCurrentUser } from '@/store/session';
import { useTheme } from '@/theme';

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useCurrentUser();
  const { colors } = useTheme();
  const { conversation, isLoading: conversationLoading } = useConversation(id);
  const users = useUsers(conversation?.memberIds ?? []);
  const { messages, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, streamError } =
    useMessages(id);
  const { send, retry, error: sendError } = useSendMessage(id);

  const title = conversation ? conversationTitle(conversation, me.id, users) : 'Chat';
  const subtitle = conversation?.isGroup
    ? [
        ...conversation.memberIds
          .filter((m) => m !== me.id)
          .map((m) => users.get(m)?.displayName.split(' ')[0] ?? '…')
          .sort((a, b) => a.localeCompare(b)),
        'You',
      ].join(', ')
    : undefined;

  // The list is inverted: index 0 is the newest message at the bottom.
  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const older = messages[index + 1];
      const mine = item.senderId === me.id;
      const showSender = !!conversation?.isGroup && !mine && older?.senderId !== item.senderId;
      return (
        <View>
          {!older || !sameDay(older.createdAt, item.createdAt) ? <DaySeparator at={item.createdAt} /> : null}
          <MessageBubble
            message={item}
            mine={mine}
            showSender={showSender}
            senderName={users.get(item.senderId)?.displayName ?? null}
            onRetry={retry}
          />
        </View>
      );
    },
    [messages, me.id, conversation?.isGroup, users, retry],
  );

  const banner = useMemo(() => streamError?.message ?? sendError?.message ?? null, [streamError, sendError]);

  if (!conversation && !conversationLoading) {
    return (
      <Screen>
        <Header title="Chat" back />
        <CenteredState title="Conversation not found" body="It may have been removed, or you are not a member." />
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Header title={title} subtitle={subtitle} back />
        {banner ? <Banner message={banner} /> : null}
        {isPending ? (
          <CenteredState loading />
        ) : isError ? (
          <CenteredState title="Couldn't load messages" body={error?.message} action={{ label: 'Retry', onPress: () => void refetch() }} />
        ) : (
          <FlatList
            inverted
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            style={{ backgroundColor: colors.background }}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onEndReached={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
            onEndReachedThreshold={0.3}
            ListFooterComponent={isFetchingNextPage ? <ActivityIndicator style={styles.loader} color={colors.accent} /> : undefined}
            ListEmptyComponent={
              // Inverted lists render the empty component upside-down; flip it back.
              <View style={styles.flipped}>
                <CenteredState title="No messages yet" body="Send the first message." />
              </View>
            }
          />
        )}
        <Composer onSend={send} disabled={!conversation} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingVertical: 8, flexGrow: 1 },
  loader: { paddingVertical: 16 },
  flipped: { flex: 1, transform: [{ scaleY: -1 }] },
});
