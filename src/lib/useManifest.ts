import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { MANIFESTS_TABLE } from './supabase';
import type { Manifest } from './types';

// Deterministic stringify (sorted object keys) so two manifests that are
// content-identical compare equal even if Postgres/jsonb returns object
// keys in a different order than the client sent them in.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestContentEqual(a: Manifest, b: Manifest): boolean {
  return (
    stableStringify(a.signups) === stableStringify(b.signups) &&
    stableStringify(a.vehicles) === stableStringify(b.vehicles)
  );
}

export function useManifest(key: string | null): {
  manifest: Manifest | null;
  loading: boolean;
  error: string | null;
  save: (m: Manifest) => Promise<void>;
} {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  // The manifest content from our own most recent save (in flight or
  // completed) for this key. Used to recognize realtime "echoes" of our
  // own writes without relying on a fixed cooldown timer.
  const lastSavedRef = useRef<Manifest | null>(null);
  // Chains save() calls so upserts for this date are never in flight
  // concurrently. Without this, two rapid moves could hit Postgres out of
  // order (a slower first request committing after a faster second one),
  // silently reverting the newer change.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!key) {
      setManifest(null);
      setLoading(false);
      return;
    }
    keyRef.current = key;
    setLoading(true);
    setError(null);

    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      try {
        const { data, error: loadError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date, signups, vehicles, created_at, updated_at')
          .eq('date', key)
          .maybeSingle();
        if (loadError) throw loadError;
        if (keyRef.current === key) {
          const loaded = (data as Manifest) ?? null;
          setManifest(loaded);
          lastSavedRef.current = loaded;
          setLoading(false);
        }
      } catch (e) {
        if (keyRef.current === key) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    channel = supabase
      .channel(`manifest:${key}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: MANIFESTS_TABLE, filter: `date=eq.${key}` },
        (payload) => {
          if (keyRef.current !== key) return;
          const row = payload.new as Manifest | undefined;
          if (!row) return;
          const incoming: Manifest = { date: row.date, signups: row.signups ?? [], vehicles: row.vehicles ?? [] };
          // Ignore this event if it just confirms our own latest save (an
          // echo of a write we already applied locally) — applying it again
          // is a no-op at best and, if a slower earlier save's echo arrives
          // after a newer one, would revert the newer change at worst.
          if (lastSavedRef.current && manifestContentEqual(lastSavedRef.current, incoming)) return;
          lastSavedRef.current = incoming;
          setManifest(incoming);
        }
      )
      .subscribe();

    return () => {
      keyRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [key]);

  async function save(m: Manifest): Promise<void> {
    // Optimistic local update happens immediately and synchronously, so the
    // UI never waits on the network for a move to "stick" locally.
    lastSavedRef.current = m;
    setManifest(m);

    const doUpsert = async () => {
      const { error: upsertError } = await supabase
        .from(MANIFESTS_TABLE)
        .upsert({ date: m.date, signups: m.signups, vehicles: m.vehicles }, { onConflict: 'date' });
      if (upsertError) throw upsertError;
    };

    // Queue this upsert behind any still-in-flight one for this manifest,
    // so requests always reach Postgres in the order they were issued.
    const run = saveChainRef.current.then(doUpsert, doUpsert);
    saveChainRef.current = run.catch(() => {});
    return run;
  }

  return { manifest, loading, error, save };
}
