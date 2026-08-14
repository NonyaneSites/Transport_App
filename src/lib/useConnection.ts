import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { MANIFESTS_TABLE } from './supabase';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function check() {
      try {
        const { error } = await supabase.from(MANIFESTS_TABLE).select('date').limit(1);
        if (mounted) {
          setState(error ? 'offline' : 'online');
        }
      } catch {
        if (mounted) setState('offline');
      }
    }

    check();

    channel = supabase
      .channel('connection-heartbeat')
      .on('postgres_changes', { event: '*', schema: 'public', table: MANIFESTS_TABLE }, () => {
        if (mounted) setState('online');
      })
      .subscribe((status) => {
        if (!mounted) return;
        if (status === 'SUBSCRIBED') setState('online');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setState('offline');
      });

    const interval = setInterval(check, 15000);

    return () => {
      mounted = false;
      clearInterval(interval);
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return state;
}
