import { useState } from 'react';
import {
  FileSpreadsheet, Download, Copy, Check, X, FileText,
  Users, Sparkles
} from 'lucide-react';
import type { Manifest } from '@/lib/types';
import {
  extractAllVehicleStats,
  downloadTaxiStatsExcel,
  downloadTaxiStatsCSV,
  downloadDetailedPassengersCSV,
  generateTaxiStatsTSV,
  generateConsolidatedWhatsAppStatsText,
} from '@/lib/statsExport';
import { parseManifestKey, prettyDate } from '@/lib/dates';

interface AdminStatsExportModalProps {
  manifest: Manifest;
  serviceLabel?: string;
  isOpen: boolean;
  onClose: () => void;
}

export function AdminStatsExportModal({
  manifest,
  serviceLabel = 'Transport Session',
  isOpen,
  onClose,
}: AdminStatsExportModalProps) {
  const [copiedTSV, setCopiedTSV] = useState(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState(false);
  const [activeTab, setActiveTab] = useState<'summary' | 'preview' | 'whatsapp'>('summary');

  if (!isOpen) return null;

  const { date: sessionDate } = parseManifestKey(manifest.date);
  const statsList = extractAllVehicleStats(manifest);

  const totalAllocated = statsList.reduce((sum, s) => sum + s.totalRiders, 0);
  const totalPresent = statsList.reduce((sum, s) => sum + s.presentCount, 0);
  const totalAbsent = statsList.reduce((sum, s) => sum + s.absentCount, 0);
  const totalFTVs = statsList.reduce((sum, s) => sum + s.ftvCount, 0);
  const totalSponsored = statsList.reduce((sum, s) => sum + s.sponsoredCount, 0);
  const totalFares = statsList.reduce((sum, s) => sum + s.fareCollected, 0);

  const handleCopyTSV = async () => {
    const tsv = generateTaxiStatsTSV(manifest);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopiedTSV(true);
      setTimeout(() => setCopiedTSV(false), 2500);
    } catch {
      // Fallback
    }
  };

  const handleCopyWhatsApp = async () => {
    const text = generateConsolidatedWhatsAppStatsText(manifest, serviceLabel);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedWhatsApp(true);
      setTimeout(() => setCopiedWhatsApp(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-5 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl border border-line bg-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line bg-card-2 px-5 py-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-emerald-500/15 p-2 text-emerald-400 border border-emerald-500/30">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-display text-base font-bold text-ink">
                  Download Taxi Stats for Excel & Google Sheets
                </h2>
                <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px] font-mono">
                  {statsList.length} Vehicles
                </span>
              </div>
              <p className="text-xs text-muted">
                {prettyDate(sessionDate)} · {serviceLabel}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-card hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Quick Summary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 border-b border-line bg-bg/50 px-5 py-3 shrink-0 text-xs">
          <div className="rounded-lg border border-line/60 bg-card p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-muted block">Vehicles</span>
            <span className="font-display text-base font-bold text-ink">{statsList.length}</span>
          </div>
          <div className="rounded-lg border border-line/60 bg-card p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-muted block">Allocated</span>
            <span className="font-display text-base font-bold text-ink">{totalAllocated}</span>
          </div>
          <div className="rounded-lg border border-success/30 bg-success/5 p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-success-light block">Present</span>
            <span className="font-display text-base font-bold text-success-light">{totalPresent}</span>
          </div>
          <div className="rounded-lg border border-crimson-500/30 bg-crimson-500/5 p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-crimson-300 block">Absent</span>
            <span className="font-display text-base font-bold text-crimson-300">{totalAbsent}</span>
          </div>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-amber-300 block">FTVs</span>
            <span className="font-display text-base font-bold text-amber-300">{totalFTVs}</span>
          </div>
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2 text-center">
            <span className="text-[10px] uppercase font-bold text-sky-300 block">Sponsored</span>
            <span className="font-display text-base font-bold text-sky-300">{totalSponsored}</span>
          </div>
        </div>

        {/* Action Buttons Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-card px-5 py-3 shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            <span>Export Formats:</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Download Excel (.xlsx) */}
            <button
              onClick={() => downloadTaxiStatsExcel(manifest)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25 transition-all shadow-sm"
              title="Download full formatted Excel (.xlsx) workbook with 3 sheets"
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>Download Excel (.xlsx)</span>
            </button>

            {/* Download CSV */}
            <button
              onClick={() => downloadTaxiStatsCSV(manifest)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card-2 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-card-2/80 transition-all shadow-sm"
              title="Download CSV for Google Sheets or Excel"
            >
              <Download className="h-3.5 w-3.5 text-muted" />
              <span>Download CSV</span>
            </button>

            {/* Copy for Google Sheets */}
            <button
              onClick={handleCopyTSV}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-bold text-sky-300 hover:bg-sky-500/25 transition-all shadow-sm"
              title="Copy tab-delimited table ready to paste directly into Google Sheets columns"
            >
              {copiedTSV ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedTSV ? 'Copied for Sheets!' : 'Copy for Google Sheets'}</span>
            </button>

            {/* Copy WhatsApp Stats Message */}
            <button
              onClick={handleCopyWhatsApp}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-300 hover:bg-amber-500/25 transition-all shadow-sm"
              title="Copy consolidated WhatsApp stats summary text"
            >
              {copiedWhatsApp ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <FileText className="h-3.5 w-3.5" />}
              <span>{copiedWhatsApp ? 'Copied WhatsApp!' : 'Copy WhatsApp Stats'}</span>
            </button>

            {/* Download Detailed Roster */}
            <button
              onClick={() => downloadDetailedPassengersCSV(manifest)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-ink transition-colors"
              title="Download detailed passenger-level CSV with structure, stops, and flags"
            >
              <Users className="h-3.5 w-3.5" />
              <span>Detailed Roster (.csv)</span>
            </button>
          </div>
        </div>

        {/* View mode toggle */}
        <div className="flex items-center justify-between border-b border-line/60 bg-bg px-5 py-2 shrink-0">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('summary')}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                activeTab === 'summary'
                  ? 'bg-crimson-600 text-white shadow-xs'
                  : 'text-muted hover:text-ink'
              }`}
            >
              Table View ({statsList.length} Taxis)
            </button>
            <button
              onClick={() => setActiveTab('whatsapp')}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                activeTab === 'whatsapp'
                  ? 'bg-crimson-600 text-white shadow-xs'
                  : 'text-muted hover:text-ink'
              }`}
            >
              WhatsApp Stats Text View
            </button>
          </div>

          <span className="text-[11px] text-muted">
            Formatted as <span className="font-mono text-crimson-300 font-semibold">Name Structure</span> (e.g. Person A S3)
          </span>
        </div>

        {/* Modal Body / Table Preview */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {statsList.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">
              No vehicles have been created or allocated for this session yet.
            </div>
          ) : activeTab === 'summary' ? (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-xl border border-line bg-card shadow-xs">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line bg-card-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                      <th className="px-3 py-2.5">Vehicle</th>
                      <th className="px-3 py-2.5">Rep</th>
                      <th className="px-3 py-2.5 text-center">Status</th>
                      <th className="px-3 py-2.5 text-center">Total</th>
                      <th className="px-3 py-2.5 text-center text-success-light">Present</th>
                      <th className="px-3 py-2.5 text-center text-crimson-300">Absent</th>
                      <th className="px-3 py-2.5 text-center text-amber-300">FTVs</th>
                      <th className="px-3 py-2.5 text-center text-sky-300">Sponsored</th>
                      <th className="px-3 py-2.5 text-right">Fare (R)</th>
                      <th className="px-4 py-2.5 min-w-[280px]">Present Members & Visitors</th>
                      <th className="px-4 py-2.5 min-w-[220px]">Cancellations (Absentees)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {statsList.map((s) => (
                      <tr key={s.vehicleId} className="hover:bg-card-2/40 transition-colors">
                        <td className="px-3 py-2.5 font-bold text-ink whitespace-nowrap">
                          {s.type === 'Bus' ? '🚌' : '🚕'} {s.name}
                        </td>
                        <td className="px-3 py-2.5 text-muted font-medium whitespace-nowrap">
                          {s.repName}
                        </td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          {s.status === 'Submitted' ? (
                            <span className="badge bg-success/15 text-success-light font-semibold text-[10px]">
                              ✓ Submitted
                            </span>
                          ) : s.status === 'Draft in Progress' ? (
                            <span className="badge bg-amber-500/15 text-amber-300 font-semibold text-[10px]">
                              Draft
                            </span>
                          ) : (
                            <span className="badge bg-card-2 text-muted text-[10px]">
                              Unmarked
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center font-bold text-ink">{s.totalRiders}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-success-light">{s.presentCount}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-crimson-300">{s.absentCount}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-amber-300">{s.ftvCount}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-sky-300">{s.sponsoredCount}</td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink whitespace-nowrap">
                          R{s.fareCollected}
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-muted">
                          <span className="text-ink font-medium">{s.presentListStr}</span>
                          {s.ftvCount > 0 && (
                            <div className="mt-1 text-[10px] text-amber-400 font-semibold">
                              ⭐ FTVs: {s.ftvListStr}
                            </div>
                          )}
                          {s.sponsoredCount > 0 && (
                            <div className="mt-0.5 text-[10px] text-sky-400 font-semibold">
                              🤝 Sponsored: {s.sponsoredListStr}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-crimson-300 font-medium">
                          {s.cancellationListStr}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line bg-card-2 font-bold text-ink">
                      <td className="px-3 py-3">GRAND TOTAL</td>
                      <td className="px-3 py-3 text-muted">—</td>
                      <td className="px-3 py-3 text-center text-muted">—</td>
                      <td className="px-3 py-3 text-center">{totalAllocated}</td>
                      <td className="px-3 py-3 text-center text-success-light">{totalPresent}</td>
                      <td className="px-3 py-3 text-center text-crimson-300">{totalAbsent}</td>
                      <td className="px-3 py-3 text-center text-amber-300">{totalFTVs}</td>
                      <td className="px-3 py-3 text-center text-sky-300">{totalSponsored}</td>
                      <td className="px-3 py-3 text-right font-mono text-crimson-300">R{totalFares}</td>
                      <td className="px-4 py-3 text-muted">—</td>
                      <td className="px-4 py-3 text-muted">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Instructions tip card */}
              <div className="rounded-xl border border-line/70 bg-card-2/40 p-3.5 text-xs text-muted flex items-start gap-2.5">
                <Sparkles className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <span className="font-bold text-ink">Google Sheets & Excel Import Tip:</span>
                  <p>
                    Click <strong className="text-sky-300">Copy for Google Sheets</strong> to paste the full table directly into a Google Sheet spreadsheet, or click <strong className="text-emerald-300">Download Excel (.xlsx)</strong> to get a multi-tab workbook with Summary, Detailed Roster, and Stats Link formatted lists.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted">
                  Consolidated WhatsApp / Stats Link Roster:
                </span>
                <button
                  onClick={handleCopyWhatsApp}
                  className="btn-amber text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  {copiedWhatsApp ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedWhatsApp ? 'Copied to Clipboard!' : 'Copy Full Message'}</span>
                </button>
              </div>
              <pre className="rounded-xl border border-line bg-bg p-4 font-mono text-xs text-ink whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto">
                {generateConsolidatedWhatsAppStatsText(manifest, serviceLabel)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line bg-card px-5 py-3 shrink-0">
          <span className="text-xs text-muted">
            CRC Johannesburg Transport Dispatch
          </span>
          <button
            onClick={onClose}
            className="btn-ghost px-4 py-1.5 text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
