import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BACKEND_ORDER, BACKENDS } from '@/backends/registry';
import { toError, type BackendId } from '@/backends/types';
import { Avatar, Banner, Button, Header, Screen, TextField } from '@/components/ui';
import { resetLocalData, switchBackend } from '@/providers/backend';
import { useBackend, useCurrentUser, useSession } from '@/store/session';
import { useTheme } from '@/theme';

export default function SettingsScreen() {
  const backend = useBackend();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const { colors, font, spacing, radius } = useTheme();
  const [name, setName] = useState(me.displayName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'danger' | 'info' } | null>(null);

  const saveName = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await backend.auth.updateProfile({ displayName: name });
      useSession.getState().setUser(updated);
      queryClient.removeQueries({ queryKey: [backend.id, 'users'] });
      setMessage({ text: 'Profile updated.', tone: 'info' });
    } catch (e) {
      setMessage({ text: toError(e).message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const confirm = (title: string, body: string, onConfirm: () => void) => {
    if (Platform.OS === 'web') {
      onConfirm();
      return;
    }
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', style: 'destructive', onPress: onConfirm },
    ]);
  };

  const pickBackend = (id: BackendId) => {
    if (id === backend.id) return;
    confirm(`Switch to ${BACKENDS[id].label}?`, 'You will be signed out of the current backend on this device.', () => {
      void switchBackend(id, queryClient);
    });
  };

  return (
    <Screen>
      <Header title="Settings" back />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
        <View style={[styles.profile, { gap: spacing.md }]}>
          <Avatar id={me.id} name={me.displayName} url={me.avatarUrl} size={56} />
          <View style={styles.flex}>
            <Text style={[font.heading, { color: colors.text }]}>{me.displayName}</Text>
            {me.email ? <Text style={[font.small, { color: colors.muted }]}>{me.email}</Text> : null}
          </View>
        </View>

        <View style={{ gap: spacing.md }}>
          <TextField label="Display name" value={name} onChangeText={setName} />
          <Button label="Save" variant="secondary" onPress={() => void saveName()} loading={saving} disabled={name.trim() === me.displayName} />
          {message ? <Banner message={message.text} tone={message.tone} /> : null}
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text style={[font.label, { color: colors.muted }]}>BACKEND</Text>
          {__DEV__ ? (
            <Text style={[font.small, { color: colors.muted }]}>
              Development builds can switch providers here. Release builds always use EXPO_PUBLIC_CHAT_BACKEND.
            </Text>
          ) : null}
          {BACKEND_ORDER.filter((id) => __DEV__ || id === backend.id).map((id) => {
            const descriptor = BACKENDS[id];
            const missing = descriptor.missingConfig();
            const current = id === backend.id;
            const available = missing.length === 0;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ selected: current, disabled: !available }}
                disabled={!available || current}
                onPress={() => pickBackend(id)}
                style={({ pressed }) => [
                  styles.option,
                  {
                    borderColor: current ? colors.accent : colors.border,
                    backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
                    borderRadius: radius.md,
                    padding: spacing.md,
                    gap: spacing.xs,
                  },
                ]}
              >
                <View style={styles.optionTop}>
                  <Text style={[font.heading, styles.flex, { color: colors.text }]}>{descriptor.label}</Text>
                  <Text style={[font.label, { color: current ? colors.accent : available ? colors.success : colors.muted }]}>
                    {current ? 'ACTIVE' : available ? 'READY' : 'NOT CONFIGURED'}
                  </Text>
                </View>
                <Text style={[font.small, { color: colors.muted }]}>{descriptor.description}</Text>
                {!available ? <Text style={[font.small, { color: colors.muted }]}>Missing: {missing.join(', ')}</Text> : null}
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: spacing.md }}>
          <Button label="Sign out" variant="secondary" onPress={() => void backend.auth.signOut()} />
          {backend.id === 'sqlite' ? (
            <Button
              label="Reset local data"
              variant="danger"
              onPress={() =>
                confirm('Reset local data?', 'Deletes every local account and message on this device.', () => {
                  void resetLocalData(queryClient);
                })
              }
            />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  profile: { flexDirection: 'row', alignItems: 'center' },
  option: { borderWidth: 1 },
  optionTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
