import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const navigate = useNavigate();

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    // 1. Authenticate with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    
    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // 2. Check the user's approval status in the profiles table
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('status')
      .eq('id', authData.user.id)
      .single();

    // 3. Block access if not approved
    if (profile?.status !== 'approved') {
      await supabase.auth.signOut(); // Immediately sign them out
      
      if (profile?.status === 'pending') {
        setError("Your account is pending admin approval. Please wait.");
      } else if (profile?.status === 'rejected') {
        setError("Your account request was declined.");
      } else {
        setError("Your account is not approved to log in.");
      }
    } else {
      // 4. Success! Proceed to app
      navigate('/admin'); 
    }
    
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-xl shadow-md">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">Sign in to your account</h2>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          {error && <div className="text-red-500 text-sm text-center bg-red-50 p-2 rounded">{error}</div>}
          <div className="rounded-md shadow-sm space-y-4">
            <div>
              <label className="sr-only" htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                required
                className="appearance-none rounded-lg relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="sr-only" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                required
                className="appearance-none rounded-lg relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </div>
          <div className="text-sm text-center">
            <Link to="/signup" className="font-medium text-blue-600 hover:text-blue-500">
              Don't have an account? Sign up
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}