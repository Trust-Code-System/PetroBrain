import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@petrobrain/ui/tokens';

import { scaleFontSize } from '../theme/index.js';
import type { FieldTheme } from '../theme/index.js';
import type { TextSize } from '../lib/settings/preferences.js';

export interface PrimaryButtonProps {
  onPress: () => void;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  textSize: TextSize;
  theme: FieldTheme;
  accessibilityHint?: string;
}

export function PrimaryButton({
  onPress,
  label,
  variant = 'primary',
  disabled,
  textSize,
  theme,
  accessibilityHint,
}: PrimaryButtonProps) {
  const palette = paletteFor(variant, theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View>
        <Text
          style={[
            styles.label,
            { color: palette.fg, fontSize: scaleFontSize(18, textSize) },
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function paletteFor(
  variant: 'primary' | 'secondary' | 'danger',
  theme: FieldTheme,
): { bg: string; fg: string; border: string } {
  if (variant === 'danger') {
    return {
      bg: theme.banner.danger,
      fg: theme.bannerFg.danger,
      border: colors.semantic.danger.border,
    };
  }
  if (variant === 'secondary') {
    return { bg: theme.surface, fg: theme.text, border: theme.border };
  }
  return { bg: theme.primary, fg: theme.primaryFg, border: theme.primary };
}

const styles = StyleSheet.create({
  base: {
    minHeight: spacing[14],          // 56 px tap target - gloves-friendly
    paddingHorizontal: spacing[4],
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
  },
});
