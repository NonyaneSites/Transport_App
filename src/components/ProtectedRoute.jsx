import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext'; 

export function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) return <div className="flex justify-center items-center h-screen">Loading...</div>;
  
  if (!user) return <Navigate to="/login" replace />;

  return <Outlet />;
}