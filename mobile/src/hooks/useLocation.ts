import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Coordinates {
  lat: number;
  lon: number;
}

export type LocationStatus = "idle" | "requesting" | "granted" | "denied" | "error";

export interface LocationState {
  status: LocationStatus;
  coords: Coordinates | null;
  /** Radius of uncertainty in metres, as reported by the OS. */
  accuracyM: number | null;
  error: string | null;
  /** True when `coords` came from a fallback or a manual pin, not the GPS. */
  usingFallback: boolean;
  /** True when the fix is too coarse to trust for a walking-distance search. */
  imprecise: boolean;
  request: () => Promise<void>;
  useFallback: (coords: Coordinates) => void;
  /** Pin the search to a point the user chose themselves. */
  setManual: (coords: Coordinates) => void;
}

/** Above this, a "200 m away" claim is meaningless, so the UI says so. */
const IMPRECISE_ABOVE_M = 250;

/**
 * Foreground location, tuned for accuracy rather than speed.
 *
 * A happy hour search lives or dies on a couple of hundred metres — the wrong
 * side of Queen Street is a different set of bars. So this asks for the highest
 * accuracy the device will give, refuses cached fixes, and then keeps watching:
 * the first fix is often a coarse network estimate that GPS improves on within
 * a few seconds. Only better fixes are accepted, so the position never degrades
 * while the user is looking at it.
 */
export function useLocation(): LocationState {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const manual = useRef(false);

  const stopWatching = useCallback(() => {
    watcher.current?.remove();
    watcher.current = null;
  }, []);

  const accept = useCallback((position: Location.LocationObject) => {
    if (manual.current) return;
    const nextAccuracy = position.coords.accuracy ?? Number.POSITIVE_INFINITY;
    setAccuracyM((previous) => {
      // Ignore an update that is worse than what we already have; drifting to a
      // coarser fix mid-session moves results for no reason.
      if (previous !== null && nextAccuracy > previous) return previous;
      setCoords({ lat: position.coords.latitude, lon: position.coords.longitude });
      setUsingFallback(false);
      return position.coords.accuracy ?? previous;
    });
  }, []);

  const request = useCallback(async () => {
    setStatus("requesting");
    setError(null);
    manual.current = false;

    try {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== "granted") {
        setStatus("denied");
        setError(
          "Location permission was declined. You can still search by setting a starting point.",
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        // Highest available. On a phone this means GPS rather than the
        // cell/wifi estimate, which is what was putting people blocks away.
        accuracy: Location.Accuracy.Highest,
      });
      setAccuracyM(position.coords.accuracy ?? null);
      setCoords({ lat: position.coords.latitude, lon: position.coords.longitude });
      setUsingFallback(false);
      setStatus("granted");

      // Keep refining. The first fix is frequently the coarsest one.
      stopWatching();
      watcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Highest,
          distanceInterval: 15,
          timeInterval: 5000,
        },
        accept,
      );
    } catch (cause) {
      setStatus("error");
      setError(
        cause instanceof Error
          ? `Could not get your location: ${cause.message}`
          : "Could not get your location.",
      );
    }
  }, [accept, stopWatching]);

  const useFallback = useCallback((fallback: Coordinates) => {
    manual.current = true;
    stopWatching();
    setCoords(fallback);
    setAccuracyM(null);
    setUsingFallback(true);
    setStatus("granted");
    setError(null);
  }, [stopWatching]);

  const setManual = useCallback((point: Coordinates) => {
    // A pin the user dropped is exact by definition — stop second-guessing it
    // with GPS updates.
    manual.current = true;
    stopWatching();
    setCoords(point);
    setAccuracyM(null);
    setUsingFallback(true);
    setStatus("granted");
    setError(null);
  }, [stopWatching]);

  useEffect(() => {
    void request();
    return stopWatching;
  }, [request, stopWatching]);

  return {
    status,
    coords,
    accuracyM,
    error,
    usingFallback,
    imprecise: accuracyM !== null && accuracyM > IMPRECISE_ABOVE_M,
    request,
    useFallback,
    setManual,
  };
}
