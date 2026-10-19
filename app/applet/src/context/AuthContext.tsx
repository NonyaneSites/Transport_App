import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import {
  type AppUserRole,
  type UserAccountStatus,
  isSuperAdminEmail,
  canRoleAccessDispatch,
  canRoleAccessLedger,
} from '@/lib/types';
import type { User } from '@supabase/supabase-js';

export interface UserProfile {
  id: string;
  email?: string;
  full_name?: string;
  phone?: string;
  role?: AppUserRole;
  status?: UserAccountStatus;
  structure?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  role: AppUserRole;
  isSuperAdmin: boolean;
  isDispatchAdmin: boolean;
  isLedgerAdmin: boolean;
  isAdmin: boolean;
  isApproved: boolean;
  canAccessDispatch: boolean;
  canAccessLedger: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  role: 'rep',
  isSuperAdmin: false,
  isDispatchAdmin: false,
  isLedgerAdmin: false,
  isAdmin: false,
  isApproved: false,
  canAccessDispatch: false,
  canAccessLedger: false,
  loading: true,
  refreshProfile: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string, userEmail?: string | null) => {
    try {
      const emailToCheck = (userEmail || user?.email || '').trim().toLowerCase();

      // Check server roles if available
      let serverRole: AppUserRole | undefined;
      try {
        const res = await fetch('/api/auth/roles');
        if (res.ok) {
          const rolesMap = await res.json();
          if (rolesMap && emailToCheck && rolesMap[emailToCheck]?.role) {
            serverRole = rolesMap[emailToCheck].role as AppUserRole;
          }
        }
      } catch {
        // Fallback gracefully
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        const effectiveEmail = (data.email || emailToCheck).trim().toLowerCase();
        const isSuper = isSuperAdminEmail(effectiveEmail);

        // Determine effective role
        let resolvedRole: AppUserRole = 'rep';
        if (isSuper) {
          resolvedRole = 'super_admin';
        } else if (serverRole) {
          resolvedRole = serverRole;
        } else if (data.role) {
          resolvedRole = data.role as AppUserRole;
        } else if (effectiveEmail === 'shauntsiloane@gmail.com' || effectiveEmail === 'tsiloane941@gmail.com') {
          resolvedRole = 'dispatch_admin';
        }

        const effectiveStatus: UserAccountStatus = isSuper ? 'approved' : (data.status as UserAccountStatus) || 'pending';

        setProfile({
          ...data,
          role: resolvedRole,
          status: effectiveStatus,
        });
      } else if (emailToCheck && isSuperAdminEmail(emailToCheck)) {
        // Super admin guaranteed access even if profiles query encounters issues
        setProfile({
          id: userId,
          email: emailToCheck,
          role: 'super_admin',
          status: 'approved',
          full_name: 'Super Administrator',
        });
      } else {
        setProfile(null);
      }
    } catch (err) {
      console.warn('[AuthContext] Failed to load profile:', err);
      const emailToCheck = (userEmail || user?.email || '').trim().toLowerCase();
      if (emailToCheck && isSuperAdminEmail(emailToCheck)) {
        setProfile({
          id: userId,
          email: emailToCheck,
          role: 'super_admin',
          status: 'approved',
        });
      } else {
        setProfile(null);
      }
    }
  }, [user?.email]);

  const refreshProfile = useCallback(async () => {
    if (user?.id) {
      await fetchProfile(user.id, user.email);
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
            await fetchProfile(sessionUser.id, sessionUser.email);
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
        await fetchProfile(sessionUser.id, sessionUser.email);
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

  const userEmail = (user?.email || profile?.email || '').trim().toLowerCase();
  const isSuperEmail = isSuperAdminEmail(userEmail);

  const isApproved = Boolean(
    isSuperEmail || (profile && profile.status === 'approved')
  );

  const role: AppUserRole = useMemo(() => {
    if (isSuperEmail) return 'super_admin';
    return (profile?.role as AppUserRole) || 'rep';
  }, [isSuperEmail, profile?.role]);

  const isSuperAdmin = Boolean(isApproved && (role === 'super_admin' || isSuperEmail));
  const canAccessDispatch = Boolean(isApproved && canRoleAccessDispatch(role, userEmail));
  const canAccessLedger = Boolean(isApproved && canRoleAccessLedger(role, userEmail));
  const isDispatchAdmin = Boolean(isApproved && (role === 'dispatch_admin' || role === 'dispatcher'));
  const isLedgerAdmin = Boolean(isApproved && role === 'ledger_admin');
  const isAdmin = Boolean(isApproved && (canAccessDispatch || canAccessLedger));

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        role,
        isSuperAdmin,
        isDispatchAdmin,
        isLedgerAdmin,
        isAdmin,
        isApproved,
        canAccessDispatch,
        canAccessLedger,
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
