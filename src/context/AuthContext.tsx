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
      let serverStatus: UserAccountStatus | undefined;
      let serverProfile: Record<string, unknown> | null = null;
      try {
        const res = await fetch('/api/auth/roles');
        if (res.ok) {
          const rolesMap = await res.json();
          if (rolesMap && emailToCheck && rolesMap[emailToCheck]) {
            serverProfile = rolesMap[emailToCheck];
            if (rolesMap[emailToCheck]?.role) {
              serverRole = rolesMap[emailToCheck].role as AppUserRole;
            }
            if (rolesMap[emailToCheck]?.status) {
              serverStatus = rolesMap[emailToCheck].status as UserAccountStatus;
            }
          }
        }
      } catch {
        // Fallback gracefully
      }

      // Query Supabase: match by ID first, and fallback to email
      let remoteData: Record<string, unknown> | null = null;
      try {
        const { data: byId } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (byId) {
          remoteData = byId;
        } else if (emailToCheck) {
          const { data: byEmail } = await supabase
            .from('profiles')
            .select('*')
            .ilike('email', emailToCheck)
            .maybeSingle();
          if (byEmail) {
            remoteData = byEmail;
          }
        }
      } catch (sbErr) {
        console.warn('[AuthContext] Supabase profile query error:', sbErr);
      }

      const effectiveEmail = ((remoteData?.email as string) || emailToCheck).trim().toLowerCase();
      const isSuper = isSuperAdminEmail(effectiveEmail);

      // Determine approval status
      let effectiveStatus: UserAccountStatus = 'pending';
      if (isSuper) {
        effectiveStatus = 'approved';
      } else if (remoteData?.status) {
        effectiveStatus = remoteData.status as UserAccountStatus;
      } else if (serverStatus) {
        effectiveStatus = serverStatus;
      } else {
        // Check local storage fallback
        try {
          const localProfiles = JSON.parse(localStorage.getItem('crc_transport_profiles') || '[]');
          const match = localProfiles.find(
            (p: { id?: string; email?: string; status?: string }) =>
              p.id === userId || (p.email && p.email.toLowerCase() === effectiveEmail)
          );
          if (match?.status) effectiveStatus = match.status as UserAccountStatus;
        } catch {
          // ignore
        }
      }

      // Determine effective role
      let resolvedRole: AppUserRole = effectiveStatus === 'approved' ? 'admin' : 'rep';
      if (isSuper) {
        resolvedRole = 'super_admin';
      } else if (serverRole) {
        resolvedRole = serverRole;
      } else if (remoteData?.role) {
        resolvedRole = remoteData.role as AppUserRole;
      } else if (effectiveEmail === 'shauntsiloane@gmail.com' || effectiveEmail === 'tsiloane941@gmail.com') {
        resolvedRole = 'dispatch_admin';
      }

      setProfile({
        id: userId,
        email: effectiveEmail,
        ...(remoteData || {}),
        ...(serverProfile || {}),
        role: resolvedRole,
        status: effectiveStatus,
      });
    } catch (err) {
      console.warn('[AuthContext] Failed to load profile:', err);
      const emailToCheck = (userEmail || user?.email || '').trim().toLowerCase();
      const isSuper = isSuperAdminEmail(emailToCheck);
      setProfile({
        id: userId,
        email: emailToCheck,
        role: isSuper ? 'super_admin' : 'admin',
        status: 'approved',
      });
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
    return (profile?.role as AppUserRole) || (isApproved ? 'admin' : 'rep');
  }, [isSuperEmail, profile?.role, isApproved]);

  const isSuperAdmin = Boolean(isApproved && (role === 'super_admin' || isSuperEmail));
  const canAccessDispatch = Boolean(isApproved && canRoleAccessDispatch(role, userEmail));
  const canAccessLedger = Boolean(isApproved && canRoleAccessLedger(role, userEmail));
  const isDispatchAdmin = Boolean(isApproved && (role === 'dispatch_admin' || role === 'dispatcher' || role === 'admin' || isSuperAdmin));
  const isLedgerAdmin = Boolean(isApproved && (role === 'ledger_admin' || role === 'admin' || isSuperAdmin));
  const isAdmin = Boolean(isApproved);

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