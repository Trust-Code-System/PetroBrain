import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@petrobrain/ui/tokens';

import { Banner } from '../../src/components/Banner';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { deletePermit, listPermits } from '../../src/lib/ptw/repository';
import { useSessionStore } from '../../src/lib/session/store';
import { useFieldTheme } from '../../src/lib/session/useColorMode';
import { scaleFontSize, type FieldTheme } from '../../src/theme/index';
import type { TextSize } from '../../src/lib/settings/preferences';
import type { SavedPermit } from '../../src/lib/ptw/types';

/**
 * PTW landing tab - list of locally saved permits + "Create new".
 *
 * Drafts (status=draft_unsigned) and signed permits live alongside;
 * status badge + timestamp tell them apart. Tapping a row opens
 * /ptw/{id} for review / signing / export.
 */
export default function PtwScreen() {
  const theme = useFieldTheme();
  const principal = useSessionStore((s) => s.principal);
  const textSize = useSessionStore((s) => s.preferences.textSize);
  const [permits, setPermits] = useState<SavedPermit[]>([]);
  const [refreshing, setRefreshing] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!principal) return;
    listPermits(principal.tenantId).then((rows) => {
      if (!cancelled) setPermits(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [principal, refreshing]);

  if (!principal) {
    return (
      <ScreenContainer theme={theme} textSize={textSize}>
        <Banner tone="warn" title="Sign in required" theme={theme} textSize={textSize}>
          Sign in to use the PTW workflow - permits are saved under your principal.
        </Banner>
      </ScreenContainer>
    );
  }

  async function onDelete(permit: SavedPermit) {
    Alert.alert(
      'Delete permit?',
      `${permit.generated.permit_id} will be removed from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deletePermit(permit.tenant_id, permit.id);
            setRefreshing((r) => r + 1);
          },
        },
      ],
    );
  }

  return (
    <ScreenContainer theme={theme} textSize={textSize}>
      <View style={styles.headerRow}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.text, fontSize: scaleFontSize(22, textSize) }]}
        >
          Permits to Work
        </Text>
        <PrimaryButton
          label="New permit"
          onPress={() => router.push('/ptw/new')}
          theme={theme}
          textSize={textSize}
        />
      </View>

      <Banner tone="info" title="Decision support" theme={theme} textSize={textSize}>
        Drafts generated here are not authoritative. The Permit Issuer and Performing Authority
        sign before work begins. Signatures captured here live on this device and queue for
        backend sync.
      </Banner>

      {permits.length === 0 ? (
        <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(14, textSize) }}>
          No saved permits yet. Tap “New permit” to draft one.
        </Text>
      ) : (
        permits.map((permit) => (
          <Pressable
            key={permit.id}
            onPress={() => router.push({ pathname: '/ptw/[id]', params: { id: permit.id } })}
            onLongPress={() => onDelete(permit)}
            style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={[styles.rowTitle, { color: theme.text, fontSize: scaleFontSize(15, textSize) }]}
              >
                {permit.generated.job_description}
              </Text>
              <Text
                style={[styles.rowMeta, { color: theme.textMuted, fontSize: scaleFontSize(12, textSize) }]}
              >
                {permit.generated.work_type} · {permit.generated.location}
              </Text>
              <Text style={{ color: theme.textMuted, fontSize: scaleFontSize(11, textSize) }}>
                {permit.format === 'toolbox_talk' ? 'toolbox talk' : 'permit'} · updated{' '}
                {permit.updated_utc.slice(0, 16).replace('T', ' ')}
              </Text>
            </View>
            <StatusPill status={permit.status} theme={theme} textSize={textSize} />
          </Pressable>
        ))
      )}
    </ScreenContainer>
  );
}

function StatusPill({
  status,
  theme,
  textSize,
}: {
  status: SavedPermit['status'];
  theme: FieldTheme;
  textSize: TextSize;
}) {
  const tone: 'safe' | 'warn' = status === 'signed' ? 'safe' : 'warn';
  const label = status === 'signed' ? 'signed' : 'draft';
  return (
    <View
      style={{
        backgroundColor: theme.banner[tone],
        borderColor: theme.bannerFg[tone],
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: spacing[2],
        paddingVertical: 4,
      }}
    >
      <Text style={{ color: theme.bannerFg[tone], fontWeight: '700', fontSize: scaleFontSize(11, textSize) }}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing[3],
    minHeight: spacing[14],
  },
  rowTitle: { fontWeight: '600' },
  rowMeta: { fontWeight: '400' },
});
