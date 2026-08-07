import * as Linking from "expo-linking";
import { Linking as RNLinking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { ApiDeal } from "../api/types";
import { categoryLabel, confidenceNote, formatDistance, statusLine } from "../format";
import { theme } from "../theme";

interface Props {
  deal: ApiDeal | null;
  onClose: () => void;
}

export function DealDetailSheet({ deal, onClose }: Props) {
  return (
    <Modal
      visible={deal !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {deal ? <DetailBody deal={deal} onClose={onClose} /> : null}
      </View>
    </Modal>
  );
}

function DetailBody({ deal, onClose }: { deal: ApiDeal; onClose: () => void }) {
  const status = statusLine(deal);
  const note = confidenceNote(deal);
  const { venue } = deal;

  const openMaps = () => {
    const label = encodeURIComponent(venue.name);
    // The geo: scheme with a label works on Android; iOS needs maps:.
    const url = `https://maps.google.com/?q=${label}@${venue.lat},${venue.lon}`;
    void RNLinking.openURL(url);
  };

  return (
    <>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}
        >
          <Text style={styles.close}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.venueName}>{venue.name}</Text>
        {venue.address ? (
          <Text style={styles.address}>
            {[venue.address, venue.city, venue.region].filter(Boolean).join(", ")}
          </Text>
        ) : null}
        <Text style={styles.distance}>{formatDistance(deal.distanceKm)} away</Text>

        <View style={styles.divider} />

        <Text style={styles.dealTitle}>{deal.title}</Text>
        {deal.priceText ? <Text style={styles.price}>{deal.priceText}</Text> : null}
        <Text style={styles.status}>{status.text}</Text>
        {deal.description ? <Text style={styles.description}>{deal.description}</Text> : null}
        <Text style={styles.category}>{categoryLabel(deal.category)}</Text>

        {deal.finePrint ? (
          <View style={styles.finePrintBox}>
            <Text style={styles.finePrintLabel}>Fine print</Text>
            <Text style={styles.finePrint}>{deal.finePrint}</Text>
          </View>
        ) : null}

        <View style={styles.divider} />

        <Text style={styles.sectionLabel}>Full schedule</Text>
        {deal.windows.map((window) => (
          <Text
            key={`${window.dayOfWeek}-${window.startMin}-${window.endMin}`}
            style={[
              styles.scheduleRow,
              window.dayOfWeek === deal.matchedWindow.dayOfWeek &&
                window.startMin === deal.matchedWindow.startMin &&
                styles.scheduleRowActive,
            ]}
          >
            {window.label}
          </Text>
        ))}

        {note ? <Text style={styles.note}>{note}</Text> : null}

        <View style={styles.actions}>
          <ActionButton label="Directions" onPress={openMaps} primary />
          {venue.phone ? (
            <ActionButton
              label="Call"
              onPress={() => void RNLinking.openURL(`tel:${venue.phone}`)}
            />
          ) : null}
          {venue.website ? (
            <ActionButton
              label="Website"
              onPress={() => void Linking.openURL(venue.website as string)}
            />
          ) : null}
        </View>

        {deal.sourceUrl ? (
          <Text style={styles.source}>
            Deal details read from {hostOf(deal.sourceUrl)}
            {deal.lastVerifiedAt ? ` · checked ${formatDate(deal.lastVerifiedAt)}` : ""}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.action,
        primary && styles.actionPrimary,
        pressed && styles.actionPressed,
      ]}
    >
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "recently"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.color.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    padding: theme.space(4),
  },
  close: {
    color: theme.color.accent,
    fontSize: theme.font.body,
    fontWeight: "600",
  },
  body: {
    paddingHorizontal: theme.space(5),
    paddingBottom: theme.space(10),
  },
  venueName: {
    color: theme.color.text,
    fontSize: theme.font.title,
    fontWeight: "700",
  },
  address: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    marginTop: theme.space(1.5),
  },
  distance: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    marginTop: theme.space(1),
  },
  divider: {
    height: 1,
    backgroundColor: theme.color.border,
    marginVertical: theme.space(5),
  },
  dealTitle: {
    color: theme.color.text,
    fontSize: theme.font.heading,
    fontWeight: "700",
  },
  price: {
    color: theme.color.accent,
    fontSize: theme.font.body,
    fontWeight: "600",
    marginTop: theme.space(1.5),
  },
  status: {
    color: theme.color.live,
    fontSize: theme.font.body,
    marginTop: theme.space(1.5),
  },
  description: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    lineHeight: 22,
    marginTop: theme.space(3),
  },
  category: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    marginTop: theme.space(2),
  },
  finePrintBox: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginTop: theme.space(4),
  },
  finePrintLabel: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  finePrint: {
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    marginTop: theme.space(1),
  },
  sectionLabel: {
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: theme.space(2),
  },
  scheduleRow: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    paddingVertical: theme.space(1),
  },
  scheduleRowActive: {
    color: theme.color.accent,
    fontWeight: "700",
  },
  note: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    fontStyle: "italic",
    marginTop: theme.space(4),
  },
  actions: {
    flexDirection: "row",
    gap: theme.space(2),
    marginTop: theme.space(6),
  },
  action: {
    flex: 1,
    paddingVertical: theme.space(3.5),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    alignItems: "center",
  },
  actionPrimary: {
    backgroundColor: theme.color.accent,
    borderColor: theme.color.accent,
  },
  actionPressed: {
    opacity: 0.75,
  },
  actionText: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
  },
  actionTextPrimary: {
    color: theme.color.accentText,
  },
  source: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
    marginTop: theme.space(6),
    textAlign: "center",
  },
});
