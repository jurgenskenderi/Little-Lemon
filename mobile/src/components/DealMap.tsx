import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Circle, type Region } from "react-native-maps";

import type { ApiDeal } from "../api/types";
import type { Coordinates } from "../hooks/useLocation";
import { formatDistance, statusLine } from "../format";
import { theme } from "../theme";

interface Props {
  deals: ApiDeal[];
  origin: Coordinates;
  radiusKm: number;
  onSelect: (deal: ApiDeal) => void;
  /** Re-run the search centred on wherever the user has panned to. */
  onSearchArea: (centre: Coordinates) => void;
}

/** Roughly fit the search circle in view: 1° latitude ≈ 111 km. */
function regionFor(origin: Coordinates, radiusKm: number): Region {
  const latitudeDelta = Math.max((radiusKm * 2.4) / 111, 0.01);
  return {
    latitude: origin.lat,
    longitude: origin.lon,
    latitudeDelta,
    // Compensate for longitude degrees narrowing away from the equator, so the
    // circle looks round rather than squashed at Toronto's latitude.
    longitudeDelta: latitudeDelta / Math.cos((origin.lat * Math.PI) / 180),
  };
}

export function DealMap({ deals, origin, radiusKm, onSelect, onSearchArea }: Props) {
  const mapRef = useRef<MapView>(null);
  const [centre, setCentre] = useState<Coordinates>(origin);
  const [moved, setMoved] = useState(false);

  // Follow the origin when the search itself moves (a new fix, or a "search
  // this area" that has now been applied), but never fight the user's panning.
  useEffect(() => {
    setCentre(origin);
    setMoved(false);
    mapRef.current?.animateToRegion(regionFor(origin, radiusKm), 350);
  }, [origin.lat, origin.lon, radiusKm]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={regionFor(origin, radiusKm)}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        onRegionChangeComplete={(region) => {
          const next = { lat: region.latitude, lon: region.longitude };
          setCentre(next);
          // Only offer to re-search once the pan is meaningful relative to the
          // radius, so the button doesn't flicker on incidental drags.
          const drift =
            Math.abs(next.lat - origin.lat) + Math.abs(next.lon - origin.lon);
          setMoved(drift > radiusKm / 400);
        }}
      >
        <Circle
          center={{ latitude: origin.lat, longitude: origin.lon }}
          radius={radiusKm * 1000}
          strokeColor="rgba(232,184,75,0.55)"
          fillColor="rgba(232,184,75,0.10)"
        />

        {deals.map((deal) => (
          <Marker
            key={deal.id}
            coordinate={{ latitude: deal.venue.lat, longitude: deal.venue.lon }}
            title={deal.venue.name}
            description={`${deal.title} · ${statusLine(deal).text}`}
            pinColor={deal.partner ? theme.color.accent : deal.activeNow ? theme.color.live : theme.color.textMuted}
            onCalloutPress={() => onSelect(deal)}
            onPress={() => onSelect(deal)}
          />
        ))}
      </MapView>

      {moved ? (
        <Pressable
          style={styles.searchArea}
          accessibilityRole="button"
          onPress={() => {
            onSearchArea(centre);
            setMoved(false);
          }}
        >
          <Text style={styles.searchAreaText}>Search this area</Text>
        </Pressable>
      ) : null}

      <View style={styles.legend}>
        <Legend colour={theme.color.accent} label="Partner" />
        <Legend colour={theme.color.live} label="On now" />
        <Legend colour={theme.color.textMuted} label="Later" />
        <Text style={styles.legendCount}>
          {deals.length} within {formatDistance(radiusKm)}
        </Text>
      </View>
    </View>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: colour }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchArea: {
    position: "absolute",
    top: theme.space(4),
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
  legend: {
    position: "absolute",
    left: theme.space(3),
    bottom: theme.space(3),
    right: theme.space(3),
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    backgroundColor: "rgba(18,16,14,0.88)",
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.space(1.5) },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: theme.color.textMuted, fontSize: theme.font.tiny },
  legendCount: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
    marginLeft: "auto",
  },
});
