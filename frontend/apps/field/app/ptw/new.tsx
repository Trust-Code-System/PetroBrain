import { useReducer, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { ChipsInput } from '../../src/components/ChipsInput';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { useNetwork } from '../../src/lib/network/useNetwork';
import { generatePermitViaChat } from '../../src/lib/ptw/generate';
import { ptwFormReducer, validatePtwForm } from '../../src/lib/ptw/form';
import { savePermit } from '../../src/lib/ptw/repository';
import {
  CONTROL_SUGGESTIONS,
  HAZARD_SUGGESTIONS,
  PPE_SUGGESTIONS,
} from '../../src/lib/ptw/suggestions';
import {
  EMPTY_PTW_FORM,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  type OutputFormat,
  type WorkType,
} from '../../src/lib/ptw/types';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import { scaleFontSize } from '../../src/theme/index';

/**
 * /ptw/new - the form.
 *
 * On Generate the form is POSTed to /chat module=ptw; the backend
 * preamble + build_ptw_template tool produce a structured permit. The
 * result is saved locally and we route to /ptw/[id] for review +
 * signing + PDF export.
 */
export default function NewPtwScreen() {
  const theme = useFieldTheme();
  const session = useSessionStore();
  const network = useNetwork();
  const textSize = session.preferences.textSize;

  const [form, dispatch] = useReducer(ptwFormReducer, EMPTY_PTW_FORM);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('permit');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const errors = validatePtwForm(form);
    if (errors.length > 0) {
      setError(errors.join(' '));
      return;
    }
    if (!network.online) {
      setError('PTW drafting needs the network - the LLM call goes through /chat.');
      return;
    }
    if (!session.token || !session.principal) {
      setError('Sign in first.');
      return;
    }

    setPending(true);
    try {
      const generated = await generatePermitViaChat({
        baseUrl: session.apiBaseUrl,
        token: session.token,
        form,
        outputFormat,
        userRole: session.principal.role,
      });
      const saved = await savePermit({
        tenant_id: session.principal.tenantId,
        user_id: session.principal.userId,
        form,
        generated,
      });
      router.replace({ pathname: '/ptw/[id]', params: { id: saved.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(22, textSize) }]}
      >
        New permit
      </Text>

      {!network.online ? (
        <Banner tone="warn" title="Offline" theme={theme} textSize={textSize}>
          Drafting requires the network. Compose the form now; reconnect to generate.
        </Banner>
      ) : null}

      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.text, fontSize: scaleFontSize(13, textSize) }]}>
          Job description
        </Text>
        <TextInput
          value={form.job_description}
          onChangeText={(value) =>
            dispatch({ type: 'set_field', field: 'job_description', value })
          }
          placeholder="What is the work?"
          placeholderTextColor={theme.textMuted}
          multiline
          numberOfLines={3}
          editable={!pending}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.surfaceMuted,
              borderColor: theme.border,
              fontSize: scaleFontSize(15, textSize),
              minHeight: spacing[14] * 1.5,
              textAlignVertical: 'top',
            },
          ]}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.text, fontSize: scaleFontSize(13, textSize) }]}>
          Location / Asset
        </Text>
        <TextInput
          value={form.location}
          onChangeText={(value) => dispatch({ type: 'set_field', field: 'location', value })}
          placeholder="e.g. Compressor K-101 at Train A"
          placeholderTextColor={theme.textMuted}
          editable={!pending}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.surfaceMuted,
              borderColor: theme.border,
              fontSize: scaleFontSize(15, textSize),
            },
          ]}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.text, fontSize: scaleFontSize(13, textSize) }]}>
          Work type
        </Text>
        <View style={styles.workTypeRow}>
          {WORK_TYPES.map((wt) => {
            const active = wt === form.work_type;
            return (
              <Pressable
                key={wt}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => dispatch({ type: 'set_work_type', value: wt })}
                disabled={pending}
                style={[
                  styles.workTypeChip,
                  {
                    borderColor: active ? theme.bannerFg.info : theme.border,
                    backgroundColor: active ? theme.banner.info : theme.surface,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? theme.bannerFg.info : theme.text,
                    fontWeight: '600',
                    fontSize: scaleFontSize(13, textSize),
                  }}
                >
                  {WORK_TYPE_LABELS[wt as WorkType]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ChipsInput
        label="Hazards"
        value={form.hazards}
        onAdd={(value) => dispatch({ type: 'add_chip', field: 'hazards', value })}
        onRemove={(index) => dispatch({ type: 'remove_chip', field: 'hazards', index })}
        suggestions={HAZARD_SUGGESTIONS[form.work_type] ?? []}
        placeholder="Add a hazard"
        theme={theme}
        textSize={textSize}
        disabled={pending}
      />

      <ChipsInput
        label="Controls"
        value={form.controls}
        onAdd={(value) => dispatch({ type: 'add_chip', field: 'controls', value })}
        onRemove={(index) => dispatch({ type: 'remove_chip', field: 'controls', index })}
        suggestions={CONTROL_SUGGESTIONS[form.work_type] ?? []}
        placeholder="Add a control"
        theme={theme}
        textSize={textSize}
        disabled={pending}
      />

      <ChipsInput
        label="Isolations"
        value={form.isolations}
        onAdd={(value) => dispatch({ type: 'add_chip', field: 'isolations', value })}
        onRemove={(index) => dispatch({ type: 'remove_chip', field: 'isolations', index })}
        placeholder="Tag number or valve ID"
        theme={theme}
        textSize={textSize}
        disabled={pending}
      />

      <ChipsInput
        label="Required PPE"
        value={form.required_ppe}
        onAdd={(value) => dispatch({ type: 'add_chip', field: 'required_ppe', value })}
        onRemove={(index) => dispatch({ type: 'remove_chip', field: 'required_ppe', index })}
        suggestions={PPE_SUGGESTIONS[form.work_type] ?? []}
        placeholder="Add PPE"
        theme={theme}
        textSize={textSize}
        disabled={pending}
      />

      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.text, fontSize: scaleFontSize(13, textSize) }]}>
          Output format
        </Text>
        <View style={styles.formatRow}>
          {(['permit', 'toolbox_talk'] as const).map((fmt) => {
            const active = outputFormat === fmt;
            return (
              <Pressable
                key={fmt}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setOutputFormat(fmt)}
                disabled={pending}
                style={[
                  styles.workTypeChip,
                  {
                    borderColor: active ? theme.bannerFg.info : theme.border,
                    backgroundColor: active ? theme.banner.info : theme.surface,
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? theme.bannerFg.info : theme.text,
                    fontWeight: '600',
                    fontSize: scaleFontSize(13, textSize),
                  }}
                >
                  {fmt === 'permit' ? 'Permit' : 'Toolbox talk'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {error ? (
        <Banner tone="danger" title="Cannot generate" theme={theme} textSize={textSize}>
          {error}
        </Banner>
      ) : null}

      <PrimaryButton
        label={pending ? 'Working…' : 'Generate'}
        onPress={submit}
        disabled={pending}
        theme={theme}
        textSize={textSize}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '700' },
  section: { gap: spacing[1] },
  label: { fontWeight: '600' },
  input: {
    minHeight: spacing[14],
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  workTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
  workTypeChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: 'center',
  },
  formatRow: { flexDirection: 'row', gap: spacing[2] },
});
