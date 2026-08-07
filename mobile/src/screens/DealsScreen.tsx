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
import { FilterBar } from "../components/FilterBar";
import { useDeals } from "../hooks/useDeals";
import { useLocation } from "../hooks/useLocation";
import { theme } from "../theme";
import { DEFAULT_TIME_CHOICE, type TimeChoice } from "../timeChoices";
import { DealDetailSheet } from "./DealDetailSheet";

/** Used when location is unavailable so the app is still explorable. */
const FALLBACK_LOCATION = { lat: 47.6142, lon: -122.3283, label: "Downtown Seattle" };

export function DealsScreen() {
  const location = useLocation();
  const [radiusMi, setRadiusMi] = useState(1);
  const [timeChoice, setTimeChoice] = useState<TimeChoice>(DEFAULT_TIME_CHOICE);
  const [category, setCategory] = useState<DealCategory | null>(null);
  const [selected, setSelected] = useState<ApiDeal | null>(null);

  // Recomputed only when the choice changes, so "now" does not tick every
  // render and retrigger the search on each frame.
  const resolved = useMemo(() => timeChoice.resolve(new Date()), [timeChoice]);

  const query = location.coords
    ? {
        lat: location.coords.lat,
        lon: location.coords.lon,
        radiusMi,
        at: resolved.at,
        windowMin: resolved.windowMin,
        category: category ?? undefined,
      }
    : null;

  const { deals, loading, refreshing, error, refresh } = useDeals(query);

  if (!location.coords) {
    return (
      <SafeAreaView style={styles.screen}>
        <LocationGate location={location} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <FlatList
        data={deals}
        keyExtractor={(deal) => deal.id}
        renderItem={({ item }) => <DealCard deal={item} onPress={setSelected} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.color.accent}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.title}>Happy hours</Text>
              <Text style={styles.subtitle}>
                {location.usingFallback
                  ? `Searching around ${FALLBACK_LOCATION.label}`
                  : "Near you, right now"}
              </Text>
            </View>
            <FilterBar
              radiusMi={radiusMi}
              onRadiusChange={setRadiusMi}
              timeChoice={timeChoice}
              onTimeChange={setTimeChoice}
              category={category}
              onCategoryChange={setCategory}
              resolvedAt={resolved.at}
            />
            <ResultSummary count={deals.length} loading={loading} error={error} />
          </View>
        }
        ListEmptyComponent={
          loading ? null : <EmptyState error={error} radiusMi={radiusMi} onRetry={refresh} />
        }
      />

      <DealDetailSheet deal={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
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
  radiusMi,
  onRetry,
}: {
  error: string | null;
  radiusMi: number;
  onRetry: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{error ? "Couldn't load deals" : "Nothing nearby"}</Text>
      <Text style={styles.emptyBody}>
        {error ??
          `No happy hours within ${radiusMi} ${radiusMi === 1 ? "mile" : "miles"} at that time. ` +
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
            {location.error ?? "Little Lemon needs a starting point to search from."}
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
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(10),
  },
  header: {
    paddingTop: theme.space(4),
    paddingBottom: theme.space(4),
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
  summaryRow: {
    minHeight: 28,
    justifyContent: "center",
    marginBottom: theme.space(2),
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
