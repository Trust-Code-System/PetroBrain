import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../../src/components/Banner';
import { CalcResultPanel } from '../../../src/components/CalcResultPanel';
import { ScreenContainer } from '../../../src/components/ScreenContainer';
import { getRecentCalc } from '../../../src/lib/calc/repository';
import type { RecentCalc } from '../../../src/lib/calc/types';
import { useSessionStore } from '../../../src/lib/session/store';
import { useFieldTheme } from '../../../src/lib/session/useColorMode';
import { scaleFontSize } from '../../../src/theme/index';

/**
 * /calcs/recent/[id] - replay a saved calc result offline.
 */
export default function RecentCalcScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const theme = useFieldTheme();
  const principal = useSessionStore((s) => s.principal);
  const textSize = useSessionStore((s) => s.preferences.textSize);

  const [row, setRow] = useState<RecentCalc | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!principal || !params.id) return;
    let cancelled = false;
    getRecentCalc(principal.tenantId, params.id).then((r) => {
      if (cancelled) return;
      if (r === null) setNotFound(true);
      else setRow(r);
    });
    return () => {
      cancelled = true;
    };
  }, [principal, params.id]);

  const submittedUnits = row
    ? Object.fromEntries(Object.entries(row.inputs).map(([name, v]) => [name, v.unit]))
    : undefined;

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
        <Text style={{ color: theme.primary, fontWeight: '600', fontSize: scaleFontSize(15, textSize) }}>
          ← Back
        </Text>
      </Pressable>

      {notFound ? (
        <Banner tone="warn" title="Result not found" theme={theme} textSize={textSize}>
          The calc may have been cleared from the recent cache.
        </Banner>
      ) : null}

      {row ? (
        <>
          <Text
            accessibilityRole="header"
            style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(20, textSize) }]}
          >
            {row.result.name}
          </Text>
          <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(11, textSize) }}>
            Saved {row.created_utc.slice(0, 16).replace('T', ' ')} · {row.calc_name}
          </Text>
          <CalcResultPanel
            result={row.result}
            submittedUnits={submittedUnits}
            theme={theme}
            textSize={textSize}
          />
        </>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  back: { paddingVertical: spacing[1], paddingRight: spacing[2] },
  heading: { fontWeight: '700' },
});
