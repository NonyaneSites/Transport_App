import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Bus, Mail, Lock, AlertCircle, ArrowRight } from 'lucide-react';

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
    
    try {
      // 1. Authenticate with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      if (!authData?.user) {
        setError('Login failed: user profile not found.');
        setLoading(false);
        return;
      }

      // 2. Check the user's approval status in the profiles table
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authData.user.id)
        .maybeSingle();

      // 3. Block access if not approved
      if (profile && profile.status !== 'approved') {
        await supabase.auth.signOut();
        
        if (profile.status === 'pending') {
          setError('Your account is currently pending administrator approval. Please wait for an admin to authorize your access.');
        } else if (profile.status === 'rejected') {
          setError('Your account request was declined. Please contact the transport administrator.');
        } else {
          setError('Your account is not approved to log in.');
        }
      } else {
        // 4. Success! Route according to role or go to dispatch
        if (profile?.role === 'rep') {
          navigate('/rep');
        } else {
          navigate('/admin');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12 text-ink selection:bg-crimson-500 selection:text-white">
      <div className="max-w-md w-full space-y-6 bg-card border border-line p-8 rounded-2xl shadow-2xl backdrop-blur-md">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-crimson-500/20 text-crimson-400 border border-crimson-500/30 mb-3">
            <Bus className="h-6 w-6" />
          </div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink">
            Sign In to CRC Transport
          </h2>
          <p className="mt-1 text-xs text-muted">
            Johannesburg Sunday & DreamWeek Transport Control System
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl bg-crimson-500/15 border border-crimson-500/40 p-3.5 text-xs text-crimson-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleLogin}>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
              Email Address
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                type="email"
                required
                className="input-field pl-9 text-xs"
                placeholder="admin@crcjhb.co.za"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                type="password"
                required
                className="input-field pl-9 text-xs"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn-crimson w-full py-2.5 text-xs font-bold tracking-wide uppercase flex items-center justify-center gap-2 mt-2"
          >
            {loading ? (
              <span>Authenticating…</span>
            ) : (
              <>
                <span>Sign In</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>

          <div className="flex items-center justify-between pt-3 text-xs">
            <Link
              to="/signup"
              className="font-medium text-crimson-400 hover:text-crimson-300 transition-colors"
            >
              Don't have an account? Sign up
            </Link>
            <Link
              to="/rep"
              className="text-muted hover:text-ink transition-colors"
            >
              Reps Portal →
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
