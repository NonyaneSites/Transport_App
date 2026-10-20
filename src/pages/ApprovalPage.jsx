import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { CheckCircle2, XCircle, ArrowLeft, RefreshCw, Building, Phone, Mail, UserCheck } from 'lucide-react';

export function ApprovalPage() {
  const { user: currentAdmin } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('pending');
  const [actionNotice, setActionNotice] = useState(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setActionNotice(null);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      let profileList = Array.isArray(data) ? [...data] : [];

      // Fetch server roles to enrich profiles with roles, names, phone numbers
      try {
        const res = await fetch('/api/auth/roles');
        if (res.ok) {
          const rolesMap = await res.json();
          if (rolesMap) {
            profileList = profileList.map((p) => {
              const emailKey = p.email?.trim().toLowerCase();
              const serverInfo = emailKey ? rolesMap[emailKey] : null;
              return {
                ...p,
                role: serverInfo?.role || p.role || (p.status === 'approved' ? 'admin' : 'rep'),
                full_name: serverInfo?.full_name || p.full_name || p.email?.split('@')[0],
                phone: serverInfo?.phone || p.phone,
                structure: serverInfo?.structure || p.structure,
                status: serverInfo?.status || p.status || 'pending',
              };
            });

            // Also include any users registered on server that might not be in Supabase
            const knownEmails = new Set(profileList.map((p) => p.email?.trim().toLowerCase()));
            for (const [em, info] of Object.entries(rolesMap)) {
              if (!knownEmails.has(em)) {
                profileList.push({
                  id: info.userId || `user_${em}`,
                  email: em,
                  status: info.status || 'approved',
                  role: info.role || 'admin',
                  full_name: info.full_name || em.split('@')[0],
                  phone: info.phone || '',
                  structure: info.structure || '',
                  created_at: info.updated_at || new Date().toISOString(),
                });
              }
            }
          }
        }
      } catch (serverErr) {
        console.warn('Failed to fetch server roles:', serverErr);
      }

      setProfiles(profileList);
      if (error) {
        console.warn('Supabase profiles notice:', error);
      }
    } catch (err) {
      console.error('Fetch profiles failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  async function handleAction(userId, newStatus, newRole) {
    setLoading(true);
    setActionNotice(null);
    try {
      const targetRole = newRole || 'admin';
      const userObj = profiles.find((u) => u.id === userId);
      const userEmail = userObj?.email?.trim().toLowerCase();

      // 1. Persist to server auth roles store with authenticated token
      try {
        const sessionRes = await supabase.auth.getSession();
        const token = sessionRes?.data?.session?.access_token;
        await fetch('/api/auth/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            userId,
            email: userEmail,
            status: newStatus,
            role: targetRole,
          }),
        });
      } catch (srvErr) {
        console.warn('Server auth approve error:', srvErr);
      }

      // 2. Update Supabase profiles table safely with canonical status column only
      try {
        const { error: directError } = await supabase
          .from('profiles')
          .update({ status: newStatus })
          .eq('id', userId);

        if (directError && userEmail) {
          // Fallback update by email if ID differed
          await supabase
            .from('profiles')
            .update({ status: newStatus })
            .ilike('email', userEmail);
        }
      } catch (sbErr) {
        console.warn('Supabase profile direct update warning:', sbErr);
      }

      setProfiles((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, status: newStatus, role: targetRole, updated_at: new Date().toISOString() }
            : u
        )
      );
      setActionNotice(`Account ${newStatus === 'approved' ? 'approved' : 'declined'} successfully.`);
      setTimeout(() => setActionNotice(null), 4000);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Error updating user');
    } finally {
      setLoading(false);
    }
  }

  const pendingUsers = profiles.filter((u) => u.status === 'pending');
  const approvedUsers = profiles.filter((u) => u.status === 'approved');
  const rejectedUsers = profiles.filter((u) => u.status === 'rejected');

  const displayedUsers =
    activeTab === 'pending'
      ? pendingUsers
      : activeTab === 'approved'
      ? approvedUsers
      : rejectedUsers;

  return (
    <div className="min-h-screen bg-background text-ink p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-line pb-5">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link to="/admin" className="p-1 rounded-lg text-muted hover:text-ink hover:bg-card-2 transition-colors">
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <h1 className="text-2xl font-display font-bold text-ink">Account Authorizations</h1>
              <span className="badge bg-card-2 border border-line text-muted text-xs">Admin Console</span>
            </div>
            <p className="text-xs sm:text-sm text-muted">
              Approve, decline, or configure role permissions for transport reps and dispatchers. Authenticated as <strong className="text-ink">{currentAdmin?.email}</strong>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchProfiles}
              disabled={loading}
              className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <Link to="/admin" className="btn-secondary text-xs py-1.5 px-3">
              Go to Dispatch
            </Link>
          </div>
        </div>

        {actionNotice && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-card border border-line p-3 text-xs font-semibold text-ink animate-fade-in shadow-md">
            <span>{actionNotice}</span>
            <button onClick={() => setActionNotice(null)} className="text-muted hover:text-ink">
              ✕
            </button>
          </div>
        )}

        {/* Status Tabs */}
        <div className="flex gap-2 border-b border-line pb-2">
          <button
            onClick={() => setActiveTab('pending')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'pending'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-muted hover:text-ink'
            }`}
          >
            Pending Requests ({pendingUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('approved')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'approved'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'text-muted hover:text-ink'
            }`}
          >
            Approved ({approvedUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('rejected')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'rejected'
                ? 'bg-crimson-500/20 text-crimson-300 border border-crimson-500/40'
                : 'text-muted hover:text-ink'
            }`}
          >
            Declined ({rejectedUsers.length})
          </button>
        </div>

        {/* Content List */}
        {loading && profiles.length === 0 ? (
          <div className="card p-12 text-center text-xs text-muted flex flex-col items-center justify-center gap-2">
            <RefreshCw className="h-6 w-6 animate-spin text-crimson-400" />
            <span>Loading accounts…</span>
          </div>
        ) : displayedUsers.length === 0 ? (
          <div className="card p-12 text-center text-xs text-muted">
            No accounts in <span className="font-semibold text-ink">{activeTab}</span> status.
          </div>
        ) : (
          <div className="space-y-3">
            {displayedUsers.map((user) => (
              <div
                key={user.id}
                className="card p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors hover:border-line-bright"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-ink">
                      {user.full_name || user.email?.split('@')[0] || 'User Profile'}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                        user.status === 'approved'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : user.status === 'rejected'
                          ? 'bg-crimson-500/15 text-crimson-300 border-crimson-500/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}
                    >
                      {user.status ? user.status.toUpperCase() : 'PENDING'}
                    </span>
                    <span className="text-[10px] font-mono bg-card-2 px-2 py-0.5 rounded border border-line text-muted">
                      Role: {user.role || 'rep'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" />
                      {user.email}
                    </span>
                    {user.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3.5 w-3.5" />
                        {user.phone}
                      </span>
                    )}
                    {user.structure && (
                      <span className="flex items-center gap-1">
                        <Building className="h-3.5 w-3.5" />
                        {user.structure}
                      </span>
                    )}
                    <span className="text-[11px] opacity-75">
                      Registered: {user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {user.status !== 'approved' && (
                    <button
                      onClick={() => handleAction(user.id, 'approved', user.role || 'admin')}
                      className="btn-success py-1.5 px-3 text-xs flex items-center gap-1"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Approve</span>
                    </button>
                  )}
                  {user.status !== 'rejected' && (
                    <button
                      onClick={() => handleAction(user.id, 'rejected')}
                      className="btn-danger py-1.5 px-3 text-xs flex items-center gap-1"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Decline</span>
                    </button>
                  )}
                  {user.status === 'approved' && (
                    <div className="flex items-center gap-2">
                      <select
                        value={user.role || 'rep'}
                        onChange={(e) => handleAction(user.id, 'approved', e.target.value)}
                        className="input-field py-1 text-xs bg-card-2"
                        title="Change user role"
                      >
                        <option value="rep">Role: Transport Rep (Reps Only)</option>
                        <option value="dispatch_admin">Role: Dispatch Admin</option>
                        <option value="ledger_admin">Role: Ledger Admin</option>
                        <option value="super_admin">Role: Super Administrator</option>
                      </select>
                      <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                        <UserCheck className="h-3.5 w-3.5" />
                        <span>Active</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
