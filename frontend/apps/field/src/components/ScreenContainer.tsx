import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, View } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import type { FieldTheme } from '../theme/index.js';
import type { TextSize } from '../lib/settings/preferences.js';
import { NetworkBanner } from './NetworkBanner.js';

export interface ScreenContainerProps {
  theme: FieldTheme;
  textSize: TextSize;
  scroll?: boolean;
  children: React.ReactNode;
}

/** Common screen frame - safe area, network banner, padded body. */
export function ScreenContainer({ theme, textSize, scroll = true, children }: ScreenContainerProps) {
  const Inner = scroll ? ScrollView : View;
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.surface }]}>
      <NetworkBanner theme={theme} textSize={textSize} />
      <Inner
        style={[styles.body, { backgroundColor: theme.surface }]}
        contentContainerStyle={scroll ? styles.scrollContent : undefined}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </Inner>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  scrollContent: { padding: spacing[4], gap: spacing[3] },
});
