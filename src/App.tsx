import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AdminPage } from '@/pages/AdminPage';
import { RepPage } from '@/pages/RepPage';
import { LedgerPage } from '@/pages/LedgerPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AdminPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/rep" element={<RepPage />} />
        <Route path="/ledger" element={<LedgerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
