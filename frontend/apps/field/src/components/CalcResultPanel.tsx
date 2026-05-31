import { StyleSheet, Text, View } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from './Banner.js';
import { formatHeadline, formatInputChips } from '../lib/calc/format.js';
import type { CalcResultDto } from '../lib/calc/types.js';
import type { TextSize } from '../lib/settings/preferences.js';
import { scaleFontSize, type FieldTheme } from '../theme/index.js';

export interface CalcResultPanelProps {
  result: CalcResultDto;
  submittedUnits?: Record<string, string> | undefined;
  theme: FieldTheme;
  textSize: TextSize;
}

/**
 * Result rendering for the calcs panel.
 *
 * Always shows: formula, headline number, input chips with units,
 * step-by-step working from the backend, and any notes. The
 * verification banner appears when ``safety_critical`` is true - the
 * field UI must never compute a safety-critical number without it.
 */
export function CalcResultPanel({ result, submittedUnits, theme, textSize }: CalcResultPanelProps) {
  const chips = formatInputChips(result, submittedUnits);

  return (
    <View style={{ gap: spacing[3] }}>
      {result.safety_critical ? (
        <Banner tone="info" title="DECISION SUPPORT ONLY" theme={theme} textSize={textSize}>
          Verify with the competent person before action. Confirm TVD vs MD and unit system.
        </Banner>
      ) : null}

      <View
        style={[styles.headlineBox, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
      >
        <Text
          style={{
            color: theme.textMuted,
            fontSize: scaleFontSize(11, textSize),
            fontWeight: '600',
            letterSpacing: 0.5,
          }}
        >
          RESULT
        </Text>
        <Text style={{ color: theme.text, fontSize: scaleFontSize(28, textSize), fontWeight: '700' }}>
          {formatHeadline(result)}
        </Text>
        <Text
          style={{
            color: theme.textMuted,
            fontSize: scaleFontSize(12, textSize),
            fontFamily: 'Courier',
          }}
        >
          {result.formula}
        </Text>
      </View>

      <View style={{ gap: spacing[1] }}>
        <Text
          style={{
            color: theme.textMuted,
            fontSize: scaleFontSize(11, textSize),
            fontWeight: '600',
            letterSpacing: 0.5,
          }}
        >
          INPUTS
        </Text>
        <View style={styles.chipsRow}>
          {chips.map((chip) => (
            <View
              key={chip.name}
              style={[
                styles.chip,
                { borderColor: theme.border, backgroundColor: theme.surface },
              ]}
            >
              <Text
                style={{
                  color: theme.textMuted,
                  fontSize: scaleFontSize(10, textSize),
                  fontFamily: 'Courier',
                }}
              >
                {chip.name}
              </Text>
              <Text
                style={{ color: theme.text, fontSize: scaleFontSize(14, textSize), fontWeight: '600' }}
              >
                {chip.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                {chip.unit ? ` ${chip.unit}` : ''}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {result.steps.length > 0 ? (
        <View style={{ gap: spacing[1] }}>
          <Text
            style={{
              color: theme.textMuted,
              fontSize: scaleFontSize(11, textSize),
              fontWeight: '600',
              letterSpacing: 0.5,
            }}
          >
            WORKING
          </Text>
          {result.steps.map((step, i) => (
            <Text
              key={i}
              style={{
                color: theme.text,
                fontSize: scaleFontSize(12, textSize),
                fontFamily: 'Courier',
              }}
            >
              {i + 1}. {step}
            </Text>
          ))}
        </View>
      ) : null}

      {result.notes.length > 0 ? (
        <View style={{ gap: spacing[1] }}>
          {result.notes.map((note, i) => (
            <Banner key={i} tone="warn" theme={theme} textSize={textSize}>
              {note}
            </Banner>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headlineBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing[3],
    gap: spacing[1],
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
  chip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    minWidth: 120,
  },
});
