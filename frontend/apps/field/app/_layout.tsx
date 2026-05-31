import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';

import { useSessionStore } from '../src/lib/session/store';
import { useFieldTheme } from '../src/lib/session/useColorMode';

/**
 * Root layout.
 *
 * Stacks the bottom-tabs surface on top of the auth + splash routes so
 * an unauthenticated user lands on the paste-token screen and an
 * authenticated user lands on the tabs.
 *
 * Note: NO ``'use client'`` directive - RN doesn't have a server/client
 * split. Everything in expo-router is the client.
 */
export default function RootLayout() {
  const hydrated = useSessionStore((s) => s.hydrated);
  const hydrate = useSessionStore((s) => s.hydrate);
  const theme = useFieldTheme();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) {
    return (
      <View style={[styles.splash, { backgroundColor: theme.surface }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="auth" options={{ presentation: 'modal' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
