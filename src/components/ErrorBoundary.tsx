import React, { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error in UI component:', error, errorInfo);

    const errorMsg = error?.message || '';
    const isChunkError =
      errorMsg.includes('Failed to fetch dynamically imported module') ||
      errorMsg.includes('Loading chunk') ||
      errorMsg.includes('Importing a module script failed') ||
      errorMsg.includes('error loading dynamically imported module');

    if (isChunkError) {
      const lastReload = sessionStorage.getItem('last_auto_chunk_reload');
      const now = Date.now();
      if (!lastReload || now - parseInt(lastReload, 10) > 10000) {
        sessionStorage.setItem('last_auto_chunk_reload', String(now));
        window.location.reload();
      }
    }
  }

  public override render() {
    if (this.state.hasError) {
      const errorMsg = this.state.error?.message || '';
      const isChunkError =
        errorMsg.includes('Failed to fetch dynamically imported module') ||
        errorMsg.includes('Loading chunk') ||
        errorMsg.includes('Importing a module script failed') ||
        errorMsg.includes('error loading dynamically imported module');

      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-crimson-500/15 border border-crimson-500/30 text-crimson-400 mb-4">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h2 className="font-display text-xl font-bold text-ink mb-2">
            {isChunkError ? 'New Update Available' : 'Something went wrong'}
          </h2>
          <p className="text-sm text-muted max-w-md mb-5">
            {isChunkError
              ? 'A new version of CRC Transport was published. Please refresh to load the latest system modules and updates.'
              : errorMsg || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              // Force cache-busting reload
              window.location.href = window.location.pathname + (window.location.search ? window.location.search : '');
              window.location.reload();
            }}
            className="btn-crimson flex items-center gap-2 text-xs py-2 px-4"
          >
            <RefreshCw className="h-4 w-4" />
            {isChunkError ? 'Update & Refresh App' : 'Reload Portal'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
