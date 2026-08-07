/**
 * Expo config.
 *
 * This is a .js config rather than app.json so the Android Google Maps key can
 * come from the environment instead of being committed. iOS uses Apple Maps and
 * needs no key; Android renders a blank map without one, which is the usual
 * cause of "the map is grey" on a first run.
 */
module.exports = {
  expo: {
    name: "Little Lemon",
    slug: "little-lemon",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    scheme: "littlelemon",
    newArchEnabled: true,
    splash: {
      resizeMode: "contain",
      backgroundColor: "#12100E",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.littlelemon.app",
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          "Little Lemon uses your location to find happy hour deals near you. Your location is used on the device to search nearby venues and is not stored.",
      },
    },
    android: {
      package: "com.littlelemon.app",
      adaptiveIcon: { backgroundColor: "#12100E" },
      permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION"],
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY || undefined,
        },
      },
    },
    plugins: [
      [
        "expo-location",
        {
          locationWhenInUsePermission:
            "Little Lemon uses your location to find happy hour deals near you.",
        },
      ],
    ],
    extra: {
      defaultRegion: "Ontario, Canada",
    },
  },
};
