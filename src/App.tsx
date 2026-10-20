import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RepPage } from '@/pages/RepPage';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { OfflineGuard } from '@/components/OfflineGuard';
import { AuthProvider } from '@/context/AuthContext'; 
import { isSupabaseConfigured } from '@/lib/supabase';

import { lazyWithRetry } from '@/lib/lazyWithRetry';

// Lazy-load admin, ledger, and auth routes with automatic retry & recovery on deployment updates
const AdminPage = lazyWithRetry(() => import('@/pages/AdminPage'), 'AdminPage');
const LedgerPage = lazyWithRetry(() => import('@/pages/LedgerPage'), 'LedgerPage');
const LoginPage = lazyWithRetry(() => import('@/pages/LoginPage'), 'LoginPage');
const SignupPage = lazyWithRetry(() => import('@/pages/SignupPage'), 'SignupPage');
const ApprovalPage = lazyWithRetry(() => import('@/pages/ApprovalPage'), 'ApprovalPage');

function RouteLoadingFallback() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-crimson-500 border-t-transparent" />
        <span className="text-xs font-medium text-muted">Loading…</span>
      </div>
    </div>
  );
}

export default function App() {
  const showUnconfiguredBanner = import.meta.env.PROD && !isSupabaseConfigured;

  return (
    <ErrorBoundary>
      <OfflineGuard />
      {showUnconfiguredBanner && (
        <div
          className="w-full bg-crimson-600 px-4 py-2.5 text-center text-xs sm:text-sm font-bold text-white shadow-lg sticky top-0 z-50 flex items-center justify-center gap-2"
          role="alert"
        >
          <span aria-hidden="true">⚠️</span>
          <span>Database not connected – changes are NOT being saved. Contact the administrator.</span>
        </div>
      )}
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              {/* Public / Unprotected Routes (Rep workflow kept in initial bundle) */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/rep" element={<RepPage />} />
              <Route path="/" element={<RepPage />} />

              {/* Protected Routes with Explicit Capability Guards */}
              <Route element={<ProtectedRoute requiredCapability="dispatch" />}>
                <Route path="/admin" element={<AdminPage />} />
              </Route>

              <Route element={<ProtectedRoute requiredCapability="ledger" />}>
                <Route path="/ledger" element={<LedgerPage />} />
              </Route>

              <Route element={<ProtectedRoute requiredCapability="governance" />}>
                <Route path="/admin/approve" element={<ApprovalPage />} />
              </Route>

              {/* Catch-all */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}