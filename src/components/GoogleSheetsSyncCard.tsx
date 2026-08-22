import { useState, useEffect } from 'react';
import {
  FileSpreadsheet, ExternalLink, RefreshCw, CheckCircle2, AlertTriangle,
  Loader2, Sparkles, Link as LinkIcon, Settings, Copy, Check
} from 'lucide-react';
import {
  getStoredAccessToken,
  getStoredSpreadsheet,
  setStoredSpreadsheet,
  requestGoogleToken,
  syncLedgerToGoogleSheet,
  clearGoogleSession,
  getGoogleClientId,
  setGoogleClientId,
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
  const [syncResult, setSyncResult] = useState<{ message: string; success: boolean; isOriginError?: boolean } | null>(null);
  const [showCustomSheetInput, setShowCustomSheetInput] = useState(false);
  const [showOAuthSettings, setShowOAuthSettings] = useState(false);
  const [customSheetUrl, setCustomSheetUrl] = useState('');
  const [clientIdInput, setClientIdInput] = useState(() => getGoogleClientId());
  const [copiedOrigin, setCopiedOrigin] = useState(false);
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    setToken(getStoredAccessToken());
    setSheetInfo(getStoredSpreadsheet());
  }, []);

  const handleCopyOrigin = () => {
    navigator.clipboard.writeText(currentOrigin);
    setCopiedOrigin(true);
    setTimeout(() => setCopiedOrigin(false), 2500);
  };

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
      const errStr = e instanceof Error ? e.message : String(e);
      const isOriginError =
        errStr.toLowerCase().includes('origin_mismatch') ||
        errStr.toLowerCase().includes('origin') ||
        errStr.toLowerCase().includes('400');
      
      setSyncResult({
        message: errStr,
        success: false,
        isOriginError,
      });
      if (isOriginError) {
        setShowOAuthSettings(true);
      }
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
      const errStr = e instanceof Error ? e.message : String(e);
      const isOriginError =
        errStr.toLowerCase().includes('origin_mismatch') ||
        errStr.toLowerCase().includes('origin') ||
        errStr.toLowerCase().includes('400');
      
      setSyncResult({
        message: errStr,
        success: false,
        isOriginError,
      });
      if (isOriginError) {
        setShowOAuthSettings(true);
      }
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

  function handleSaveClientId() {
    if (!clientIdInput.trim()) return;
    setGoogleClientId(clientIdInput.trim());
    setSyncResult({ message: 'Saved Google OAuth Client ID.', success: true });
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
          className={`mt-3 flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs ${
            syncResult.success
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-crimson-500/30 bg-crimson-900/20 text-crimson-300'
          }`}
        >
          <div className="flex items-start gap-2">
            {syncResult.success ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-crimson-400" />
            )}
            <span className="flex-1 font-medium">{syncResult.message}</span>
          </div>

          {syncResult.isOriginError && (
            <div className="mt-1.5 rounded-md bg-black/40 p-2.5 text-xs text-ink/90 border border-crimson-500/20 space-y-2">
              <p className="font-semibold text-crimson-300">
                Fixing "Error 400: origin_mismatch":
              </p>
              <ol className="list-decimal pl-4 space-y-1 text-[11px] text-muted leading-relaxed">
                <li>
                  Open your OAuth Client ID in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-crimson-400 underline font-semibold">Google Cloud Console &rarr; Credentials</a>.
                </li>
                <li>
                  Under <strong>Authorized JavaScript origins</strong>, click <strong>+ ADD URI</strong> and paste your exact app origin:
                </li>
              </ol>
              <div className="flex items-center gap-2 bg-bg/80 border border-line rounded px-2.5 py-1.5">
                <code className="text-xs text-ink font-mono flex-1 select-all">{currentOrigin}</code>
                <button
                  type="button"
                  onClick={handleCopyOrigin}
                  className="btn-ghost py-0.5 px-2 text-[11px] flex items-center gap-1 border-line"
                >
                  {copiedOrigin ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copiedOrigin ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-[10px] text-muted italic">
                After saving in Google Cloud Console, wait 1-2 minutes for Google's servers to update, then click "Connect Google Sheets" again.
              </p>
            </div>
          )}
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

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowOAuthSettings(!showOAuthSettings)}
            className="hover:text-ink transition-colors flex items-center gap-1 text-[11px]"
          >
            <Settings className="h-3 w-3" />
            {showOAuthSettings ? 'Hide OAuth Config' : 'OAuth / Origin Setup'}
          </button>
          <button
            type="button"
            onClick={() => setShowCustomSheetInput(!showCustomSheetInput)}
            className="hover:text-ink transition-colors flex items-center gap-1 text-[11px]"
          >
            <LinkIcon className="h-3 w-3" />
            {showCustomSheetInput ? 'Cancel' : 'Link specific sheet ID'}
          </button>
          {token && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-crimson-400 hover:text-crimson-300 transition-colors text-[11px]"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {showOAuthSettings && (
        <div className="mt-3 rounded-lg border border-line/80 bg-bg/40 p-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-ink">
                App JavaScript Origin (for Google Cloud Console)
              </label>
              <button
                type="button"
                onClick={handleCopyOrigin}
                className="text-[11px] font-semibold text-crimson-400 hover:text-crimson-300 flex items-center gap-1"
              >
                {copiedOrigin ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copiedOrigin ? 'Copied to clipboard' : 'Copy Origin'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={currentOrigin}
                className="input-field text-xs font-mono bg-card-2 flex-1"
              />
            </div>
            <p className="mt-1 text-[10px] text-muted">
              Add this URI under <strong>Authorized JavaScript origins</strong> on your Google Cloud Console OAuth 2.0 Client ID.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">
              Google OAuth Client ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
                placeholder="Paste custom OAuth Client ID…"
                className="input-field text-xs font-mono flex-1"
              />
              <button
                type="button"
                onClick={handleSaveClientId}
                className="btn-ghost text-xs px-3 py-1.5 border-line"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

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
