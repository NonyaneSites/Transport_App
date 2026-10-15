import { useState, useEffect, useRef, useCallback } from 'react';
import { WifiOff, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';

export function OfflineGuard() {
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<number>(6);
  const [showRestored, setShowRestored] = useState<boolean>(false);
  const consecutiveFailsRef = useRef<number>(0);
  const checkingRef = useRef<boolean>(false);

  const testConnection = useCallback(async (): Promise<boolean> => {
    if (checkingRef.current) return isOnline;
    checkingRef.current = true;
    setIsChecking(true);

    // If browser itself reports offline, no need to probe network
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      consecutiveFailsRef.current += 1;
      setIsOnline(false);
      setIsChecking(false);
      checkingRef.current = false;
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      // Use cached-busted lightweight asset probe to check true end-to-end connectivity
      const response = await fetch(`/favicon-32x32.png?probe=${Date.now()}`, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const ok = response.ok || response.status === 304 || response.type === 'opaque';
      if (ok) {
        consecutiveFailsRef.current = 0;
        setIsOnline((prev) => {
          if (!prev) {
            setShowRestored(true);
            setTimeout(() => setShowRestored(false), 4500);
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('crc_connection_restored'));
            }
          }
          return true;
        });
        setIsChecking(false);
        checkingRef.current = false;
        return true;
      } else {
        consecutiveFailsRef.current += 1;
        setIsOnline(false);
        setIsChecking(false);
        checkingRef.current = false;
        return false;
      }
    } catch {
      clearTimeout(timeoutId);
      consecutiveFailsRef.current += 1;
      setIsOnline(false);
      setIsChecking(false);
      checkingRef.current = false;
      return false;
    }
  }, [isOnline]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      setCountdown(5);
    };

    const handleOnline = () => {
      testConnection();
    };

    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      const msg = String(e?.reason?.message || e?.reason || '').toLowerCase();
      if (
        msg.includes('failed to fetch') ||
        msg.includes('networkerror') ||
        msg.includes('network error') ||
        msg.includes('aborted') ||
        msg.includes('connection refused')
      ) {
        testConnection();
      }
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    // Initial verify
    testConnection();

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [testConnection]);

  // Periodic interval: fast auto-retry when offline, slow sanity check when online
  useEffect(() => {
    if (!isOnline) {
      setCountdown(6);
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            testConnection();
            return 6;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    } else {
      // Slow sanity ping every 45s while page is active
      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && !document.hidden) {
          testConnection();
        }
      }, 45000);
      return () => clearInterval(timer);
    }
  }, [isOnline, testConnection]);

  return (
    <>
      {/* Restored Toast */}
      {showRestored && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100000] flex items-center gap-2.5 rounded-2xl border border-emerald-500/50 bg-emerald-950/95 px-5 py-3 text-xs sm:text-sm font-semibold text-emerald-100 shadow-2xl backdrop-blur-md animate-fade-in"
        >
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
          <span>Connection restored! You are back online.</span>
        </div>
      )}

      {/* Blocking Offline Screen */}
      {!isOnline && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="offline-title"
          aria-describedby="offline-desc"
          className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md animate-fade-in"
        >
          <div className="w-full max-w-md rounded-3xl border border-crimson-500/40 bg-card p-6 sm:p-7 shadow-2xl space-y-5 text-center text-ink relative overflow-hidden">
            {/* Top warning ribbon */}
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-crimson-600 via-amber-500 to-crimson-600 animate-pulse" />

            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-crimson-500/15 text-crimson-400 border border-crimson-500/30 shadow-inner">
              <WifiOff className="h-8 w-8 animate-bounce" />
            </div>

            <div className="space-y-2">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-crimson-500/20 border border-crimson-500/40 px-3 py-1 text-xs font-bold text-crimson-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>OFFLINE / UNSTABLE NETWORK</span>
              </div>
              <h2 id="offline-title" className="font-display text-xl sm:text-2xl font-bold tracking-tight text-white">
                No Internet Connection
              </h2>
              <p id="offline-desc" className="text-xs sm:text-sm text-muted leading-relaxed">
                You are currently offline or your Wi-Fi connection is unstable. All editing and actions have been paused to prevent making changes that cannot be saved or operating under false pretenses.
              </p>
            </div>

            <div className="rounded-2xl border border-line bg-card-2/70 p-4 text-xs text-muted text-left space-y-1.5">
              <div className="font-bold text-ink flex items-center gap-1.5">
                <span>What should I do?</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-muted/90 pl-1">
                <li>Check your device’s Wi-Fi or mobile data signal.</li>
                <li>Stay on this screen; your data is safe and will not be lost.</li>
                <li>The app will automatically resume as soon as internet returns.</li>
              </ul>
            </div>

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                onClick={() => testConnection()}
                disabled={isChecking}
                className="btn-crimson w-full py-3 px-4 text-sm font-bold flex items-center justify-center gap-2 shadow-lg active:scale-98 transition-all disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${isChecking ? 'animate-spin' : ''}`} />
                <span>{isChecking ? 'Checking Connection…' : 'Try Reconnecting Now'}</span>
              </button>

              <div className="text-[11px] text-muted font-medium">
                Auto-retrying in <strong className="text-ink font-mono">{countdown}s</strong>…
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
