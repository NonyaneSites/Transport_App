import { useState, useEffect } from 'react';
import { Lock, Trash2, Loader2, AlertTriangle, Calendar, Users, Bus, ArrowUpRight, XCircle, FileSpreadsheet, ChevronDown, ChevronRight, History, Download, FileDown, Eye, Table } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { ExcelUpload } from '@/components/ExcelUpload';
import { VehicleAllocation } from '@/components/VehicleAllocation';
import { useManifest } from '@/lib/useManifest';
import { listAllManifests } from '@/lib/manifest';
import { listLedgerEntries } from '@/lib/ledger';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey as parseKey } from '@/lib/dates';
import { SERVICE_TYPES, RESET_PASSWORD, type ServiceType, type Passenger, type Manifest } from '@/lib/types';
import { isSamePassenger, getSubmissionTimestampEpoch } from '@/lib/importer';
import { generateWhatsAppRouteManifest, generateWhatsAppRepManifest, downloadTextFile } from '@/lib/whatsappManifest';
import { downloadTaxiStatsExcel, downloadTaxiStatsCSV } from '@/lib/statsExport';
import { AdminStatsExportModal } from '@/components/AdminStatsExportModal';
import { AdminAttendanceNotesSection } from '@/components/AdminAttendanceNotesSection';

export function AdminPage() {
  const [date, setDate] = useState(() => {
    try {
      const stored = localStorage.getItem('crc_admin_selected_date');
      if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored.trim())) {
        return stored.trim();
      }
      return upcomingSunday();
    } catch {
      return upcomingSunday();
    }
  });
  const [service, setService] = useState<ServiceType>(() => {
    try {
      return (localStorage.getItem('crc_admin_selected_service') as ServiceType) || 'AM_Serving';
    } catch {
      return 'AM_Serving';
    }
  });
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);

  useEffect(() => {
    try {
      localStorage.setItem('crc_admin_selected_date', date);
    } catch {
      // localStorage full or disabled
    }
  }, [date]);

  useEffect(() => {
    try {
      localStorage.setItem('crc_admin_selected_service', service);
    } catch {
      // localStorage full or disabled
    }
  }, [service]);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetPwd, setResetPwd] = useState('');
  const [resetErr, setResetErr] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sessionList, setSessionList] = useState<Manifest[]>([]);
  const [ledgerCount, setLedgerCount] = useState(0);
  const [archiveSelected, setArchiveSelected] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [exportModalManifest, setExportModalManifest] = useState<{ manifest: Manifest; serviceLabel: string } | null>(null);

  // Initial load on mount only — avoid re-fetching the entire database history on every live tick
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const [mans, ledger] = await Promise.all([
          listAllManifests().catch((err) => {
            console.error('Failed to list manifests:', err);
            return [];
          }),
          listLedgerEntries().catch((err) => {
            console.error('Failed to list ledger entries:', err);
            return [];
          }),
        ]);
        if (isMounted) {
          setSessionList(Array.isArray(mans) ? mans : []);
          setLedgerCount(Array.isArray(ledger) ? ledger.length : 0);
        }
      } catch (err) {
        console.error('Session list fetch error:', err);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  // Sync current active session into sessionList in-memory without database egress
  useEffect(() => {
    if (!manifest || manifest.date !== key) return;
    setSessionList((prev) => {
      const idx = prev.findIndex((m) => m.date === manifest.date);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = manifest;
        return copy;
      }
      return [manifest, ...prev];
    });
  }, [manifest, key]);

  async function handleImport(passengers: Passenger[]) {
    if (!manifest) {
      // Deduplicate incoming batch among itself if saving fresh manifest
      const deduplicated: Passenger[] = [];
      for (const incoming of passengers) {
        if (!deduplicated.some((p) => isSamePassenger(p, incoming))) {
          deduplicated.push(incoming);
        }
      }
      await save({ date: key, signups: deduplicated, vehicles: [] });
      return;
    }

    // Merge incoming passengers into existing manifest signups:
    // If an incoming passenger matches an existing signup:
    //   - Compare timestamps. If incoming is more recent (or equal), update their profile details (stop, structure, phone, email, etc.)
    //     while strictly preserving live assignment and attendance states.
    // If incoming passenger is entirely new:
    //   - Add them as a fresh signup.
    const updatedSignups = [...manifest.signups];
    const fresh: Passenger[] = [];

    for (const incoming of passengers) {
      const existingIdx = updatedSignups.findIndex((existing) => isSamePassenger(existing, incoming));
      if (existingIdx >= 0) {
        const existing = updatedSignups[existingIdx];
        const existingEpoch = getSubmissionTimestampEpoch(existing.timestamp);
        const incomingEpoch = getSubmissionTimestampEpoch(incoming.timestamp);

        if (incomingEpoch >= existingEpoch) {
          // Update profile details with latest submission info
          updatedSignups[existingIdx] = {
            ...existing,
            stop: incoming.stop,
            structure: incoming.structure,
            phone: incoming.phone || existing.phone,
            userEmail: incoming.userEmail || existing.userEmail,
            timestamp: incoming.timestamp || existing.timestamp,
            hub: incoming.hub || existing.hub,
            category: incoming.category || existing.category,
            ministry: incoming.ministry || existing.ministry,
            memberType: incoming.memberType || existing.memberType,
          };
        }
      } else {
        const alreadyInFresh = fresh.some((p) => isSamePassenger(p, incoming));
        if (!alreadyInFresh) {
          fresh.push(incoming);
        }
      }
    }

    await save({ ...manifest, signups: [...updatedSignups, ...fresh] });
  }

  async function handleReset() {
    if (resetPwd !== RESET_PASSWORD) {
      setResetErr(true);
      return;
    }
    setResetting(true);
    try {
      await save({ date: key, signups: [], vehicles: [] });
      setResetOpen(false);
      setResetPwd('');
      setResetErr(false);
    } finally {
      setResetting(false);
    }
  }

  const serviceLabel = SERVICE_TYPES.find((s) => s.value === service)?.label ?? service;

  const totalRegistrations = (sessionList || []).reduce((sum, m) => sum + (m?.signups?.length || 0), 0);
  const totalVehicles = (sessionList || []).reduce((sum, m) => sum + (m?.vehicles?.length || 0), 0);
  const totalPresent = (sessionList || []).reduce((sum, m) => sum + (m?.signups?.filter((p) => p?.present)?.length || 0), 0);

  return (
    <div className="min-h-screen">
      <Header current="admin" />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* Clean Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-line pb-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-bold tracking-tight text-ink sm:text-2xl">
                Transport Dispatch Control
              </h1>
              <span className="badge bg-card-2 text-ink-muted border border-line text-[11px]">
                Admin
              </span>
            </div>
            <p className="mt-1 text-xs sm:text-sm text-muted">
              Allocate passengers to vehicles, manage routes, and coordinate Johannesburg transport.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button onClick={() => setResetOpen(true)} className="btn-danger text-xs py-1.5 px-3">
              <Trash2 className="h-3.5 w-3.5" />
              <span>Reset Manifest</span>
            </button>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <ServiceDateSelector
            date={date}
            service={service}
            onDateChange={setDate}
            onServiceChange={setService}
          />
          <ExcelUpload
            date={date}
            service={service}
            onImport={handleImport}
            existingCount={manifest?.signups?.length ?? 0}
          />
        </div>

        {/* Session banner */}
        <div className="mt-5 flex flex-col gap-2 rounded-xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-card-2 border border-line text-ink">
              <Calendar className="h-5 w-5 text-muted" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Active Session</div>
              <div className="font-display text-base font-bold text-ink">
                {prettyDate(date)} · {serviceLabel}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted bg-card-2 px-2.5 py-1 rounded-md border border-line">
              {key}
            </span>
          </div>
        </div>

        {error && (
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-3 text-sm text-crimson-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Connection error: {error}
          </div>
        )}

        {loading ? (
          <div className="mt-8 flex flex-col items-center gap-3 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-crimson-400" />
            <p className="text-sm text-muted">Loading manifest from cloud...</p>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <VehicleAllocation
              key={key}
              manifest={
                manifest && manifest.date === key
                  ? {
                      date: manifest.date,
                      signups: Array.isArray(manifest.signups) ? manifest.signups : [],
                      vehicles: Array.isArray(manifest.vehicles)
                        ? manifest.vehicles.map((v) => ({
                            ...v,
                            riders: Array.isArray(v.riders) ? v.riders : [],
                            orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
                          }))
                        : [],
                      created_at: manifest.created_at,
                      updated_at: manifest.updated_at,
                    }
                  : { date: key, signups: [], vehicles: [] }
              }
              service={service}
              onSave={save}
            />
          </div>
        )}

        {/* History accordion — collapsed by default */}
        <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-card">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-card-2/40"
          >
            <div className="flex items-center gap-2">
              <div className="h-5 w-1 rounded-full bg-crimson-500" />
              <History className="h-4 w-4 text-muted" />
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Session Archive</h2>
              <span className="badge bg-card-2 text-muted">{sessionList.length} sessions</span>
              <span className="badge bg-crimson-500/15 text-crimson-300">
                <XCircle className="h-3 w-3" />
                {ledgerCount} ledger entries
              </span>
            </div>
            {showHistory ? <ChevronDown className="h-5 w-5 text-muted" /> : <ChevronRight className="h-5 w-5 text-muted" />}
          </button>

          {showHistory && (
            <div className="border-t border-line p-4 animate-fade-in">
              {sessionList.length > 0 && (
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <AdminStat label="Sessions" value={sessionList.length} icon={<Calendar className="h-4 w-4" />} />
                  <AdminStat label="Total Registered" value={totalRegistrations} icon={<Users className="h-4 w-4" />} />
                  <AdminStat label="Vehicles Dispatched" value={totalVehicles} icon={<Bus className="h-4 w-4" />} />
                  <AdminStat label="Total Present" value={totalPresent} icon={<ArrowUpRight className="h-4 w-4" />} accent="success" />
                </div>
              )}

              {sessionList.length === 0 ? (
                <div className="rounded-xl border border-line bg-card py-10 text-center">
                  <Calendar className="mx-auto h-8 w-8 text-line" />
                  <p className="mt-2 text-sm text-muted">No transport sessions recorded yet.</p>
                  <p className="text-xs text-muted">Sessions appear here once a manifest is saved.</p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center flex-wrap">
                    <div className="relative flex-1 min-w-[240px]">
                      <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                      <select
                        value={archiveSelected}
                        onChange={(e) => setArchiveSelected(e.target.value)}
                        className="input-field pl-10"
                      >
                        <option value="" className="bg-card-2">Select a session to download...</option>
                        {sessionList.map((m) => {
                          const { date: mDate, service: mService } = parseKey(m.date || '');
                          const def = SERVICE_TYPES.find((s) => s.value === mService);
                          const signupsLen = m.signups?.length || 0;
                          const vehiclesLen = m.vehicles?.length || 0;
                          return (
                            <option key={m.date} value={m.date} className="bg-card-2">
                              {prettyDate(mDate)} · {def?.label ?? mService} — {signupsLen} registered, {vehiclesLen} vehicles
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => {
                          const m = sessionList.find((s) => s.date === archiveSelected);
                          if (!m) return;
                          downloadTaxiStatsExcel(m);
                        }}
                        disabled={!archiveSelected}
                        className={archiveSelected ? 'btn-ghost border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs py-2 px-3 flex items-center gap-1.5' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted text-xs py-2 px-3'}
                        title="Download full session Transport Stats Excel workbook (.xlsx)"
                      >
                        <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                        <span>Transport Stats (.xlsx)</span>
                      </button>

                      <button
                        onClick={() => {
                          const m = sessionList.find((s) => s.date === archiveSelected);
                          if (!m) return;
                          downloadTaxiStatsCSV(m);
                        }}
                        disabled={!archiveSelected}
                        className={archiveSelected ? 'btn-ghost border-line text-xs py-2 px-3 flex items-center gap-1.5' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted text-xs py-2 px-3'}
                        title="Download Transport Stats CSV table (.csv)"
                      >
                        <Table className="h-4 w-4 text-sky-400" />
                        <span>Transport Stats CSV</span>
                      </button>

                      <button
                        onClick={() => {
                          const m = sessionList.find((s) => s.date === archiveSelected);
                          if (!m) return;
                          const { service: mService } = parseKey(m.date || '');
                          const def = SERVICE_TYPES.find((s) => s.value === mService);
                          setExportModalManifest({ manifest: m, serviceLabel: def?.label ?? mService });
                        }}
                        disabled={!archiveSelected}
                        className={archiveSelected ? 'btn-ghost border-line text-xs py-2 px-3 flex items-center gap-1.5 text-amber-300 hover:bg-amber-500/10' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted text-xs py-2 px-3'}
                        title="Open full Transport Stats Export & Table Preview Console"
                      >
                        <Eye className="h-4 w-4 text-amber-400" />
                        <span>Transport Stats Hub</span>
                      </button>

                      <button
                        onClick={() => {
                          const m = sessionList.find((s) => s.date === archiveSelected);
                          if (!m) return;
                          const { date: mDate, service: mService } = parseKey(m.date || '');
                          const text = generateWhatsAppRouteManifest(m, mService as ServiceType);
                          downloadTextFile(`whatsapp_manifest_${mDate}_${mService}.txt`, text);
                        }}
                        disabled={!archiveSelected}
                        className={archiveSelected ? 'btn-success text-xs py-2 px-3 flex items-center gap-1.5' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted text-xs py-2 px-3'}
                        title="Download WhatsApp Route & Stop Schedule Manifest (.txt)"
                      >
                        <Download className="h-4 w-4" />
                        <span>WhatsApp Manifest</span>
                      </button>

                      <button
                        onClick={() => {
                          const m = sessionList.find((s) => s.date === archiveSelected);
                          if (!m) return;
                          const { date: mDate, service: mService } = parseKey(m.date || '');
                          const text = generateWhatsAppRepManifest(m, mService as ServiceType);
                          downloadTextFile(`whatsapp_rep_manifest_${mDate}_${mService}.txt`, text);
                        }}
                        disabled={!archiveSelected}
                        className={archiveSelected ? 'btn-crimson text-xs py-2 px-3 flex items-center gap-1.5' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted text-xs py-2 px-3'}
                        title="Download WhatsApp Rep Manifest with numbered passenger roster (.txt)"
                      >
                        <FileDown className="h-4 w-4" />
                        <span>Rep Manifest</span>
                      </button>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-line">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-line bg-card-2/50">
                            <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Session Date & Service</th>
                            <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Registered</th>
                            <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Vehicles</th>
                            <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Present</th>
                            <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Updated</th>
                            <th className="px-4 py-3 text-center font-display text-xs font-bold uppercase tracking-wider text-muted">Quick Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line/60">
                          {sessionList.map((m) => {
                            const { date: mDate, service: mService } = parseKey(m.date || '');
                            const def = SERVICE_TYPES.find((s) => s.value === mService);
                            const signupsList = Array.isArray(m.signups) ? m.signups : [];
                            const vehiclesList = Array.isArray(m.vehicles) ? m.vehicles : [];
                            const present = signupsList.filter((p) => p?.present).length;
                            const updated = m.updated_at ? new Date(m.updated_at).toLocaleString('en-ZA', {
                              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                            }) : '—';
                            return (
                              <tr key={m.date} className="transition-colors hover:bg-card-2/30">
                                <td className="px-4 py-3">
                                  <div className="font-semibold text-ink">{prettyDate(mDate)}</div>
                                  <div className="mt-0.5">
                                    <span className={`badge text-[10px] ${
                                      mService.includes('Serving')
                                        ? 'bg-success/15 text-success-light'
                                        : 'bg-crimson-500/15 text-crimson-300'
                                    }`}>
                                      {def?.label ?? mService}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <span className="font-display text-lg font-bold text-ink">{signupsList.length}</span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <span className="font-display text-lg font-bold text-crimson-400">{vehiclesList.length}</span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <span className="font-display text-lg font-bold text-success-light">{present}</span>
                                  <span className="text-xs text-muted"> / {signupsList.length}</span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-xs text-muted">{updated}</td>
                                <td className="px-4 py-3 text-center">
                                  <div className="flex items-center justify-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => downloadTaxiStatsExcel(m)}
                                      title="Download Taxi Stats (.xlsx)"
                                      className="rounded-lg p-1.5 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                    >
                                      <FileSpreadsheet className="h-4 w-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setExportModalManifest({ manifest: m, serviceLabel: def?.label ?? mService })}
                                      title="Open Stats Console"
                                      className="rounded-lg p-1.5 text-amber-400 hover:bg-amber-500/20 transition-colors"
                                    >
                                      <Eye className="h-4 w-4" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Live Attendance, Sponsored & Notes Dispatch Hub (Bottom Drop Box) */}
        {manifest && (
          <div id="admin-attendance-notes-section" className="mt-8">
            <AdminAttendanceNotesSection
              manifest={manifest}
              onLocateVehicle={(vehId) => {
                const el = document.getElementById(`vehicle-card-${vehId}`);
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
            />
          </div>
        )}
      </main>

      {/* Reset modal */}
      {resetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in"
          onClick={() => setResetOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-crimson animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-crimson-500/15 border border-crimson-500/30">
                <Lock className="h-5 w-5 text-crimson-400" />
              </div>
              <div>
                <h3 className="font-display text-base font-bold text-ink">Reset Manifests</h3>
                <p className="text-xs text-muted">This clears vehicles and assignments for this session. The cancellation ledger is NOT affected.</p>
              </div>
            </div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Password
            </label>
            <input
              type="password"
              value={resetPwd}
              onChange={(e) => {
                setResetPwd(e.target.value);
                setResetErr(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleReset()}
              autoFocus
              placeholder="Enter reset password"
              className={`input-field ${resetErr ? 'border-crimson-500' : ''}`}
            />
            {resetErr && (
              <p className="mt-1.5 text-xs text-crimson-300">Incorrect password. Try again.</p>
            )}
            <div className="mt-4 flex gap-2">
              <button onClick={() => setResetOpen(false)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button onClick={handleReset} disabled={resetting} className="btn-crimson flex-1">
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats Export Modal */}
      {exportModalManifest && (
        <AdminStatsExportModal
          manifest={exportModalManifest.manifest}
          serviceLabel={exportModalManifest.serviceLabel}
          isOpen={true}
          onClose={() => setExportModalManifest(null)}
        />
      )}

      <Footer />
    </div>
  );
}

function AdminStat({
  label, value, icon, accent,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent?: 'success';
}) {
  const color = accent === 'success' ? 'text-success-light' : 'text-ink';
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-card-2 ${color}`}>
        {icon}
      </div>
      <div>
        <div className={`font-display text-2xl font-bold ${color}`}>{value}</div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      </div>
    </div>
  );
}
