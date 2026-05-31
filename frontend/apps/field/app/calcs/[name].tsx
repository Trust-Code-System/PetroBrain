import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { CalcResultPanel } from '../../src/components/CalcResultPanel';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { fetchCalcCatalog, runCalc } from '../../src/lib/calc/api';
import {
  buildCalcRequest,
  emptyFormState,
  type CalcFormState,
} from '../../src/lib/calc/request';
import { saveRecentCalc } from '../../src/lib/calc/repository';
import type { CalcCatalogEntry, CalcResponse } from '../../src/lib/calc/types';
import { useNetwork } from '../../src/lib/network/useNetwork';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import { scaleFontSize, type FieldTheme } from '../../src/theme/index';
import type { TextSize } from '../../src/lib/settings/preferences';

/**
 * /calcs/[name] - per-calc form generated from the catalog entry.
 *
 * Input grid is rendered from the catalog's input specs: each field
 * gets a numeric input + a unit selector for its accepted units. The
 * "Calculate" tap posts to /calc and renders the working below.
 */
export default function CalcDetailScreen() {
  const params = useLocalSearchParams<{ name: string }>();
  const name = params.name;

  const theme = useFieldTheme();
  const session = useSessionStore();
  const network = useNetwork();
  const textSize = session.preferences.textSize;

  const [spec, setSpec] = useState<CalcCatalogEntry | null>(null);
  const [form, setForm] = useState<CalcFormState>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [response, setResponse] = useState<CalcResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalogEntry = useCallback(async () => {
    if (!session.token || !network.online) return;
    try {
      const catalog = await fetchCalcCatalog({ baseUrl: session.apiBaseUrl, token: session.token });
      const found = catalog.find((c) => c.name === name) ?? null;
      setSpec(found);
      if (found) setForm(emptyFormState(found));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [name, network.online, session.apiBaseUrl, session.token]);

  useEffect(() => {
    void loadCatalogEntry();
  }, [loadCatalogEntry]);

  async function submit() {
    if (!spec || !session.token || !session.principal) return;
    const built = buildCalcRequest(spec, form);
    if (!built.ok) {
      setFieldErrors(built.errors);
      return;
    }
    setFieldErrors({});
    setError(null);
    setPending(true);
    setResponse(null);
    try {
      const result = await runCalc({
        baseUrl: session.apiBaseUrl,
        token: session.token,
        body: built.body,
      });
      setResponse(result);
      await saveRecentCalc({
        tenant_id: session.principal.tenantId,
        user_id: session.principal.userId,
        form,
        response: result,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <View style={styles.headerRow}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text
            style={{ color: theme.primary, fontWeight: '600', fontSize: scaleFontSize(15, textSize) }}
          >
            ← Back
          </Text>
        </Pressable>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(20, textSize) }]}
        >
          {spec?.label ?? 'Calc'}
        </Text>
      </View>

      {spec ? (
        <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(13, textSize) }}>
          {spec.summary}
        </Text>
      ) : null}

      {!network.online ? (
        <Banner tone="warn" title="Offline" theme={theme} textSize={textSize}>
          Running a calc needs the network - every number comes from the backend. You can still
          view past results on the Recent tab.
        </Banner>
      ) : null}

      {!spec && !error ? (
        <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(13, textSize) }}>
          Loading…
        </Text>
      ) : null}

      {spec
        ? spec.inputs.map((input) => (
            <CalcInputRow
              key={input.name}
              input={input}
              state={form[input.name] ?? { value: '', unit: input.canonical_unit }}
              error={fieldErrors[input.name]}
              onChange={(next) =>
                setForm((prev) => ({ ...prev, [input.name]: next }))
              }
              theme={theme}
              textSize={textSize}
              disabled={pending}
            />
          ))
        : null}

      {spec ? (
        <PrimaryButton
          label={pending ? 'Calculating…' : 'Calculate'}
          onPress={submit}
          disabled={pending || !spec || !network.online}
          theme={theme}
          textSize={textSize}
        />
      ) : null}

      {error ? (
        <Banner tone="danger" title="Could not run calc" theme={theme} textSize={textSize}>
          {error}
        </Banner>
      ) : null}

      {response ? (
        <CalcResultPanel
          result={response.result}
          submittedUnits={response.submitted_units}
          theme={theme}
          textSize={textSize}
        />
      ) : null}
    </ScreenContainer>
  );
}

interface CalcInputRowProps {
  input: CalcCatalogEntry['inputs'][number];
  state: { value: string; unit: string };
  error?: string | undefined;
  onChange: (next: { value: string; unit: string }) => void;
  theme: FieldTheme;
  textSize: TextSize;
  disabled?: boolean;
}

function CalcInputRow({ input, state, error, onChange, theme, textSize, disabled }: CalcInputRowProps) {
  return (
    <View style={styles.field}>
      <Text
        style={{ color: theme.text, fontWeight: '600', fontSize: scaleFontSize(13, textSize) }}
      >
        {input.label}
      </Text>
      <View style={styles.row}>
        <TextInput
          value={state.value}
          onChangeText={(value) => onChange({ value, unit: state.unit })}
          keyboardType="numeric"
          editable={!disabled}
          placeholder={input.placeholder != null ? String(input.placeholder) : undefined}
          placeholderTextColor={theme.textMuted}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.surfaceMuted,
              borderColor: error ? theme.bannerFg.danger : theme.border,
              fontSize: scaleFontSize(16, textSize),
            },
          ]}
        />
        <View style={[styles.unitWrap, { borderColor: theme.border }]}>
          {input.accepted_units.map((unit, i) => {
            const active = state.unit === unit;
            return (
              <Pressable
                key={unit}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => onChange({ value: state.value, unit })}
                disabled={disabled}
                style={[
                  styles.unitChip,
                  {
                    backgroundColor: active ? theme.primary : theme.surface,
                    borderRightWidth: i === input.accepted_units.length - 1 ? 0 : 1,
                    borderRightColor: theme.border,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? theme.primaryFg : theme.text,
                    fontWeight: '600',
                    fontSize: scaleFontSize(13, textSize),
                  }}
                >
                  {unit}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.bannerFg.danger, fontSize: scaleFontSize(11, textSize) }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  back: { paddingVertical: spacing[1], paddingRight: spacing[2] },
  heading: { fontWeight: '700' },
  field: { gap: spacing[1] },
  row: { flexDirection: 'row', gap: spacing[2], alignItems: 'stretch' },
  input: {
    flex: 1,
    minHeight: spacing[14],
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing[3],
    fontFamily: 'Courier',
  },
  unitWrap: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
    minWidth: 80,
  },
  unitChip: {
    paddingHorizontal: spacing[3],
    minHeight: spacing[14],
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
