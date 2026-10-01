import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Shield, CheckCircle2, XCircle, AlertTriangle, Users, ArrowLeft, RefreshCw, KeyRound, Building, Phone, Mail } from 'lucide-react';

const SECRET_CODE = import.meta.env.VITE_APPROVAL_SECRET || '230825';

export function ApprovalPage() {
  const [accessCode, setAccessCode] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('pending');
  const [actionNotice, setActionNotice] = useState(null);

  useEffect(() => {
    if (isAuthenticated) {
      fetchProfiles();
    }
  }, [isAuthenticated]);

  function handleAuth(e) {
    e.preventDefault();
    if (accessCode.trim() === SECRET_CODE) {
      setIsAuthenticated(true);
      setAuthError(null);
    } else {
      setAuthError('Invalid Access Code. Please enter the master authorization key.');
    }
  }

  async function fetchProfiles() {
    setLoading(true);
    setActionNotice(null);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (data && Array.isArray(data)) {
        setProfiles(data);
      } else if (error) {
        console.warn('Error fetching profiles:', error);
      }
    } catch (err) {
      console.error('Fetch profiles failed:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(userId, newStatus, newRole) {
    setLoading(true);
    setActionNotice(null);
    try {
      const updates = {
        status: newStatus,
        updated_at: new Date().toISOString(),
      };
      if (newRole) updates.role = newRole;

      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId);

      if (!error) {
        setProfiles((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, ...updates } : u))
        );
        setActionNotice(`Account ${newStatus === 'approved' ? 'approved' : 'rejected'} successfully.`);
        setTimeout(() => setActionNotice(null), 4000);
      } else {
        setActionNotice(`Failed to update status: ${error.message}`);
      }
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Error updating user');
    } finally {
      setLoading(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12 text-ink">
        <form onSubmit={handleAuth} className="max-w-sm w-full bg-card border border-line p-8 rounded-2xl shadow-2xl backdrop-blur-md">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/30 mb-4">
            <KeyRound className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-display font-bold mb-1 text-center text-ink">Admin Approval Portal</h2>
          <p className="text-xs text-muted text-center mb-6">Enter authorization secret to review and configure rep accounts.</p>

          {authError && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-crimson-500/15 border border-crimson-500/40 p-3 text-xs text-crimson-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <div className="mb-4">
            <input
              type="password"
              placeholder="Enter Master Secret Code"
              className="input-field text-xs text-center tracking-widest font-mono"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              autoFocus
            />
          </div>
          <button type="submit" className="btn-crimson w-full py-2.5 text-xs font-bold uppercase tracking-wider">
            Authorize & Access
          </button>
          <div className="mt-4 text-center">
            <Link to="/login" className="text-xs text-muted hover:text-ink">
              ← Return to Login
            </Link>
          </div>
        </form>
      </div>
    );
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
              <span className="badge bg-card-2 border border-line text-muted text-xs">Profiles Control</span>
            </div>
            <p className="text-xs sm:text-sm text-muted">
              Approve, reject, or re-configure role permissions for transport reps and dispatchers.
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
        {loading ? (
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
                      {user.full_name || 'No Name Provided'}
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
                      Submitted: {user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {user.status !== 'approved' && (
                    <button
                      onClick={() => handleAction(user.id, 'approve', user.role || 'rep')}
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
                    <select
                      value={user.role || 'rep'}
                      onChange={(e) => handleAction(user.id, 'approved', e.target.value)}
                      className="input-field py-1 text-xs bg-card-2"
                      title="Change user role"
                    >
                      <option value="rep">Role: Rep</option>
                      <option value="admin">Role: Admin</option>
                    </select>
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
