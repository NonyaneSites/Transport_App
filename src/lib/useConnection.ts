import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { MANIFESTS_TABLE } from './supabase';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() =>
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'online'
  );

  useEffect(() => {
    let mounted = true;

    const handleOnline = () => {
      if (mounted) setState('online');
    };

    const handleOffline = () => {
      if (mounted) setState('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Perform a single lightweight connection check on mount (head: true transfers 0 bytes payload)
    (async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (mounted) setState('offline');
        return;
      }
      try {
        const { error } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date', { count: 'exact', head: true });
        if (mounted) {
          setState(error ? 'offline' : 'online');
        }
      } catch {
        if (mounted) setState('offline');
      }
    })();

    return () => {
      mounted = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return state;
}

