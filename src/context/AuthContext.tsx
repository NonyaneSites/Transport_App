import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

import type { User } from '@supabase/supabase-js';

export interface UserProfile {
  id: string;
  email?: string;
  full_name?: string;
  phone?: string;
  role?: 'admin' | 'dispatcher' | 'rep';
  status?: 'pending' | 'approved' | 'rejected';
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  isAdmin: boolean;
  isApproved: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  isAdmin: false,
  isApproved: false,
  loading: true,
  refreshProfile: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        setProfile(data);
      } else {
        setProfile(null);
      }
    } catch (err) {
      console.warn('[AuthContext] Failed to load profile:', err);
      setProfile(null);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user?.id) {
      await fetchProfile(user.id);
    }
  }, [user, fetchProfile]);

  useEffect(() => {
    if (!supabase?.auth) {
      console.error('Supabase client is not initialized properly. Check @/lib/supabase export.');
      setLoading(false);
      return;
    }

    let mounted = true;

    async function initSession() {
      try {
        const { data } = await supabase.auth.getSession();
        const sessionUser = data?.session?.user ?? null;
        if (mounted) {
          setUser(sessionUser);
          if (sessionUser?.id) {
            await fetchProfile(sessionUser.id);
          } else {
            setProfile(null);
          }
          setLoading(false);
        }
      } catch {
        if (mounted) setLoading(false);
      }
    }

    initSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const sessionUser = session?.user ?? null;
      setUser(sessionUser);
      if (sessionUser?.id) {
        await fetchProfile(sessionUser.id);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => {
      mounted = false;
      authListener?.subscription?.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  }, []);

  const isApproved = Boolean(profile && profile.status === 'approved');
  const isAdmin = Boolean(isApproved && (profile?.role === 'admin' || profile?.role === 'dispatcher'));

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isAdmin,
        isApproved,
        loading,
        refreshProfile,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}