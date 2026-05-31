import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import type { TextSize } from '../lib/settings/preferences.js';
import { scaleFontSize, type FieldTheme } from '../theme/index.js';

export interface ChipsInputProps {
  label: string;
  value: string[];
  onAdd: (chip: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
  suggestions?: string[];
  theme: FieldTheme;
  textSize: TextSize;
  disabled?: boolean;
}

/**
 * Multi-select chip input - used for hazards, controls, isolations, PPE.
 *
 * Suggestions render as tap-to-add ghost chips below the input so the
 * user can populate the field one tap at a time in gloves. Selected
 * chips show with an × to remove.
 */
export function ChipsInput({
  label,
  value,
  onAdd,
  onRemove,
  placeholder,
  suggestions = [],
  theme,
  textSize,
  disabled,
}: ChipsInputProps) {
  const [draft, setDraft] = useState('');

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft('');
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.text, fontSize: scaleFontSize(13, textSize) }]}>
        {label}
      </Text>
      <View style={styles.row}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          placeholder={placeholder}
          placeholderTextColor={theme.textMuted}
          editable={!disabled}
          returnKeyType="done"
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.surfaceMuted,
              borderColor: theme.border,
              fontSize: scaleFontSize(14, textSize),
            },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${label}`}
          onPress={commit}
          disabled={disabled || !draft.trim()}
          style={[
            styles.addBtn,
            {
              backgroundColor: theme.primary,
              opacity: !draft.trim() || disabled ? 0.5 : 1,
            },
          ]}
        >
          <Text style={{ color: theme.primaryFg, fontSize: scaleFontSize(18, textSize), fontWeight: '700' }}>
            +
          </Text>
        </Pressable>
      </View>

      {value.length > 0 ? (
        <View style={styles.chipsRow}>
          {value.map((chip, i) => (
            <Pressable
              key={`${chip}-${i}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${chip}`}
              onPress={() => !disabled && onRemove(i)}
              style={[
                styles.chip,
                { backgroundColor: theme.banner.info, borderColor: theme.bannerFg.info },
              ]}
            >
              <Text style={{ color: theme.bannerFg.info, fontSize: scaleFontSize(13, textSize) }}>
                {chip} ×
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {suggestions.length > 0 ? (
        <View style={styles.suggestionsBlock}>
          <Text style={[styles.suggestionsLabel, { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) }]}>
            Tap to add
          </Text>
          <View style={styles.chipsRow}>
            {suggestions.map((suggestion) => {
              const already = value.includes(suggestion);
              return (
                <Pressable
                  key={suggestion}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: already || disabled }}
                  disabled={already || disabled}
                  onPress={() => onAdd(suggestion)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                      opacity: already ? 0.4 : 1,
                    },
                  ]}
                >
                  <Text style={{ color: theme.text, fontSize: scaleFontSize(13, textSize) }}>
                    {already ? `✓ ${suggestion}` : `+ ${suggestion}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing[1] },
  label: { fontWeight: '600' },
  row: { flexDirection: 'row', gap: spacing[2] },
  input: {
    flex: 1,
    minHeight: spacing[14],
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing[3],
  },
  addBtn: {
    width: spacing[14],
    height: spacing[14],
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
  chip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 36,
    justifyContent: 'center',
  },
  suggestionsBlock: { marginTop: spacing[1], gap: spacing[1] },
  suggestionsLabel: { fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' },
});
