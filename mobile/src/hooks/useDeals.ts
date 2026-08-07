import { useCallback, useEffect, useRef, useState } from "react";

import { fetchDeals, type DealSearchParams } from "../api/client";
import type { ApiDeal } from "../api/types";

export interface DealsState {
  deals: ApiDeal[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

type Query = Omit<DealSearchParams, "signal">;

/**
 * Runs a search whenever the filters change.
 *
 * The filter controls are continuous (a distance slider especially), so each
 * request aborts the one before it. Without that, dragging the slider races a
 * dozen responses and the list flickers between radii as they land out of order.
 */
export function useDeals(query: Query | null): DealsState {
  const [deals, setDeals] = useState<ApiDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNonce((value) => value + 1);
  }, []);

  const lat = query?.lat;
  const lon = query?.lon;
  const radiusMi = query?.radiusMi;
  const atIso = query?.at.toISOString();
  const windowMin = query?.windowMin;
  const category = query?.category;

  useEffect(() => {
    if (lat === undefined || lon === undefined || radiusMi === undefined) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setLoading(true);
    setError(null);

    fetchDeals({
      lat,
      lon,
      radiusMi,
      at: atIso ? new Date(atIso) : new Date(),
      windowMin: windowMin ?? 0,
      category,
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setDeals(response.deals);
      })
      .catch((cause: unknown) => {
        // An abort means a newer search replaced this one — not a failure.
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Something went wrong.");
        setDeals([]);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => controller.abort();
  }, [lat, lon, radiusMi, atIso, windowMin, category, nonce]);

  return { deals, loading, refreshing, error, refresh };
}
