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
  }

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-crimson-500/15 border border-crimson-500/30 text-crimson-400 mb-4">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h2 className="font-display text-xl font-bold text-ink mb-2">Something went wrong</h2>
          <p className="text-sm text-muted max-w-md mb-5">
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="btn-crimson flex items-center gap-2 text-xs py-2 px-4"
          >
            <RefreshCw className="h-4 w-4" />
            Reload Portal
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
