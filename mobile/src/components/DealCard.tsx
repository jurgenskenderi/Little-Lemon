import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ApiDeal } from "../api/types";
import { confidenceNote, formatDistance, statusLine } from "../format";
import { theme } from "../theme";

interface Props {
  deal: ApiDeal;
  onPress: (deal: ApiDeal) => void;
}

export function DealCard({ deal, onPress }: Props) {
  const status = statusLine(deal);
  const note = confidenceNote(deal);

  return (
    <Pressable
      onPress={() => onPress(deal)}
      accessibilityRole="button"
      accessibilityLabel={`${deal.title} at ${deal.venue.name}, ${status.text}, ${formatDistance(deal.distanceMi)} away`}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.venue} numberOfLines={1}>
          {deal.venue.name}
        </Text>
        <Text style={styles.distance}>{formatDistance(deal.distanceMi)}</Text>
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {deal.title}
      </Text>

      {deal.priceText ? <Text style={styles.price}>{deal.priceText}</Text> : null}

      {deal.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {deal.description}
        </Text>
      ) : null}

      <View style={styles.footerRow}>
        <View style={[styles.statusDot, { backgroundColor: toneColor(status.tone) }]} />
        <Text style={[styles.status, { color: toneColor(status.tone) }]}>{status.text}</Text>
        <Text style={styles.window}>{deal.matchedWindow.label}</Text>
      </View>

      {note ? <Text style={styles.note}>{note}</Text> : null}
    </Pressable>
  );
}

function toneColor(tone: "live" | "soon" | "later"): string {
  if (tone === "live") return theme.color.live;
  if (tone === "soon") return theme.color.soon;
  return theme.color.textMuted;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(4),
    marginBottom: theme.space(3),
  },
  cardPressed: {
    backgroundColor: theme.color.surfaceRaised,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(2),
  },
  venue: {
    flex: 1,
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  distance: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    fontVariant: ["tabular-nums"],
  },
  title: {
    color: theme.color.text,
    fontSize: theme.font.heading,
    fontWeight: "700",
    marginTop: theme.space(1.5),
  },
  price: {
    color: theme.color.accent,
    fontSize: theme.font.body,
    fontWeight: "600",
    marginTop: theme.space(1),
  },
  description: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    lineHeight: 21,
    marginTop: theme.space(1.5),
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.space(3),
    gap: theme.space(2),
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  status: {
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  window: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    marginLeft: "auto",
  },
  note: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
    fontStyle: "italic",
    marginTop: theme.space(2),
  },
});
