import { QueryClient, QueryClientProvider, focusManager, useQueryClient } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button, CenteredState, Screen } from '@/components/ui';
import { activateBackend, resolveBackendId, switchBackend } from '@/providers/backend';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme';

// Let TanStack Query know when the app is foregrounded (refetch-on-focus on native).
focusManager.setEventListener((handleFocus) => {
  if (Platform.OS === 'web') return undefined;
  const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
  return () => sub.remove();
});

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 30_000 },
          mutations: { retry: 0 },
        },
      }),
  );
  const { isDark, colors } = useTheme();
  const navTheme = isDark ? DarkTheme : DefaultTheme;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={{ ...navTheme, colors: { ...navTheme.colors, background: colors.background, primary: colors.accent } }}>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          <RootNavigator />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const queryClient = useQueryClient();
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const backendId = useSession((s) => s.backendId);

  useEffect(() => {
    void resolveBackendId().then((id) => activateBackend(id, queryClient));
  }, [queryClient]);

  if (status === 'booting') {
    return (
      <Screen>
        <CenteredState loading body="Connecting…" />
      </Screen>
    );
  }

  if (status === 'backendError') {
    return (
      <Screen>
        <CenteredState title={`Couldn't start ${backendId ?? 'backend'}`} body={error ?? undefined} />
        {backendId !== 'sqlite' ? (
          <Button label="Use local SQLite instead" variant="secondary" onPress={() => void switchBackend('sqlite', queryClient)} />
        ) : (
          <Button label="Try again" variant="secondary" onPress={() => void activateBackend('sqlite', queryClient)} />
        )}
      </Screen>
    );
  }

  // Stack.Protected swaps the whole stack when auth changes, so signed-out
  // users can never deep-link into a chat.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'signedIn'}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      {/* When a guard fails, Expo Router falls back to the first allowed screen: sign-in. */}
      <Stack.Protected guard={status === 'signedOut'}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
      </Stack.Protected>
    </Stack>
  );
}
