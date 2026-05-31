import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Pressable } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { askOffline, askOnline, type AskAnswer } from '../../src/lib/ask/ask';
import { speak, stopSpeaking } from '../../src/lib/ask/tts';
import { useNetwork } from '../../src/lib/network/useNetwork';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import type { TextSize } from '../../src/lib/settings/preferences';
import type { FieldTheme } from '../../src/theme/index';
import { scaleFontSize } from '../../src/theme/index';

/**
 * Ask tab - voice-first surface (voice ASR is a TODO placeholder).
 *
 * Online: ``POST /chat`` with the user's principal.
 * Offline: ``askOffline`` searches the SQLite SOP cache. If nothing
 * matches, the answer says so honestly - no fabrication.
 *
 * The answer is rendered AND spoken via expo-speech in the user's
 * preferred language (English active; Pidgin/Yoruba/Hausa stubs).
 */
export default function AskScreen() {
  const theme = useFieldTheme();
  const session = useSessionStore();
  const network = useNetwork();
  const textSize = session.preferences.textSize;

  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!query.trim() || pending) return;
    setPending(true);
    setError(null);
    setAnswer(null);
    stopSpeaking();
    try {
      let result: AskAnswer;
      if (network.online && session.token) {
        try {
          result = await askOnline(query.trim(), {
            baseUrl: session.apiBaseUrl,
            token: session.token,
            module: 'general',
            asset_context: null,
            ...(session.principal?.role ? { user_role: session.principal.role } : {}),
          });
        } catch {
          // Network said online but the request failed (DNS, captive
          // portal, server down). Fall through to the cache and tell
          // the user we used the offline path.
          result = await askOffline(query.trim(), session.principal?.tenantId ?? 'demo');
        }
      } else {
        result = await askOffline(query.trim(), session.principal?.tenantId ?? 'demo');
      }
      setAnswer(result);
      speak(result.text, session.preferences.language);
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
        Ask PetroBrain
      </Text>
      <Text style={[styles.muted, { color: theme.textMuted, fontSize: scaleFontSize(13, textSize) }]}>
        Numbers come from the calc tools, never prose. Verify with the competent person before acting.
      </Text>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder='e.g. "show me hot-work permit procedure"'
        placeholderTextColor={theme.textMuted}
        multiline
        editable={!pending}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.surfaceMuted,
            borderColor: theme.border,
            fontSize: scaleFontSize(16, textSize),
          },
        ]}
      />

      <View style={styles.row}>
        <PrimaryButton
          label={pending ? 'Working…' : 'Ask'}
          onPress={submit}
          disabled={pending || !query.trim()}
          textSize={textSize}
          theme={theme}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hold to talk (voice input not yet available)"
          onPress={() => {
            setError('Voice input is not yet wired - paste or type the question for now.');
          }}
          style={[styles.mic, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
        >
          <Text style={{ color: theme.text, fontSize: scaleFontSize(20, textSize) }}>🎤</Text>
        </Pressable>
      </View>

      {error ? (
        <Banner tone="warn" title="Not ready" theme={theme} textSize={textSize}>
          {error}
        </Banner>
      ) : null}

      {answer ? <AnswerCard answer={answer} theme={theme} textSize={textSize} /> : null}
    </ScreenContainer>
  );
}

function AnswerCard({
  answer,
  theme,
  textSize,
}: {
  answer: AskAnswer;
  theme: FieldTheme;
  textSize: TextSize;
}) {
  const sourceLabel =
    answer.source === 'online'
      ? 'Live answer'
      : answer.source === 'offline_cache'
        ? 'From your offline cache'
        : 'No match';
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surfaceMuted, borderColor: theme.border },
      ]}
    >
      <View style={styles.sourceRow}>
        <Text
          style={[
            styles.sourceLabel,
            { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) },
          ]}
        >
          {sourceLabel}
        </Text>
      </View>
      <Text style={[styles.answer, { color: theme.text, fontSize: scaleFontSize(16, textSize) }]}>
        {answer.text}
      </Text>
      {answer.citations.length > 0 ? (
        <View style={styles.citations}>
          {answer.citations.map((c, i) => (
            <View
              key={`${c.title}-${c.clause}-${i}`}
              style={[styles.chip, { borderColor: theme.border, backgroundColor: theme.surface }]}
            >
              <Text style={{ color: theme.text, fontSize: scaleFontSize(11, textSize) }}>
                📑 {[c.title, c.revision, c.clause ? `§${c.clause}` : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '700' },
  muted: { marginBottom: spacing[2] },
  input: {
    minHeight: spacing[14] * 2,
    borderRadius: 8,
    borderWidth: 1,
    padding: spacing[3],
    textAlignVertical: 'top',
  },
  row: { flexDirection: 'row', gap: spacing[2], alignItems: 'stretch' },
  mic: {
    width: spacing[14],
    height: spacing[14],
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: spacing[3],
    gap: spacing[2],
  },
  sourceRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  sourceLabel: { fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  answer: { lineHeight: 22 },
  citations: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
  chip: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
});
