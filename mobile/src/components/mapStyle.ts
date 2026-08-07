/**
 * Google Maps style for Android, tuned to the app's palette.
 *
 * The point is legibility of the pins, not of the basemap: roads and water are
 * pushed back so an amber or green pin is the brightest thing on screen. Apple
 * Maps on iOS ignores this and follows `userInterfaceStyle` instead.
 */
export const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#161f23" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7d8f8e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0e1518" }] },

  // Points of interest are noise here — the app supplies its own places.
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },

  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#2b3a41" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill",
    stylers: [{ color: "#93a6a5" }] },
  { featureType: "administrative.neighborhood", elementType: "labels.text.fill",
    stylers: [{ color: "#6b7e80" }] },

  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#18242a" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1a2b26" }] },

  { featureType: "road", elementType: "geometry", stylers: [{ color: "#233238" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#6b7e80" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#2c3f46" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a4f57" }] },
  { featureType: "road.local", elementType: "labels", stylers: [{ visibility: "off" }] },

  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b1418" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3f5257" }] },
];
