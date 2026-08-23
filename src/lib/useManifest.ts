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
  const pendingSavesRef = useRef<number>(0);

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
          setManifest((data as Manifest) ?? null);
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
          // If we have local saves in-flight, ignore realtime echoes to prevent UI stutter/reverts
          if (pendingSavesRef.current > 0) return;
          const row = payload.new as Manifest | undefined;
          if (row) {
            setManifest({ date: row.date, signups: row.signups ?? [], vehicles: row.vehicles ?? [] });
          }
        }
      )
      .subscribe();

    return () => {
      keyRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [key]);

  async function save(m: Manifest): Promise<void> {
    pendingSavesRef.current += 1;
    setManifest(m);
    try {
      const { error: upsertError } = await supabase
        .from(MANIFESTS_TABLE)
        .upsert({ date: m.date, signups: m.signups, vehicles: m.vehicles }, { onConflict: 'date' });
      if (upsertError) throw upsertError;
    } finally {
      // Cooldown before allowing realtime echoes to avoid stale broadcast race
      setTimeout(() => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
      }, 1500);
    }
  }

  return { manifest, loading, error, save };
}
