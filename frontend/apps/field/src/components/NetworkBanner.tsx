import { StyleSheet, Text, View } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import { useNetwork } from '../lib/network/useNetwork.js';
import type { FieldTheme } from '../theme/index.js';
import { scaleFontSize } from '../theme/index.js';
import type { TextSize } from '../lib/settings/preferences.js';

export interface NetworkBannerProps {
  theme: FieldTheme;
  textSize: TextSize;
}

export function NetworkBanner({ theme, textSize }: NetworkBannerProps) {
  const network = useNetwork();
  const tone: 'safe' | 'warn' = network.online ? 'safe' : 'warn';
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.bar, { backgroundColor: theme.banner[tone] }]}
    >
      <View style={[styles.dot, { backgroundColor: theme.bannerFg[tone] }]} />
      <Text
        style={[
          styles.label,
          { color: theme.bannerFg[tone], fontSize: scaleFontSize(13, textSize) },
        ]}
      >
        {network.online ? 'Online' : 'Offline - using local cache'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    gap: spacing[2],
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontWeight: '600' },
});
