import { Stack } from 'expo-router';

import { useConversationsSubscription } from '@/hooks/chat';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
  // One live subscription for the whole signed-in area.
  useConversationsSubscription();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="chat/[id]" />
      <Stack.Screen name="new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
