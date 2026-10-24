import { Link } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BACKENDS } from '@/backends/registry';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/backends/sqlite/core';
import { toError } from '@/backends/types';
import { useBackend } from '@/store/session';
import { useTheme } from '@/theme';

import { Banner, Button, Screen, TextField } from './ui';

/** Shared sign-in / sign-up form. Auth success flips the session store and Stack.Protected navigates. */
export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const backend = useBackend();
  const { colors, font, spacing } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSignUp = mode === 'sign-up';

  const submit = async (overrideEmail?: string, overridePassword?: string) => {
    setError(null);
    setBusy(true);
    try {
      if (isSignUp) await backend.auth.signUp({ email, password, displayName });
      else await backend.auth.signIn(overrideEmail ?? email, overridePassword ?? password);
    } catch (e) {
      setError(toError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = email.trim() && password && (!isSignUp || displayName.trim());

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, { padding: spacing.xl, gap: spacing.lg }]} keyboardShouldPersistTaps="handled">
          <View style={{ gap: spacing.xs }}>
            <Text style={[font.label, { color: colors.accent }]}>{BACKENDS[backend.id].label.toUpperCase()}</Text>
            <Text accessibilityRole="header" style={[font.title, { color: colors.text }]}>
              {isSignUp ? 'Create your account' : 'Welcome back'}
            </Text>
            <Text style={[font.body, { color: colors.muted }]}>
              {isSignUp ? 'Pick a name people will see in chats.' : 'Sign in to pick up your conversations.'}
            </Text>
          </View>

          {isSignUp ? (
            <TextField label="Display name" value={displayName} onChangeText={setDisplayName} autoComplete="name" textContentType="name" placeholder="Jordan Lee" />
          ) : null}
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="you@example.com"
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            textContentType={isSignUp ? 'newPassword' : 'password'}
            placeholder={isSignUp ? 'At least 8 characters' : ''}
            onSubmitEditing={() => canSubmit && void submit()}
          />

          {error ? <Banner message={error} /> : null}

          <Button label={isSignUp ? 'Create account' : 'Sign in'} onPress={() => void submit()} loading={busy} disabled={!canSubmit} />

          <Link href={isSignUp ? '/sign-in' : '/sign-up'} replace style={[font.body, styles.link, { color: colors.accent }]}>
            {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </Link>

          {backend.id === 'sqlite' && !isSignUp ? (
            <View style={[styles.demo, { borderColor: colors.border, padding: spacing.lg, gap: spacing.sm }]}>
              <Text style={[font.label, { color: colors.muted }]}>LOCAL DEMO ACCOUNTS</Text>
              <Text style={[font.small, { color: colors.muted }]}>
                Stored on this device only. Sign in as one, chat, then sign out and sign in as the other.
              </Text>
              {DEMO_ACCOUNTS.map((account) => (
                <Button
                  key={account.email}
                  label={`Continue as ${account.displayName}`}
                  variant="secondary"
                  compact
                  disabled={busy}
                  onPress={() => void submit(account.email, DEMO_PASSWORD)}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', maxWidth: 480, width: '100%', alignSelf: 'center' },
  link: { textAlign: 'center', paddingVertical: 12 },
  demo: { borderWidth: 1, borderRadius: 12, marginTop: 8 },
});
