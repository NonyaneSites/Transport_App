import { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase?.auth) {
      console.error("Supabase client is not initialized properly. Check your @/lib/supabase export and .env file.");
      setLoading(false);
      return;
    }

    fetchSession();

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      data?.subscription?.unsubscribe();
    };
  }, []);

  async function fetchSession() {
    if (!supabase?.auth) return;
    const { data } = await supabase.auth.getSession();
    setUser(data?.session?.user ?? null);
    setLoading(false);
  }

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}