import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { clearCache, listSyncLog, type SyncLogEntry } from '../../src/lib/cache/database';
import { syncFromBackend } from '../../src/lib/cache/sync';
import { useNetwork } from '../../src/lib/network/useNetwork';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import { scaleFontSize } from '../../src/theme/index';

/**
 * Logs tab - sync history + cache controls.
 *
 * Sync is a stub (see lib/cache/sync.ts TODO) but the UI is honest: it
 * tells the user when the last sync happened, what's queued, and lets
 * them clear the cache manually. Useful field debugging when the
 * offline answer disagrees with the live one.
 */
export default function LogsScreen() {
  const theme = useFieldTheme();
  const session = useSessionStore();
  const network = useNetwork();
  const textSize = session.preferences.textSize;

  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSyncLog(20).then((rows) => {
      if (!cancelled) setEntries(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [busy]);

  async function runSync() {
    if (!session.token) return;
    setBusy(true);
    try {
      const result = await syncFromBackend({
        baseUrl: session.apiBaseUrl,
        token: session.token,
      });
      Alert.alert('Sync result', result.note);
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setBusy(true);
    try {
      await clearCache();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(22, textSize) }]}
      >
        Sync + Logs
      </Text>

      {!network.online ? (
        <Banner tone="warn" title="Offline" theme={theme} textSize={textSize}>
          Sync requires connectivity. Outgoing reports will queue until you&apos;re back online.
        </Banner>
      ) : null}

      <Banner tone="info" title="Sync stub" theme={theme} textSize={textSize}>
        Tenant SOP snapshot sync needs a backend endpoint that isn&apos;t wired yet. The bundled
        seed answers offline questions in the meantime.
      </Banner>

      <View style={styles.actions}>
        <PrimaryButton
          label="Pull tenant snapshot"
          onPress={runSync}
          disabled={busy || !network.online}
          theme={theme}
          textSize={textSize}
        />
        <PrimaryButton
          label="Clear cache"
          variant="danger"
          onPress={onClear}
          disabled={busy}
          theme={theme}
          textSize={textSize}
        />
      </View>

      <Text
        style={[
          styles.section,
          { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) },
        ]}
      >
        Recent sync events
      </Text>
      {entries.length === 0 ? (
        <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(13, textSize) }}>
          No events yet.
        </Text>
      ) : (
        entries.map((entry) => (
          <View
            key={entry.id}
            style={[styles.entry, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
          >
            <Text style={[styles.entryKind, { color: theme.text, fontSize: scaleFontSize(12, textSize) }]}>
              {entry.kind}
            </Text>
            <Text style={[styles.entryDetail, { color: theme.textMuted, fontSize: scaleFontSize(12, textSize) }]}>
              {entry.detail ?? '-'}
            </Text>
            <Text style={[styles.entryTs, { color: theme.textMuted, fontSize: scaleFontSize(11, textSize) }]}>
              {entry.occurred_utc}
            </Text>
          </View>
        ))
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '700' },
  actions: { gap: spacing[2] },
  section: { textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing[2] },
  entry: {
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing[3],
    gap: 2,
  },
  entryKind: { fontWeight: '700', textTransform: 'uppercase' },
  entryDetail: {},
  entryTs: { fontFamily: 'Courier' },
});
