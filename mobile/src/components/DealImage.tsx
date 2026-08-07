import { useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { ApiDeal } from "../api/types";
import { theme } from "../theme";

interface Props {
  deal: ApiDeal;
  /** Sizing only — the same box is used for the photo and for the fallback. */
  style?: StyleProp<ImageStyle>;
  rounded?: number;
}

/**
 * The photo for a deal, with a graceful floor.
 *
 * Images come from the venue's own site, so they fail in all the ordinary ways:
 * hotlink protection, an expired CDN path, a site that moved. Rather than leave
 * a hole in the card, an unavailable photo falls back to a tinted panel keyed to
 * what is on offer — recognisable at a glance, and honest, because it is
 * obviously a symbol rather than a photograph of that venue's food.
 */
export function DealImage({ deal, style, rounded = theme.radius.sm }: Props) {
  const [failed, setFailed] = useState(false);
  const showPhoto = deal.imageUrl !== null && !failed;

  if (showPhoto) {
    return (
      <Image
        source={{ uri: deal.imageUrl as string }}
        style={[styles.base, { borderRadius: rounded }, style]}
        resizeMode="cover"
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
        accessible
        accessibilityLabel={`Photo from ${deal.venue.name}`}
      />
    );
  }

  const { glyph, tint } = symbolFor(deal);
  return (
    <View
      style={
        [
          styles.base,
          styles.fallback,
          { borderRadius: rounded, backgroundColor: tint },
          // Width, height and radius are valid on both; ImageStyle is the
          // narrower of the two, so it is what the prop accepts.
          style as StyleProp<ViewStyle>,
        ] as StyleProp<ViewStyle>
      }
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.glyph}>{glyph}</Text>
    </View>
  );
}

/** Pick a symbol from what the deal actually mentions, not from the category alone. */
function symbolFor(deal: ApiDeal): { glyph: string; tint: string } {
  const text = `${deal.title} ${deal.priceText ?? ""} ${deal.description ?? ""}`.toLowerCase();

  if (/oyster|seafood|shuck/.test(text)) return { glyph: "🦪", tint: "#1E2E33" };
  if (/taco|burrito|nacho|margarita/.test(text)) return { glyph: "🌮", tint: "#2E241A" };
  if (/wine|bottle|prosecco|sparkling|sangria/.test(text)) return { glyph: "🍷", tint: "#2B1D22" };
  if (/cocktail|negroni|spritz|martini|highball|whisk/.test(text)) return { glyph: "🍸", tint: "#22262E" };
  if (/pint|draft|draught|beer|lager|ale|cider|taproom/.test(text)) return { glyph: "🍺", tint: "#2C2415" };
  if (/wing|burger|slider|fries|pizza/.test(text)) return { glyph: "🍔", tint: "#2B221A" };
  if (/coffee|brunch|mimosa/.test(text)) return { glyph: "🥂", tint: "#26221A" };
  if (deal.category === "food") return { glyph: "🍽️", tint: "#252A26" };
  if (deal.category === "drink") return { glyph: "🥃", tint: "#26221C" };
  return { glyph: "🍋", tint: "#242A24" };
}

const styles = StyleSheet.create({
  base: { backgroundColor: theme.color.surfaceRaised },
  fallback: { alignItems: "center", justifyContent: "center" },
  glyph: { fontSize: 26 },
});
