import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import MapView, { Circle, Marker, PROVIDER_GOOGLE, type Region } from "react-native-maps";

import type { ApiDeal } from "../api/types";
import { formatDistance, statusLine } from "../format";
import type { Coordinates } from "../hooks/useLocation";
import { theme } from "../theme";
import { DealImage } from "./DealImage";
import { DARK_MAP_STYLE } from "./mapStyle";

interface Props {
  deals: ApiDeal[];
  origin: Coordinates;
  radiusKm: number;
  /** GPS uncertainty in metres, drawn so the user can see how much to trust it. */
  accuracyM: number | null;
  onOpen: (deal: ApiDeal) => void;
  onSearchArea: (centre: Coordinates) => void;
  onRecentre: () => void;
  /** Long-press hands the user a way to correct a bad fix themselves. */
  onSetLocation: (point: Coordinates) => void;
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const CARD_WIDTH = Math.min(SCREEN_WIDTH * 0.78, 300);
const CARD_GAP = 10;
const CARD_STRIDE = CARD_WIDTH + CARD_GAP;

/** Fit the search circle in frame: one degree of latitude is about 111 km. */
function regionFor(centre: Coordinates, radiusKm: number): Region {
  const latitudeDelta = Math.max((radiusKm * 2.5) / 111, 0.008);
  return {
    latitude: centre.lat,
    longitude: centre.lon,
    latitudeDelta,
    // Longitude degrees narrow away from the equator, so the circle stays
    // round rather than squashed at Toronto's latitude.
    longitudeDelta: latitudeDelta / Math.cos((centre.lat * Math.PI) / 180),
  };
}

export function DealMap({
  deals, origin, radiusKm, accuracyM, onOpen, onSearchArea, onRecentre, onSetLocation,
}: Props) {
  const mapRef = useRef<MapView>(null);
  const listRef = useRef<FlatList<ApiDeal>>(null);
  const region = useRef<Region>(regionFor(origin, radiusKm));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drifted, setDrifted] = useState(false);

  // Follow the search origin when it changes, but never fight an active pan.
  useEffect(() => {
    setDrifted(false);
    mapRef.current?.animateToRegion(regionFor(origin, radiusKm), 350);
  }, [origin.lat, origin.lon, radiusKm]);

  const focus = useCallback(
    (deal: ApiDeal, { scrollList = true } = {}) => {
      setSelectedId(deal.id);
      mapRef.current?.animateCamera(
        { center: { latitude: deal.venue.lat, longitude: deal.venue.lon } },
        { duration: 320 },
      );
      if (scrollList) {
        const index = deals.findIndex((candidate) => candidate.id === deal.id);
        if (index >= 0) listRef.current?.scrollToOffset({ offset: index * CARD_STRIDE, animated: true });
      }
    },
    [deals],
  );

  // Swiping the card strip drives the map, the way a places carousel does.
  const onCardSettled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(event.nativeEvent.contentOffset.x / CARD_STRIDE);
      const deal = deals[index];
      if (deal && deal.id !== selectedId) focus(deal, { scrollList: false });
    },
    [deals, selectedId, focus],
  );

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        // Google on Android for the custom dark style; Apple Maps on iOS,
        // which needs no key and already follows the system appearance.
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        customMapStyle={Platform.OS === "android" ? DARK_MAP_STYLE : undefined}
        userInterfaceStyle="dark"
        initialRegion={region.current}
        showsUserLocation
        showsMyLocationButton={false}
        // A compass once you rotate, and a scale bar, so the map reads the way
        // people expect one to. Our own recentre button replaces the platform's.
        showsCompass
        showsScale
        toolbarEnabled={false}
        onPress={() => setSelectedId(null)}
        onLongPress={(event) => {
          const { latitude, longitude } = event.nativeEvent.coordinate;
          onSetLocation({ lat: latitude, lon: longitude });
        }}
        onRegionChange={(next) => {
          region.current = next;
        }}
        onRegionChangeComplete={(next) => {
          region.current = next;
          const drift =
            Math.abs(next.latitude - origin.lat) + Math.abs(next.longitude - origin.lon);
          // Only offer to re-search once the pan is meaningful for this zoom,
          // so the button doesn't flicker on incidental drags.
          setDrifted(drift > next.latitudeDelta * 0.28);
        }}
      >
        <Circle
          center={{ latitude: origin.lat, longitude: origin.lon }}
          radius={radiusKm * 1000}
          strokeColor="rgba(232,184,75,0.55)"
          fillColor="rgba(232,184,75,0.08)"
          strokeWidth={1.5}
        />

        {/* How sure the device is. Drawn only when it is big enough to matter,
            so a good fix does not show a distracting blob. */}
        {accuracyM !== null && accuracyM > 40 ? (
          <Circle
            center={{ latitude: origin.lat, longitude: origin.lon }}
            radius={accuracyM}
            strokeColor="rgba(120,160,255,0.5)"
            fillColor="rgba(120,160,255,0.12)"
            strokeWidth={1}
          />
        ) : null}

        {deals.map((deal) => {
          const selected = deal.id === selectedId;
          const colour = deal.partner
            ? theme.color.accent
            : deal.activeNow
              ? theme.color.live
              : theme.color.textMuted;

          return (
            <Marker
              key={deal.id}
              coordinate={{ latitude: deal.venue.lat, longitude: deal.venue.lon }}
              onPress={() => focus(deal)}
              // Re-rendering a marker view every frame is expensive; only the
              // selected one changes appearance, so only it needs tracking.
              tracksViewChanges={selected}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={selected ? 10 : 1}
            >
              <View
                style={[
                  styles.pill,
                  { borderColor: colour },
                  selected && { backgroundColor: colour, transform: [{ scale: 1.08 }] },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.pillText,
                    { color: selected ? theme.color.accentText : theme.color.text },
                  ]}
                >
                  {deal.priceText ?? deal.title}
                </Text>
              </View>
            </Marker>
          );
        })}
      </MapView>

      {drifted ? (
        <Pressable
          style={styles.searchArea}
          accessibilityRole="button"
          onPress={() => {
            setDrifted(false);
            onSearchArea({ lat: region.current.latitude, lon: region.current.longitude });
          }}
        >
          <Text style={styles.searchAreaText}>Search this area</Text>
        </Pressable>
      ) : null}

      <View style={styles.fabs}>
        <View style={styles.zoomStack}>
          <Pressable
            style={styles.zoomButton}
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            onPress={() => zoom(mapRef, 1)}
          >
            <Text style={styles.zoomText}>+</Text>
          </Pressable>
          <View style={styles.zoomDivider} />
          <Pressable
            style={styles.zoomButton}
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            onPress={() => zoom(mapRef, -1)}
          >
            <Text style={styles.zoomText}>−</Text>
          </Pressable>
        </View>
        <Pressable
          style={styles.fab}
          accessibilityRole="button"
          accessibilityLabel="Centre on my location"
          onPress={() => {
            setDrifted(false);
            onRecentre();
          }}
        >
          <Text style={styles.fabIcon}>◎</Text>
        </Pressable>
      </View>

      {deals.length > 0 ? (
        <FlatList
          ref={listRef}
          data={deals}
          keyExtractor={(deal) => deal.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={CARD_STRIDE}
          decelerationRate="fast"
          contentContainerStyle={styles.carousel}
          onMomentumScrollEnd={onCardSettled}
          style={styles.carouselWrap}
          renderItem={({ item }) => {
            const status = statusLine(item);
            const selected = item.id === selectedId;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title} at ${item.venue.name}`}
                style={[styles.card, selected && styles.cardActive]}
                onPress={() => (selected ? onOpen(item) : focus(item))}
              >
                <View style={styles.cardRow}>
                <DealImage deal={item} style={styles.cardThumb} />
                <View style={styles.cardText}>
                <View style={styles.cardTop}>
                  {item.partner ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>PARTNER</Text>
                    </View>
                  ) : null}
                  <Text style={styles.cardVenue} numberOfLines={1}>
                    {item.venue.name}
                  </Text>
                </View>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {item.priceText ? (
                  <Text style={styles.cardPrice} numberOfLines={1}>
                    {item.priceText}
                  </Text>
                ) : null}
                </View>
                </View>
                <View style={styles.cardFoot}>
                  <Text style={[styles.cardStatus, { color: toneColour(status.tone) }]}>
                    {status.text}
                  </Text>
                  <Text style={styles.cardDist}>{formatDistance(item.distanceKm)}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      ) : null}
    </View>
  );
}

/** react-native-maps has no relative zoom, so read the camera and adjust it. */
function zoom(ref: React.RefObject<MapView | null>, delta: number): void {
  void ref.current?.getCamera().then((camera) => {
    if (camera.zoom !== undefined) {
      ref.current?.animateCamera({ zoom: camera.zoom + delta }, { duration: 220 });
    } else if (camera.altitude !== undefined) {
      // Apple Maps reports altitude rather than a zoom level.
      ref.current?.animateCamera(
        { altitude: delta > 0 ? camera.altitude / 2 : camera.altitude * 2 },
        { duration: 220 },
      );
    }
  });
}

function toneColour(tone: "live" | "soon" | "later"): string {
  if (tone === "live") return theme.color.live;
  if (tone === "soon") return theme.color.soon;
  return theme.color.textMuted;
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  pill: {
    backgroundColor: theme.color.surface,
    borderWidth: 1.5,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(2.5),
    paddingVertical: theme.space(1.25),
    maxWidth: 130,
  },
  pillText: { fontSize: theme.font.tiny, fontWeight: "700" },

  searchArea: {
    position: "absolute",
    top: theme.space(3),
    alignSelf: "center",
    paddingHorizontal: theme.space(5),
    paddingVertical: theme.space(2.5),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.accent,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  searchAreaText: {
    color: theme.color.accentText,
    fontWeight: "700",
    fontSize: theme.font.small,
  },

  fabs: {
    position: "absolute",
    right: theme.space(3),
    bottom: 190,
    gap: theme.space(2),
  },
  zoomStack: {
    borderRadius: theme.radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  zoomButton: { width: 40, height: 38, alignItems: "center", justifyContent: "center" },
  zoomDivider: { height: 1, backgroundColor: theme.color.border },
  zoomText: { color: theme.color.text, fontSize: 19, lineHeight: 22 },
  fab: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  fabIcon: { color: theme.color.text, fontSize: 17 },

  carouselWrap: { position: "absolute", left: 0, right: 0, bottom: theme.space(4) },
  carousel: { paddingHorizontal: theme.space(4), gap: CARD_GAP },
  card: {
    width: CARD_WIDTH,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space(3.5),
  },
  cardActive: { borderColor: theme.color.accent },
  cardRow: { flexDirection: "row", gap: theme.space(2.5) },
  cardText: { flex: 1, minWidth: 0 },
  cardThumb: { width: 46, height: 46, borderRadius: theme.radius.sm },
  cardTop: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  badge: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(1.5),
    paddingVertical: theme.space(0.5),
  },
  badgeText: {
    color: theme.color.accentText,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  cardVenue: {
    flexShrink: 1,
    color: theme.color.textMuted,
    fontSize: theme.font.tiny,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  cardTitle: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "700",
    marginTop: theme.space(1),
  },
  cardPrice: { color: theme.color.accent, fontSize: theme.font.small, marginTop: theme.space(0.5) },
  cardFoot: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: theme.space(2),
  },
  cardStatus: { fontSize: theme.font.tiny, fontWeight: "700" },
  cardDist: { color: theme.color.textFaint, fontSize: theme.font.tiny },
});
