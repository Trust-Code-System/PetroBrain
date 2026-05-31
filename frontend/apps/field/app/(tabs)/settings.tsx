import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { colors, spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import { scaleFontSize } from '../../src/theme/index';
import {
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  TEXT_SIZES,
  type Language,
  type TextSize,
} from '../../src/lib/settings/preferences';

const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  pidgin: 'Nigerian Pidgin (planned)',
  yo: 'Yorùbá (planned)',
  ha: 'Hausa (planned)',
};

const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  small: 'Small',
  medium: 'Medium (default)',
  large: 'Large',
};

export default function SettingsScreen() {
  const theme = useFieldTheme();
  const session = useSessionStore();
  const textSize = session.preferences.textSize;
  const [apiUrl, setApiUrl] = useState(session.apiBaseUrl);

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(22, textSize) }]}
      >
        Settings
      </Text>

      {session.principal ? (
        <View style={[styles.principal, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) }]}>
            Signed in
          </Text>
          <Text style={[styles.value, { color: theme.text, fontSize: scaleFontSize(16, textSize) }]}>
            {session.principal.userId} - {session.principal.role}
          </Text>
          <Text style={[styles.value, { color: theme.textMuted, fontSize: scaleFontSize(12, textSize) }]}>
            tenant: {session.principal.tenantId}
          </Text>
        </View>
      ) : null}

      <Section title="Language" theme={theme} textSize={textSize}>
        {LANGUAGES.map((lang) => {
          const supported = SUPPORTED_LANGUAGES.has(lang);
          const isActive = session.preferences.language === lang;
          return (
            <Pressable
              key={lang}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActive, disabled: !supported }}
              disabled={!supported}
              onPress={() => session.setLanguage(lang)}
              style={[
                styles.option,
                {
                  backgroundColor: isActive ? theme.banner.info : theme.surface,
                  borderColor: isActive ? theme.bannerFg.info : theme.border,
                  opacity: supported ? 1 : 0.55,
                },
              ]}
            >
              <Text
                style={{
                  color: isActive ? theme.bannerFg.info : theme.text,
                  fontSize: scaleFontSize(15, textSize),
                  fontWeight: '600',
                }}
              >
                {LANGUAGE_LABELS[lang]}
              </Text>
            </Pressable>
          );
        })}
      </Section>

      <Section title="Text size" theme={theme} textSize={textSize}>
        {TEXT_SIZES.map((size) => {
          const isActive = size === session.preferences.textSize;
          return (
            <Pressable
              key={size}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActive }}
              onPress={() => session.setTextSize(size)}
              style={[
                styles.option,
                {
                  backgroundColor: isActive ? theme.banner.info : theme.surface,
                  borderColor: isActive ? theme.bannerFg.info : theme.border,
                },
              ]}
            >
              <Text
                style={{
                  color: isActive ? theme.bannerFg.info : theme.text,
                  fontSize: scaleFontSize(15, textSize),
                  fontWeight: '600',
                }}
              >
                {TEXT_SIZE_LABELS[size]}
              </Text>
            </Pressable>
          );
        })}
      </Section>

      <Section title="API base URL" theme={theme} textSize={textSize}>
        <TextInput
          value={apiUrl}
          onChangeText={setApiUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://localhost:8000"
          placeholderTextColor={theme.textMuted}
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
        <PrimaryButton
          label="Save API URL"
          variant="secondary"
          onPress={() => session.setApiBaseUrl(apiUrl.trim())}
          theme={theme}
          textSize={textSize}
        />
      </Section>

      <Banner tone="info" title="More languages coming" theme={theme} textSize={textSize}>
        Pidgin, Yorùbá, and Hausa are stubs today. Localised strings + TTS voices land once the
        translation pipeline is wired.
      </Banner>

      <PrimaryButton
        label="Sign out"
        variant="danger"
        onPress={async () => {
          await session.setToken(null);
          router.replace('/auth');
        }}
        theme={theme}
        textSize={textSize}
      />

      <Text style={{ color: colors.neutral[400], fontSize: scaleFontSize(11, textSize), textAlign: 'center' }}>
        PetroBrain Field · scaffold v0.1.0
      </Text>
    </ScreenContainer>
  );
}

function Section({
  title,
  theme,
  textSize,
  children,
}: {
  title: string;
  theme: ReturnType<typeof useFieldTheme>;
  textSize: TextSize;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text
        style={[
          styles.sectionTitle,
          { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) },
        ]}
      >
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '700' },
  section: { gap: spacing[2] },
  sectionTitle: { fontWeight: '600', letterSpacing: 0.5 },
  principal: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing[3],
    gap: 2,
  },
  label: { fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  value: {},
  option: {
    minHeight: spacing[14],
    paddingHorizontal: spacing[3],
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  input: {
    minHeight: spacing[14],
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing[3],
    fontFamily: 'Courier',
  },
});
