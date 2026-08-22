import { useState, useEffect } from 'react';
import {
  FileSpreadsheet, ExternalLink, RefreshCw, CheckCircle2, AlertTriangle,
  Loader2, Sparkles, Link as LinkIcon
} from 'lucide-react';
import {
  getStoredAccessToken,
  getStoredSpreadsheet,
  setStoredSpreadsheet,
  requestGoogleToken,
  syncLedgerToGoogleSheet,
  clearGoogleSession,
} from '@/lib/googleSheets';

interface GoogleSheetsSyncCardProps {
  onSyncComplete?: () => void;
}

export function GoogleSheetsSyncCard({ onSyncComplete }: GoogleSheetsSyncCardProps) {
  const [token, setToken] = useState<string | null>(null);
  const [sheetInfo, setSheetInfo] = useState<{ id: string | null; url: string | null }>({ id: null, url: null });
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(() => localStorage.getItem('crc_cancellation_last_synced'));
  const [syncResult, setSyncResult] = useState<{ message: string; success: boolean } | null>(null);
  const [showCustomSheetInput, setShowCustomSheetInput] = useState(false);
  const [customSheetUrl, setCustomSheetUrl] = useState('');

  useEffect(() => {
    setToken(getStoredAccessToken());
    setSheetInfo(getStoredSpreadsheet());
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setSyncResult(null);
    try {
      const newToken = await requestGoogleToken();
      setToken(newToken);
      setSyncResult({ message: 'Google account connected successfully! Creating & syncing spreadsheet…', success: true });
      
      // Immediately run sync to generate/update the Google Sheet
      setSyncing(true);
      const res = await syncLedgerToGoogleSheet(newToken);
      setSheetInfo({ id: res.spreadsheetId, url: res.spreadsheetUrl });
      const now = new Date().toISOString();
      setLastSyncTime(now);
      setSyncResult({
        message: `Synced ${res.rowCount} cancellation records (R${res.totalDebt} debt) to Google Sheet!`,
        success: true,
      });
      onSyncComplete?.();
    } catch (e) {
      setSyncResult({
        message: e instanceof Error ? e.message : String(e),
        success: false,
      });
    } finally {
      setConnecting(false);
      setSyncing(false);
    }
  }

  async function handleManualSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      let activeToken = getStoredAccessToken();
      if (!activeToken) {
        activeToken = await requestGoogleToken();
        setToken(activeToken);
      }
      const res = await syncLedgerToGoogleSheet(activeToken);
      setSheetInfo({ id: res.spreadsheetId, url: res.spreadsheetUrl });
      const now = new Date().toISOString();
      setLastSyncTime(now);
      setSyncResult({
        message: `Updated Google Sheet with ${res.rowCount} submitted cancellations (R${res.totalDebt} total debt).`,
        success: true,
      });
      onSyncComplete?.();
    } catch (e) {
      setSyncResult({
        message: e instanceof Error ? e.message : String(e),
        success: false,
      });
    } finally {
      setSyncing(false);
    }
  }

  function handleLinkCustomSheet() {
    if (!customSheetUrl.trim()) return;
    let extractedId = customSheetUrl.trim();
    const match = customSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
      extractedId = match[1];
    }
    const fullUrl = `https://docs.google.com/spreadsheets/d/${extractedId}/edit`;
    setStoredSpreadsheet(extractedId, fullUrl);
    setSheetInfo({ id: extractedId, url: fullUrl });
    setShowCustomSheetInput(false);
    setCustomSheetUrl('');
    setSyncResult({ message: 'Linked custom Google Sheet. Click "Sync Now" to push current cancellation records.', success: true });
  }

  function handleDisconnect() {
    clearGoogleSession();
    setToken(null);
    setSyncResult({ message: 'Google session cleared.', success: true });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card p-5 mb-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-display text-base font-bold text-ink">
                Google Sheets Live Cancellation Ledger
              </h3>
              {token ? (
                <span className="badge bg-emerald-500/15 text-emerald-300 text-[10px]">
                  <CheckCircle2 className="h-3 w-3 inline mr-1" />
                  Live Sync Active
                </span>
              ) : (
                <span className="badge bg-line text-muted text-[10px]">
                  Ready to Connect
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted max-w-xl">
              Cancellations automatically sync to Google Sheets as soon as a Rep submits attendance. If a Rep re-opens a vehicle to edit, unsubmitted names are instantly withdrawn from the sheet until resubmitted.
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {sheetInfo.url && (
            <a
              href={sheetInfo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs flex items-center gap-1.5 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open Google Sheet
            </a>
          )}

          {token ? (
            <button
              onClick={handleManualSync}
              disabled={syncing}
              className="btn-success text-xs"
            >
              {syncing ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Syncing…
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync Now
                </span>
              )}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={connecting || syncing}
              className="btn-crimson text-xs flex items-center gap-1.5"
            >
              {connecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Connect Google Sheets
            </button>
          )}
        </div>
      </div>

      {/* Sync result feedback */}
      {syncResult && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
            syncResult.success
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-crimson-500/30 bg-crimson-900/20 text-crimson-300'
          }`}
        >
          {syncResult.success ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1">{syncResult.message}</span>
        </div>
      )}

      {/* Bottom meta & secondary controls */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3 text-[11px] text-muted">
        <div className="flex items-center gap-3 flex-wrap">
          {lastSyncTime && (
            <span>
              Last Synced: <strong>{new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong>
            </span>
          )}
          {sheetInfo.id && (
            <span className="font-mono text-[10px] bg-bg/60 px-1.5 py-0.5 rounded text-muted">
              Sheet ID: {sheetInfo.id.slice(0, 8)}…{sheetInfo.id.slice(-6)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCustomSheetInput(!showCustomSheetInput)}
            className="hover:text-ink transition-colors flex items-center gap-1"
          >
            <LinkIcon className="h-3 w-3" />
            {showCustomSheetInput ? 'Cancel' : 'Link specific sheet ID'}
          </button>
          {token && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-crimson-400 hover:text-crimson-300 transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {showCustomSheetInput && (
        <div className="mt-3 flex gap-2 border-t border-line/60 pt-3">
          <input
            type="text"
            value={customSheetUrl}
            onChange={(e) => setCustomSheetUrl(e.target.value)}
            placeholder="Paste Google Sheet URL or Spreadsheet ID…"
            className="input-field text-xs flex-1"
          />
          <button
            type="button"
            onClick={handleLinkCustomSheet}
            disabled={!customSheetUrl.trim()}
            className="btn-crimson text-xs whitespace-nowrap px-3 py-1.5"
          >
            Save Link
          </button>
        </div>
      )}
    </div>
  );
}
