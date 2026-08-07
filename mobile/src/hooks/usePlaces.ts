import { useEffect, useRef, useState } from "react";

import { fetchPlaces } from "../api/client";
import type { ApiPlace } from "../api/types";

export interface PlacesState {
  places: ApiPlace[];
  attribution: string | null;
  loading: boolean;
}

/**
 * The venues we know about nearby, whatever we know about their deals.
 *
 * This deliberately ignores the time and category filters that drive the deal
 * search. Those answer "what is on right now"; this answers "what is around
 * me", and it should not empty out when someone switches to Thursday 7pm.
 *
 * Failures are swallowed to `[]`. The places layer is context, not the product
 * — if it cannot load, the deal list still works, and a second error banner
 * saying the same thing as the first helps nobody.
 */
export function usePlaces(
  query: { lat: number; lon: number; radiusKm: number } | null,
  enabled: boolean,
): PlacesState {
  const [places, setPlaces] = useState<ApiPlace[]>([]);
  const [attribution, setAttribution] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const lat = query?.lat;
  const lon = query?.lon;
  const radiusKm = query?.radiusKm;

  useEffect(() => {
    if (!enabled || lat === undefined || lon === undefined || radiusKm === undefined) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);

    fetchPlaces({ lat, lon, radiusKm, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setPlaces(response.places);
        setAttribution(response.attribution);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPlaces([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [lat, lon, radiusKm, enabled]);

  return { places, attribution, loading };
}
