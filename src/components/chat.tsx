import { memo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { MAX_MESSAGE_LENGTH } from '@/backends/shared';
import type { ChatUser, Conversation } from '@/backends/types';
import type { ChatMessage } from '@/hooks/chat';
import { conversationTitle, formatClock, formatDayLabel, formatListTime, otherMemberId } from '@/lib/format';
import { useTheme } from '@/theme';

import { Avatar } from './ui';

export const ConversationRow = memo(function ConversationRow({
  conversation,
  meId,
  users,
  onPress,
}: {
  conversation: Conversation;
  meId: string;
  users: ReadonlyMap<string, ChatUser>;
  onPress: () => void;
}) {
  const { colors, font, spacing } = useTheme();
  const title = conversationTitle(conversation, meId, users);
  const avatarUser = conversation.isGroup ? null : users.get(otherMemberId(conversation, meId) ?? '');
  const last = conversation.lastMessage;
  const senderPrefix =
    last && conversation.isGroup ? `${last.senderId === meId ? 'You' : (users.get(last.senderId)?.displayName.split(' ')[0] ?? '…')}: ` : last?.senderId === meId ? 'You: ' : '';
  const preview = last ? senderPrefix + last.text : conversation.isGroup ? `${conversation.memberIds.length} members` : 'Say hello';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${preview}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { paddingHorizontal: spacing.lg, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}
    >
      <Avatar id={avatarUser?.id ?? conversation.id} name={avatarUser?.displayName ?? title} url={avatarUser?.avatarUrl} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={[font.heading, styles.flex, { color: colors.text }]}>
            {title}
          </Text>
          <Text style={[font.small, { color: colors.muted }]}>{formatListTime(last?.createdAt ?? conversation.updatedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={[font.body, { color: colors.muted, fontSize: 15 }]}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
});

export const MessageBubble = memo(function MessageBubble({
  message,
  mine,
  senderName,
  showSender,
  onRetry,
}: {
  message: ChatMessage;
  mine: boolean;
  senderName: string | null;
  showSender: boolean;
  onRetry: (message: ChatMessage) => void;
}) {
  const { colors, font, radius } = useTheme();
  const failed = message.pending === 'failed';
  const status = message.pending === 'sending' ? 'Sending…' : failed ? 'Not sent · Tap to retry' : formatClock(message.createdAt);

  const bubble = (
    <View
      style={[
        styles.bubble,
        {
          alignSelf: mine ? 'flex-end' : 'flex-start',
          backgroundColor: mine ? colors.bubbleMine : colors.bubbleTheirs,
          borderColor: failed ? colors.danger : mine ? colors.bubbleMine : colors.border,
          borderRadius: radius.lg,
          borderBottomRightRadius: mine ? 6 : radius.lg,
          borderBottomLeftRadius: mine ? radius.lg : 6,
          opacity: message.pending === 'sending' ? 0.7 : 1,
        },
      ]}
    >
      {showSender && senderName ? (
        <Text style={[font.label, { color: colors.accent, marginBottom: 2 }]}>{senderName}</Text>
      ) : null}
      <Text selectable style={[font.body, { color: mine ? colors.onBubbleMine : colors.onBubbleTheirs }]}>
        {message.text}
      </Text>
    </View>
  );

  return (
    <View style={[styles.bubbleWrap, { alignItems: mine ? 'flex-end' : 'flex-start' }]}>
      {failed ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Message not sent. Retry" onPress={() => onRetry(message)}>
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
      <Text style={[font.small, { color: failed ? colors.danger : colors.muted, marginTop: 2, fontSize: 12 }]}>{status}</Text>
    </View>
  );
});

export function DaySeparator({ at }: { at: number }) {
  const { colors, font } = useTheme();
  return (
    <View style={styles.day}>
      <Text style={[font.label, { color: colors.muted, fontSize: 12 }]}>{formatDayLabel(at)}</Text>
    </View>
  );
}

export function Composer({ onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean }) {
  const { colors, font, radius, spacing } = useTheme();
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View style={[styles.composer, { borderTopColor: colors.border, backgroundColor: colors.surface, padding: spacing.sm }]}>
      <TextInput
        accessibilityLabel="Message"
        value={text}
        onChangeText={setText}
        placeholder="Message"
        placeholderTextColor={colors.muted}
        multiline
        // react-native-web renders multiline inputs as a 2-row textarea by default.
        numberOfLines={Platform.OS === 'web' ? 1 : undefined}
        maxLength={MAX_MESSAGE_LENGTH}
        // Enter sends on web; on mobile the return key inserts a newline.
        onKeyPress={(e) => {
          if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        style={[
          font.body,
          styles.composerInput,
          { color: colors.text, backgroundColor: colors.background, borderRadius: radius.lg, borderColor: colors.border },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send message"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={submit}
        style={({ pressed }) => [
          styles.send,
          { backgroundColor: colors.accent, borderRadius: radius.pill, opacity: !canSend ? 0.45 : pressed ? 0.8 : 1 },
        ]}
      >
        <Text style={[font.label, { color: colors.onAccent, fontSize: 15 }]}>Send</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, paddingVertical: 10 },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bubbleWrap: { paddingHorizontal: 12, marginVertical: 3 },
  bubble: { maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1 },
  day: { alignItems: 'center', paddingVertical: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  composerInput: { flex: 1, minHeight: 44, maxHeight: 140, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 11, borderWidth: 1 },
  send: { minHeight: 44, minWidth: 64, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
