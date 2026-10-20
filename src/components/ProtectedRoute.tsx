import { Link, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Clock, LogOut, ArrowLeft, ShieldAlert } from 'lucide-react';

export interface ProtectedRouteProps {
  requiredCapability?: 'dispatch' | 'ledger' | 'governance' | 'any_admin';
  requireAdmin?: boolean;
}

export function ProtectedRoute({ requiredCapability = 'any_admin', requireAdmin = false }: ProtectedRouteProps = {}) {
  const {
    user,
    profile,
    loading,
    isApproved,
    canAccessDispatch,
    canAccessLedger,
    canAccessGovernance,
    isAdmin,
    signOut,
  } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-crimson-500 border-t-transparent" />
          <span className="text-xs font-medium text-muted">Checking authorization…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // If user is logged in but not yet approved by an admin
  if (!isApproved) {
    const isRejected = profile?.status === 'rejected';
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-ink">
        <div className="max-w-md w-full bg-card border border-line p-8 rounded-2xl shadow-2xl text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <Clock className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-display font-bold text-ink">
            {isRejected ? 'Account Access Declined' : 'Account Pending Authorization'}
          </h2>
          <p className="text-xs text-muted leading-relaxed">
            {isRejected
              ? `Your account (${user.email}) was declined by the administrator. Please contact church transport leadership.`
              : `Your account (${user.email}) has been registered and is awaiting administrator approval. You will have access as soon as an admin approves your profile.`}
          </p>
          <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-center">
            <Link to="/rep" className="btn-secondary text-xs py-2 px-4 flex items-center justify-center gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Go to Reps Portal</span>
            </Link>
            <button
              onClick={() => signOut()}
              className="btn-ghost text-xs py-2 px-4 flex items-center justify-center gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Specific Capability Enforcement
  let isAuthorized = true;
  let requiredLabel = 'Administrator';
  let roleNotice = '';

  if (requiredCapability === 'governance') {
    isAuthorized = canAccessGovernance;
    requiredLabel = 'Super Administrator';
    roleNotice = 'Only the designated Super Administrator has permissions to approve accounts and manage role assignments.';
  } else if (requiredCapability === 'dispatch') {
    isAuthorized = canAccessDispatch;
    requiredLabel = 'Dispatch Administrator';
    roleNotice = 'This section requires Dispatch Administrator privileges to manage vehicle allocations and Sunday/DreamWeek sessions.';
  } else if (requiredCapability === 'ledger') {
    isAuthorized = canAccessLedger;
    requiredLabel = 'Cancellation & Ledger Administrator';
    roleNotice = 'This section requires Cancellation Ledger privileges to review debt records, payments, and sponsorships.';
  } else if (requireAdmin || requiredCapability === 'any_admin') {
    isAuthorized = isAdmin;
    requiredLabel = 'Administrative';
    roleNotice = 'Access requires an assigned Dispatch, Ledger, or Super Administrator role.';
  }

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-ink">
        <div className="max-w-md w-full bg-card border border-line p-8 rounded-2xl shadow-2xl text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-crimson-500/20 text-crimson-400 border border-crimson-500/30">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-display font-bold text-ink">{requiredLabel} Access Required</h2>
          <p className="text-xs text-muted leading-relaxed">
            {roleNotice} Your account ({user.email}) is currently assigned as <strong className="text-ink">{profile?.role || 'rep'}</strong>.
          </p>
          <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-center">
            {canAccessDispatch && (
              <Link to="/admin" className="btn-crimson text-xs py-2 px-4 flex items-center justify-center gap-1.5">
                <span>Go to Dispatch</span>
              </Link>
            )}
            {canAccessLedger && (
              <Link to="/ledger" className="btn-secondary text-xs py-2 px-4 flex items-center justify-center gap-1.5">
                <span>Go to Ledger</span>
              </Link>
            )}
            <Link to="/rep" className="btn-ghost text-xs py-2 px-4 flex items-center justify-center gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Reps Portal</span>
            </Link>
            <button
              onClick={() => signOut()}
              className="btn-ghost text-xs py-2 px-4 flex items-center justify-center gap-1.5"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <Outlet />;
}