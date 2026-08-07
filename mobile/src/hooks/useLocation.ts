import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";

export interface Coordinates {
  lat: number;
  lon: number;
}

export type LocationStatus = "idle" | "requesting" | "granted" | "denied" | "error";

export interface LocationState {
  status: LocationStatus;
  coords: Coordinates | null;
  error: string | null;
  /** True when `coords` is the manual fallback rather than a real fix. */
  usingFallback: boolean;
  request: () => Promise<void>;
  useFallback: (coords: Coordinates) => void;
}

/**
 * Foreground location with an explicit fallback.
 *
 * Denial is a normal state, not an error: a simulator with no location set, or
 * a user who declines the prompt, should still get a usable app. The caller can
 * drop in a manual coordinate and everything downstream keeps working.
 */
export function useLocation(): LocationState {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  const request = useCallback(async () => {
    setStatus("requesting");
    setError(null);

    try {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== "granted") {
        setStatus("denied");
        setError(
          "Location permission was declined. You can still search by picking a starting point.",
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        // Balanced is accurate to roughly a city block, which is all a
        // radius search needs, and it gets a fix far faster than High.
        accuracy: Location.Accuracy.Balanced,
      });

      setCoords({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      });
      setUsingFallback(false);
      setStatus("granted");
    } catch (cause) {
      setStatus("error");
      setError(
        cause instanceof Error
          ? `Could not get your location: ${cause.message}`
          : "Could not get your location.",
      );
    }
  }, []);

  const useFallback = useCallback((fallback: Coordinates) => {
    setCoords(fallback);
    setUsingFallback(true);
    setStatus("granted");
    setError(null);
  }, []);

  useEffect(() => {
    void request();
  }, [request]);

  return { status, coords, error, usingFallback, request, useFallback };
}
