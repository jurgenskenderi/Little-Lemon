import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native";

import type { ApiDeal, DealCategory } from "../api/types";
import { DealCard } from "../components/DealCard";
import { DealMap } from "../components/DealMap";
import { FilterBar } from "../components/FilterBar";
import { useDeals } from "../hooks/useDeals";
import { useLocation, type Coordinates } from "../hooks/useLocation";
import { theme } from "../theme";
import { DEFAULT_TIME_CHOICE, type TimeChoice } from "../timeChoices";
import { DealDetailSheet } from "./DealDetailSheet";

/** Used when location is unavailable so the app is still explorable. */
const FALLBACK_LOCATION = { lat: 43.6487, lon: -79.398, label: "Downtown Toronto" };

export function DealsScreen() {
  const location = useLocation();
  const [radiusKm, setRadiusKm] = useState(2);
  const [timeChoice, setTimeChoice] = useState<TimeChoice>(DEFAULT_TIME_CHOICE);
  const [category, setCategory] = useState<DealCategory | null>(null);
  const [selected, setSelected] = useState<ApiDeal | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  /** Set when the user pans the map and asks to search there instead. */
  const [areaOverride, setAreaOverride] = useState<Coordinates | null>(null);

  // Recomputed only when the choice changes, so "now" does not tick every
  // render and retrigger the search on each frame.
  const resolved = useMemo(() => timeChoice.resolve(new Date()), [timeChoice]);

  // A map "search this area" wins over the device fix until it is cleared.
  const origin = areaOverride ?? location.coords;

  const query = origin
    ? {
        lat: origin.lat,
        lon: origin.lon,
        radiusKm,
        at: resolved.at,
        windowMin: resolved.windowMin,
        category: category ?? undefined,
      }
    : null;

  const { deals, loading, refreshing, error, refresh } = useDeals(query);

  if (!origin) {
    return (
      <SafeAreaView style={styles.screen}>
        <LocationGate location={location} />
      </SafeAreaView>
    );
  }

  const header = (
    <View>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Happy hours</Text>
            <Text style={styles.subtitle}>{locationSummary(location, areaOverride !== null)}</Text>
          </View>
          <Pressable
            onPress={() => setView(view === "list" ? "map" : "list")}
            accessibilityRole="button"
            accessibilityLabel={view === "list" ? "Show map" : "Show list"}
            style={styles.viewToggle}
          >
            <Text style={styles.viewToggleText}>{view === "list" ? "Map" : "List"}</Text>
          </Pressable>
        </View>
        {areaOverride ? (
          <Pressable onPress={() => setAreaOverride(null)} accessibilityRole="button">
            <Text style={styles.resetArea}>Back to my location</Text>
          </Pressable>
        ) : location.imprecise ? (
          <Pressable onPress={() => setView("map")} accessibilityRole="button">
            <Text style={styles.resetArea}>
              Not where you are? Open the map and hold to drop a pin
            </Text>
          </Pressable>
        ) : null}
      </View>
      <FilterBar
        radiusKm={radiusKm}
        onRadiusChange={setRadiusKm}
        timeChoice={timeChoice}
        onTimeChange={setTimeChoice}
        category={category}
        onCategoryChange={setCategory}
        resolvedAt={resolved.at}
      />
      <ResultSummary count={deals.length} loading={loading} error={error} />
    </View>
  );

  if (view === "map") {
    return (
      <SafeAreaView style={styles.screen}>
        {header}
        <DealMap
          deals={deals}
          origin={origin}
          radiusKm={radiusKm}
          accuracyM={areaOverride ? null : location.accuracyM}
          onOpen={setSelected}
          onSearchArea={(centre) => setAreaOverride(centre)}
          onRecentre={() => setAreaOverride(null)}
          onSetLocation={(point) => {
            setAreaOverride(null);
            location.setManual(point);
          }}
        />
        <DealDetailSheet deal={selected} onClose={() => setSelected(null)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <FlatList
        data={deals}
        keyExtractor={(deal) => deal.id}
        renderItem={({ item }) => (
          <View style={styles.cardWrapper}>
            <DealCard deal={item} onPress={setSelected} />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.color.accent}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? null : <EmptyState error={error} radiusKm={radiusKm} onRetry={refresh} />
        }
      />

      <DealDetailSheet deal={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
}

/**
 * One line describing where results are coming from. Accuracy is surfaced
 * rather than hidden: "within 2 km" means nothing if the starting point is
 * itself a kilometre out, and the user is the only one who can correct it.
 */
function locationSummary(
  location: ReturnType<typeof useLocation>,
  pinnedToArea: boolean,
): string {
  if (pinnedToArea) return "Searching the area you picked on the map";
  if (location.usingFallback) return `Searching around ${FALLBACK_LOCATION.label}`;
  if (location.accuracyM === null) return "Near you, right now";
  if (location.accuracyM > 250) {
    return `Near you — but your location is only accurate to ${formatAccuracy(location.accuracyM)}`;
  }
  return `Near you, accurate to ${formatAccuracy(location.accuracyM)}`;
}

function formatAccuracy(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

function ResultSummary({
  count,
  loading,
  error,
}: {
  count: number;
  loading: boolean;
  error: string | null;
}) {
  if (error) return null;
  return (
    <View style={styles.summaryRow}>
      {loading ? (
        <ActivityIndicator size="small" color={theme.color.accent} />
      ) : (
        <Text style={styles.summary}>
          {count === 0 ? "No deals found" : `${count} ${count === 1 ? "deal" : "deals"}`}
        </Text>
      )}
    </View>
  );
}

function EmptyState({
  error,
  radiusKm,
  onRetry,
}: {
  error: string | null;
  radiusKm: number;
  onRetry: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{error ? "Couldn't load deals" : "Nothing nearby"}</Text>
      <Text style={styles.emptyBody}>
        {error ??
          `No happy hours within ${radiusKm} km at that time. ` +
            "Try widening the distance or picking a different time."}
      </Text>
      {error ? (
        <Pressable onPress={onRetry} style={styles.retry} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function LocationGate({ location }: { location: ReturnType<typeof useLocation> }) {
  const waiting = location.status === "requesting" || location.status === "idle";

  return (
    <View style={styles.gate}>
      <Text style={styles.title}>Happy hours</Text>
      {waiting ? (
        <>
          <ActivityIndicator color={theme.color.accent} style={styles.gateSpinner} />
          <Text style={styles.emptyBody}>Finding your location…</Text>
        </>
      ) : (
        <>
          <Text style={styles.emptyBody}>
            {location.error ?? "Clocktails needs a starting point to search from."}
          </Text>
          <Pressable
            onPress={() => void location.request()}
            style={styles.retry}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>Use my location</Text>
          </Pressable>
          <Pressable
            onPress={() => location.useFallback(FALLBACK_LOCATION)}
            accessibilityRole="button"
          >
            <Text style={styles.gateAlt}>Browse {FALLBACK_LOCATION.label} instead</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.background,
  },
  listContent: {
    paddingBottom: theme.space(10),
  },
  header: {
    paddingTop: theme.space(4),
    paddingBottom: theme.space(4),
    paddingHorizontal: theme.space(4),
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.space(3),
  },
  headerText: { flex: 1 },
  viewToggle: {
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  viewToggleText: {
    color: theme.color.text,
    fontSize: theme.font.small,
    fontWeight: "700",
  },
  resetArea: {
    color: theme.color.accent,
    fontSize: theme.font.small,
    marginTop: theme.space(2),
    textDecorationLine: "underline",
  },
  title: {
    color: theme.color.text,
    fontSize: theme.font.title,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  subtitle: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    marginTop: theme.space(1),
  },
  cardWrapper: {
    paddingHorizontal: theme.space(4),
  },
  summaryRow: {
    minHeight: 28,
    justifyContent: "center",
    marginBottom: theme.space(2),
    paddingHorizontal: theme.space(4),
  },
  summary: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  empty: {
    alignItems: "center",
    paddingVertical: theme.space(12),
    paddingHorizontal: theme.space(4),
  },
  emptyTitle: {
    color: theme.color.text,
    fontSize: theme.font.heading,
    fontWeight: "700",
    marginBottom: theme.space(2),
  },
  emptyBody: {
    color: theme.color.textMuted,
    fontSize: theme.font.body,
    lineHeight: 22,
    textAlign: "center",
  },
  retry: {
    marginTop: theme.space(5),
    paddingHorizontal: theme.space(6),
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.accent,
  },
  retryText: {
    color: theme.color.accentText,
    fontSize: theme.font.body,
    fontWeight: "700",
  },
  gate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space(8),
    gap: theme.space(3),
  },
  gateSpinner: {
    marginTop: theme.space(4),
  },
  gateAlt: {
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    marginTop: theme.space(4),
    textDecorationLine: "underline",
  },
});
