import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { MANIFESTS_TABLE } from './supabase';
import type { Manifest } from './types';

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
  // Highest row `updated_at` we know to be valid for this manifest — from
  // the initial load, from our own confirmed upserts, or from realtime
  // events we've already applied. A realtime event is only ever applied if
  // it's strictly newer than this, so a duplicate or out-of-order echo can
  // never revert something more recent.
  const knownUpdatedAtRef = useRef<number>(0);
  // Count of our own save() calls whose upsert hasn't resolved yet. While
  // this is > 0 we have an optimistic local change in flight that is, by
  // definition, ahead of anything Postgres can currently tell us about — so
  // realtime events are ignored entirely until our own writes catch up.
  // This is what actually closes the race: two rapid saves (e.g. "move a
  // rep to another taxi" immediately followed by "assign a different rep")
  // used to be vulnerable to the *first* save's realtime echo arriving
  // after the second save had already landed locally, silently reverting
  // the second change. Now that echo is dropped outright.
  const pendingSavesRef = useRef<number>(0);
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
    knownUpdatedAtRef.current = 0;
    pendingSavesRef.current = 0;

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
          knownUpdatedAtRef.current = loaded?.updated_at ? new Date(loaded.updated_at).getTime() : 0;
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
          // We have a save of our own in flight — our local state is
          // already ahead of whatever this event reports (it's either an
          // echo of a save we already applied, or an echo of a save that's
          // about to be superseded by the one still in flight). Once our
          // pending save resolves, knownUpdatedAtRef advances and later
          // events are compared correctly again.
          if (pendingSavesRef.current > 0) return;
          const row = payload.new as (Manifest & { updated_at?: string }) | undefined;
          if (!row) return;
          const incomingTime = row.updated_at ? new Date(row.updated_at).getTime() : 0;
          // Only apply events strictly newer than the freshest state we
          // already know — this is what makes stale/out-of-order echoes
          // harmless, regardless of their content.
          if (incomingTime <= knownUpdatedAtRef.current) return;
          knownUpdatedAtRef.current = incomingTime;
          const incoming: Manifest = { date: row.date, signups: row.signups ?? [], vehicles: row.vehicles ?? [] };
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
    setManifest(m);
    pendingSavesRef.current += 1;

    const doUpsert = async () => {
      const { data, error: upsertError } = await supabase
        .from(MANIFESTS_TABLE)
        .upsert({ date: m.date, signups: m.signups, vehicles: m.vehicles }, { onConflict: 'date' })
        .select('updated_at')
        .maybeSingle();
      if (upsertError) throw upsertError;
      const confirmedTime = data?.updated_at ? new Date(data.updated_at).getTime() : Date.now();
      if (confirmedTime > knownUpdatedAtRef.current) {
        knownUpdatedAtRef.current = confirmedTime;
      }
    };

    // Queue this upsert behind any still-in-flight one for this manifest,
    // so requests always reach Postgres in the order they were issued.
    const run = saveChainRef.current.then(doUpsert, doUpsert).finally(() => {
      pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
    });
    saveChainRef.current = run.catch(() => {});
    return run;
  }

  return { manifest, loading, error, save };
}

