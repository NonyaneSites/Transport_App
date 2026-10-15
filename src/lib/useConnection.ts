import { useEffect, useState } from 'react';
import { supabase, MANIFESTS_TABLE, isSupabaseConfigured } from './supabase';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => {
    if (!isSupabaseConfigured) return 'offline';
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
    return 'online';
  });

  useEffect(() => {
    let mounted = true;

    if (!isSupabaseConfigured) {
      setState('offline');
      return;
    }

    const checkReachability = async () => {
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
    };

    const handleOnline = () => {
      checkReachability();
    };

    const handleOffline = () => {
      if (mounted) setState('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Perform lightweight check on mount
    checkReachability();

    // Periodic check (every 60s, tab visible only)
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      checkReachability();
    }, 60000);

    return () => {
      mounted = false;
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return state;
}

