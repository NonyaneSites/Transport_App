// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AdminPage } from '@/pages/AdminPage';
import { RepPage } from '@/pages/RepPage';
import { LedgerPage } from '@/pages/LedgerPage';
import { LoginPage } from '@/pages/LoginPage';
import { SignupPage } from '@/pages/SignupPage';
import { ApprovalPage } from '@/pages/ApprovalPage';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AuthProvider } from '@/context/AuthContext'; 





export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public / Unprotected Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/admin/approve" element={<ApprovalPage />} />
            <Route path="/rep" element={<RepPage />} />
            <Route path="/" element={<RepPage />} />

            {/* Protected Routes */}
            <Route element={<ProtectedRoute />}>
              
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/ledger" element={<LedgerPage />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}