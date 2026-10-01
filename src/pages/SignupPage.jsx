import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Bus, User, Mail, Lock, Phone, Shield, Building, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';

export function SignupPage() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [structure, setStructure] = useState('');
  const [role, setRole] = useState('rep');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSignup(e) {
    e.preventDefault();
    if (!fullName.trim()) {
      setError('Please provide your full name.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Please enter a valid email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
      });

      if (authError && !authError.message.includes('mock')) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      const userId = authData?.user?.id || `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const userEmail = authData?.user?.email || email.trim().toLowerCase();

      // Configure and register the profile in the profiles table for admin review
      const profileRow = {
        id: userId,
        email: userEmail,
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        structure: structure.trim() || null,
        role: role || 'rep',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert(profileRow, { onConflict: 'id' });

      if (profileError) {
        console.warn('Profile record creation warning:', profileError);
      }

      setMessage('Account created! Your registration has been sent to the administrator for approval.');
      setFullName('');
      setEmail('');
      setPassword('');
      setPhone('');
      setStructure('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred during signup.');
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
            Create CRC Transport Account
          </h2>
          <p className="mt-1 text-xs text-muted">
            Register as a Transport Rep or Admin. Signups require administrator authorization before access is granted.
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl bg-crimson-500/15 border border-crimson-500/40 p-3.5 text-xs text-crimson-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {message && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-500/15 border border-emerald-500/40 p-3.5 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSignup}>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
              Full Name
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                type="text"
                required
                className="input-field pl-9 text-xs"
                placeholder="e.g. Amo Nhlabathi"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
          </div>

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
                placeholder="rep@crcjhb.co.za"
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
                minLength={6}
                className="input-field pl-9 text-xs"
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
                Cell Phone
              </label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="tel"
                  className="input-field pl-9 text-xs"
                  placeholder="082 123 4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
                Structure / Zone
              </label>
              <div className="relative">
                <Building className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  className="input-field pl-9 text-xs"
                  placeholder="e.g. S9, Zone 4"
                  value={structure}
                  onChange={(e) => setStructure(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
              Requested Role
            </label>
            <div className="relative">
              <Shield className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="input-field pl-9 text-xs bg-card"
              >
                <option value="rep">Transport Rep (Check-in & Portals)</option>
                <option value="admin">Transport Dispatch Administrator</option>
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || Boolean(message)}
            className="btn-crimson w-full py-2.5 text-xs font-bold tracking-wide uppercase flex items-center justify-center gap-2 mt-2"
          >
            {loading ? (
              <span>Configuring Account…</span>
            ) : (
              <>
                <span>Submit Sign Up</span>
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>

          <div className="text-center pt-2">
            <Link
              to="/login"
              className="text-xs font-medium text-crimson-400 hover:text-crimson-300 transition-colors"
            >
              Already have an approved account? Sign in →
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
