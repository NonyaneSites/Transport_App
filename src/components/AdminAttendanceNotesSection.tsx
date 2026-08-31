import { useState, useMemo } from 'react';
import {
  HeartHandshake,
  UserX,
  StickyNote,
  Copy,
  Check,
  Search,
  Users,
  FileText,
  ChevronDown,
  ChevronUp,
  Coins,
  MapPin,
  Sparkles,
  ExternalLink,
  MessageSquare,
  AlertCircle
} from 'lucide-react';
import type { Manifest, Vehicle, Passenger } from '@/lib/types';
import { sortVehiclesNatural } from '@/lib/sort';
import { getPassengerStatusBadge } from '@/lib/types';

interface AdminAttendanceNotesSectionProps {
  manifest: Manifest;
  onLocateVehicle?: (vehicleId: string) => void;
}

interface SponsoredRiderItem {
  passenger: Passenger;
  vehicle: Vehicle;
  sponsorNote: string;
  repName: string;
  isPresent: boolean;
}

interface UnpaidRiderItem {
  passenger: Passenger;
  vehicle: Vehicle;
  unpaidNote: string;
  repName: string;
  isPresent: boolean;
}

interface AbsentRiderItem {
  passenger: Passenger;
  vehicle: Vehicle;
  repName: string;
  note?: string;
}

interface RiderNoteItem {
  passenger: Passenger;
  vehicle: Vehicle;
  repName: string;
  note: string;
}

interface VehicleGeneralNoteItem {
  vehicle: Vehicle;
  repName: string;
  note: string;
  submittedAt?: string;
}

export function AdminAttendanceNotesSection({
  manifest,
  onLocateVehicle,
}: AdminAttendanceNotesSectionProps) {
  const [activeTab, setActiveTab] = useState<'sponsored' | 'unpaid' | 'absentees' | 'notes' | 'overview'>('sponsored');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Helper to copy text to clipboard with fallback
  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  }

  // Fast passenger lookup map
  const passengerMap = useMemo(() => {
    const map = new Map<string, Passenger>();
    for (const p of manifest.signups || []) {
      map.set(p.id, p);
    }
    return map;
  }, [manifest.signups]);

  // Aggregate Sponsored Riders across all vehicles
  const sponsoredList = useMemo<SponsoredRiderItem[]>(() => {
    const list: SponsoredRiderItem[] = [];
    const seen = new Set<string>();

    for (const v of manifest.vehicles || []) {
      const draft = v.draftState;
      const sIds = new Set<string>(draft?.sponsoredIds || []);
      const notesMap = draft?.notes || {};
      const repName = v.repName || v.submittedBy || '—';

      for (const riderId of v.riders || []) {
        const p = passengerMap.get(riderId);
        if (!p) continue;

        const isMarkedSponsored = Boolean(p.sponsored || sIds.has(p.id));
        if (isMarkedSponsored && !seen.has(p.id)) {
          seen.add(p.id);
          const isPresent = draft?.presentIds?.includes(p.id) || (v.submitted && p.present);
          const sponsorNote = notesMap[p.id] || p.sponsorNote || '';
          list.push({
            passenger: p,
            vehicle: v,
            sponsorNote,
            repName,
            isPresent: Boolean(isPresent),
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles, passengerMap]);

  // Aggregate Unpaid (Didn't Pay) Riders across all vehicles
  const unpaidList = useMemo<UnpaidRiderItem[]>(() => {
    const list: UnpaidRiderItem[] = [];
    const seen = new Set<string>();

    for (const v of manifest.vehicles || []) {
      const draft = v.draftState;
      const uIds = new Set<string>(draft?.unpaidIds || []);
      const notesMap = draft?.notes || {};
      const repName = v.repName || v.submittedBy || '—';

      for (const riderId of v.riders || []) {
        const p = passengerMap.get(riderId);
        if (!p) continue;

        const isMarkedUnpaid = Boolean(p.didNotPay || uIds.has(p.id));
        if (isMarkedUnpaid && !seen.has(p.id)) {
          seen.add(p.id);
          const isPresent = draft?.presentIds?.includes(p.id) || (v.submitted && p.present);
          const unpaidNote = notesMap[p.id] || p.unpaidNote || p.sponsorNote || '';
          list.push({
            passenger: p,
            vehicle: v,
            unpaidNote,
            repName,
            isPresent: Boolean(isPresent),
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles, passengerMap]);

  // Aggregate External Sponsees (cross-vehicle sponsorships recorded in the calculator)
  const externalSponseesList = useMemo(() => {
    const list: {
      id: string;
      sponseeName: string;
      sourceTaxiName: string;
      sourceRepName: string;
      targetTaxiName?: string;
      amount: number;
    }[] = [];

    for (const v of manifest.vehicles || []) {
      const ext = v.draftState?.externalSponsees || [];
      const repName = v.repName || v.submittedBy || '—';
      for (const item of ext) {
        if (item.sponseeName.trim()) {
          list.push({
            id: `${v.id}-${item.id}`,
            sponseeName: item.sponseeName.trim(),
            sourceTaxiName: v.name,
            sourceRepName: repName,
            targetTaxiName: item.taxiName || undefined,
            amount: item.amount || 20,
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles]);

  // Aggregate Absentees across all vehicles
  const absenteesList = useMemo<AbsentRiderItem[]>(() => {
    const list: AbsentRiderItem[] = [];
    const seen = new Set<string>();

    for (const v of manifest.vehicles || []) {
      const draft = v.draftState;
      const aIds = new Set<string>(draft?.absentIds || []);
      const pIds = new Set<string>(draft?.presentIds || []);
      const notesMap = draft?.notes || {};
      const repName = v.repName || v.submittedBy || '—';

      for (const riderId of v.riders || []) {
        const p = passengerMap.get(riderId);
        if (!p) continue;

        // Is marked absent in draft or submitted as not present
        const isAbsent = aIds.has(p.id) || (v.submitted && !p.present && !pIds.has(p.id));
        if (isAbsent && !seen.has(p.id)) {
          seen.add(p.id);
          list.push({
            passenger: p,
            vehicle: v,
            repName,
            note: notesMap[p.id] || p.sponsorNote || undefined,
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles, passengerMap]);

  // Aggregate Passenger Notes
  const passengerNotesList = useMemo<RiderNoteItem[]>(() => {
    const list: RiderNoteItem[] = [];
    const seen = new Set<string>();

    for (const v of manifest.vehicles || []) {
      const draft = v.draftState;
      const notesMap = draft?.notes || {};
      const repName = v.repName || v.submittedBy || '—';

      for (const riderId of v.riders || []) {
        const p = passengerMap.get(riderId);
        if (!p) continue;

        const note = (notesMap[p.id] || p.sponsorNote || '').trim();
        if (note && !seen.has(p.id)) {
          seen.add(p.id);
          list.push({
            passenger: p,
            vehicle: v,
            repName,
            note,
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles, passengerMap]);

  // Aggregate Vehicle General Notes
  const vehicleGeneralNotesList = useMemo<VehicleGeneralNoteItem[]>(() => {
    const list: VehicleGeneralNoteItem[] = [];

    for (const v of manifest.vehicles || []) {
      const note = (v.generalNotes || v.draftState?.generalNotes || '').trim();
      if (note) {
        list.push({
          vehicle: v,
          repName: v.repName || v.submittedBy || '—',
          note,
          submittedAt: v.submittedAt,
        });
      }
    }
    return list;
  }, [manifest.vehicles]);

  // Aggregate Manual Cancellations
  const manualCancellationsList = useMemo(() => {
    const list: {
      id: string;
      passengerName: string;
      structure?: string;
      amount: number;
      note?: string;
      vehicleName: string;
      repName: string;
    }[] = [];

    for (const v of manifest.vehicles || []) {
      const items = v.draftState?.manualCancellations || [];
      const repName = v.repName || v.submittedBy || '—';
      for (const m of items) {
        if (m.passengerName.trim()) {
          list.push({
            ...m,
            vehicleName: v.name,
            repName,
          });
        }
      }
    }
    return list;
  }, [manifest.vehicles]);

  const totalNotesCount = passengerNotesList.length + vehicleGeneralNotesList.length + manualCancellationsList.length;

  // Filtered queries
  const q = searchQuery.trim().toLowerCase();

  const filteredSponsored = useMemo(() => {
    if (!q) return sponsoredList;
    return sponsoredList.filter(
      (item) =>
        item.passenger.fullName.toLowerCase().includes(q) ||
        (item.passenger.structure || '').toLowerCase().includes(q) ||
        (item.passenger.stop || '').toLowerCase().includes(q) ||
        item.vehicle.name.toLowerCase().includes(q) ||
        item.sponsorNote.toLowerCase().includes(q) ||
        item.repName.toLowerCase().includes(q)
    );
  }, [sponsoredList, q]);

  const filteredUnpaid = useMemo(() => {
    if (!q) return unpaidList;
    return unpaidList.filter(
      (item) =>
        item.passenger.fullName.toLowerCase().includes(q) ||
        (item.passenger.structure || '').toLowerCase().includes(q) ||
        (item.passenger.stop || '').toLowerCase().includes(q) ||
        item.vehicle.name.toLowerCase().includes(q) ||
        item.unpaidNote.toLowerCase().includes(q) ||
        item.repName.toLowerCase().includes(q)
    );
  }, [unpaidList, q]);

  const filteredAbsentees = useMemo(() => {
    if (!q) return absenteesList;
    return absenteesList.filter(
      (item) =>
        item.passenger.fullName.toLowerCase().includes(q) ||
        (item.passenger.structure || '').toLowerCase().includes(q) ||
        (item.passenger.stop || '').toLowerCase().includes(q) ||
        item.vehicle.name.toLowerCase().includes(q) ||
        (item.note || '').toLowerCase().includes(q) ||
        item.repName.toLowerCase().includes(q)
    );
  }, [absenteesList, q]);

  const filteredPassengerNotes = useMemo(() => {
    if (!q) return passengerNotesList;
    return passengerNotesList.filter(
      (item) =>
        item.passenger.fullName.toLowerCase().includes(q) ||
        (item.passenger.structure || '').toLowerCase().includes(q) ||
        (item.passenger.stop || '').toLowerCase().includes(q) ||
        item.vehicle.name.toLowerCase().includes(q) ||
        item.note.toLowerCase().includes(q)
    );
  }, [passengerNotesList, q]);

  const filteredVehicleNotes = useMemo(() => {
    if (!q) return vehicleGeneralNotesList;
    return vehicleGeneralNotesList.filter(
      (item) =>
        item.vehicle.name.toLowerCase().includes(q) ||
        item.repName.toLowerCase().includes(q) ||
        item.note.toLowerCase().includes(q)
    );
  }, [vehicleGeneralNotesList, q]);

  // Generate Copy Text
  function generateSponsoredCopyText(): string {
    if (sponsoredList.length === 0 && externalSponseesList.length === 0) return 'No sponsored passengers recorded.';
    const lines: string[] = ['*SPONSORED PASSENGERS & PAYMENT NOTES*'];
    lines.push(`Total Sponsored: ${sponsoredList.length + externalSponseesList.length}`);
    lines.push('');

    if (sponsoredList.length > 0) {
      lines.push('--- Vehicle Sponsees ---');
      sponsoredList.forEach((s, idx) => {
        const noteStr = s.sponsorNote ? ` (Note: ${s.sponsorNote})` : ' (No sponsor note specified)';
        const structStr = s.passenger.structure ? ` [${s.passenger.structure}]` : '';
        lines.push(`${idx + 1}. ${s.passenger.fullName}${structStr} - ${s.vehicle.name} | Rep: ${s.repName}${noteStr}`);
      });
    }

    if (externalSponseesList.length > 0) {
      lines.push('');
      lines.push('--- Cross-Vehicle Sponsees (Paid in Cash) ---');
      externalSponseesList.forEach((ext, idx) => {
        const target = ext.targetTaxiName ? ` in ${ext.targetTaxiName}` : '';
        lines.push(`${idx + 1}. ${ext.sponseeName}${target} - R${ext.amount} paid in ${ext.sourceTaxiName} (Rep: ${ext.sourceRepName})`);
      });
    }
    return lines.join('\n');
  }

  function generateUnpaidCopyText(): string {
    if (unpaidList.length === 0) return 'No unpaid passengers recorded.';
    const lines: string[] = ["*UNPAID PASSENGERS (DIDN'T PAY FARE)*"];
    lines.push(`Total Unpaid: ${unpaidList.length}`);
    lines.push('');
    unpaidList.forEach((u, idx) => {
      const structStr = u.passenger.structure ? ` [${u.passenger.structure}]` : '';
      const stopStr = u.passenger.stop ? ` - ${u.passenger.stop}` : '';
      const noteStr = u.unpaidNote ? ` (Note: ${u.unpaidNote})` : '';
      lines.push(`${idx + 1}. ${u.passenger.fullName}${structStr}${stopStr} - ${u.vehicle.name} | Rep: ${u.repName}${noteStr}`);
    });
    return lines.join('\n');
  }

  function generateAbsentCopyText(): string {
    if (absenteesList.length === 0) return 'No absentees recorded.';
    const lines: string[] = ['*TRANSPORT ABSENTEES & CANCELLATIONS*'];
    lines.push(`Total Absent: ${absenteesList.length}`);
    lines.push('');
    absenteesList.forEach((a, idx) => {
      const structStr = a.passenger.structure ? ` [${a.passenger.structure}]` : '';
      const stopStr = a.passenger.stop ? ` - ${a.passenger.stop}` : '';
      const noteStr = a.note ? ` (Note: ${a.note})` : '';
      lines.push(`${idx + 1}. ${a.passenger.fullName}${structStr}${stopStr} - ${a.vehicle.name} | Rep: ${a.repName}${noteStr}`);
    });
    return lines.join('\n');
  }

  function generateAllNotesCopyText(): string {
    const lines: string[] = ['*DISPATCH & VEHICLE NOTES SUMMARY*'];
    lines.push('');

    if (vehicleGeneralNotesList.length > 0) {
      lines.push('--- Vehicle General Notes ---');
      vehicleGeneralNotesList.forEach((v, idx) => {
        lines.push(`${idx + 1}. ${v.vehicle.name} (Rep: ${v.repName}):`);
        lines.push(`   "${v.note}"`);
      });
      lines.push('');
    }

    if (passengerNotesList.length > 0) {
      lines.push('--- Passenger Notes ---');
      passengerNotesList.forEach((p, idx) => {
        const structStr = p.passenger.structure ? ` [${p.passenger.structure}]` : '';
        lines.push(`${idx + 1}. ${p.passenger.fullName}${structStr} (${p.vehicle.name}): "${p.note}"`);
      });
      lines.push('');
    }

    if (manualCancellationsList.length > 0) {
      lines.push('--- Cash Debt Notes ---');
      manualCancellationsList.forEach((m, idx) => {
        lines.push(`${idx + 1}. ${m.passengerName} (${m.structure || '—'}) in ${m.vehicleName}: R${m.amount} ${m.note ? `("${m.note}")` : ''}`);
      });
    }

    if (lines.length <= 2) return 'No notes recorded.';
    return lines.join('\n');
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
      {/* Header Banner */}
      <div className="border-b border-line bg-gradient-to-r from-card-2 via-card to-card-2 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crimson-500/15 text-crimson-400 border border-crimson-500/30">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-display text-base font-bold text-ink">
                  Live Attendance, Sponsored & Notes Dispatch Hub
                </h3>
                <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px] font-mono font-bold">
                  Admin Real-Time
                </span>
              </div>
              <p className="text-xs text-muted">
                Immediate visibility into who is sponsored, who didn't pay, vehicle & passenger notes, and recorded absentees.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="btn-ghost px-2.5 py-1.5 text-xs text-muted hover:text-ink flex items-center gap-1"
            >
              <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Quick Metrics Bar */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-line/60 text-xs">
          <button
            onClick={() => { setActiveTab('sponsored'); setIsExpanded(true); }}
            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all text-left ${
              activeTab === 'sponsored'
                ? 'border-amber-500/50 bg-amber-500/15 shadow-sm'
                : 'border-line/60 bg-bg/50 hover:bg-card-2'
            }`}
          >
            <div className="flex items-center gap-2">
              <HeartHandshake className="h-4 w-4 text-amber-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-muted">Sponsored</div>
                <div className="font-display text-base font-bold text-amber-300">
                  {sponsoredList.length + externalSponseesList.length}
                </div>
              </div>
            </div>
            <span className="badge bg-amber-500/20 text-amber-300 text-[10px]">View</span>
          </button>

          <button
            onClick={() => { setActiveTab('unpaid'); setIsExpanded(true); }}
            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all text-left ${
              activeTab === 'unpaid'
                ? 'border-crimson-500/50 bg-crimson-500/15 shadow-sm'
                : 'border-line/60 bg-bg/50 hover:bg-card-2'
            }`}
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-crimson-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-muted">Didn't Pay</div>
                <div className="font-display text-base font-bold text-crimson-300">
                  {unpaidList.length}
                </div>
              </div>
            </div>
            <span className="badge bg-crimson-500/20 text-crimson-300 text-[10px]">View</span>
          </button>

          <button
            onClick={() => { setActiveTab('absentees'); setIsExpanded(true); }}
            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all text-left ${
              activeTab === 'absentees'
                ? 'border-rose-500/50 bg-rose-500/15 shadow-sm'
                : 'border-line/60 bg-bg/50 hover:bg-card-2'
            }`}
          >
            <div className="flex items-center gap-2">
              <UserX className="h-4 w-4 text-rose-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-muted">Absentees</div>
                <div className="font-display text-base font-bold text-rose-300">
                  {absenteesList.length}
                </div>
              </div>
            </div>
            <span className="badge bg-rose-500/20 text-rose-300 text-[10px]">View</span>
          </button>

          <button
            onClick={() => { setActiveTab('notes'); setIsExpanded(true); }}
            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all text-left ${
              activeTab === 'notes'
                ? 'border-sky-500/50 bg-sky-500/15 shadow-sm'
                : 'border-line/60 bg-bg/50 hover:bg-card-2'
            }`}
          >
            <div className="flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-sky-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-muted">All Notes</div>
                <div className="font-display text-base font-bold text-sky-300">
                  {totalNotesCount}
                </div>
              </div>
            </div>
            <span className="badge bg-sky-500/20 text-sky-300 text-[10px]">View</span>
          </button>

          <button
            onClick={() => { setActiveTab('overview'); setIsExpanded(true); }}
            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all text-left ${
              activeTab === 'overview'
                ? 'border-emerald-500/50 bg-emerald-500/15 shadow-sm'
                : 'border-line/60 bg-bg/50 hover:bg-card-2'
            }`}
          >
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-emerald-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-muted">Fleet Matrix</div>
                <div className="font-display text-base font-bold text-emerald-300">
                  {manifest.vehicles.length} Veh
                </div>
              </div>
            </div>
            <span className="badge bg-emerald-500/20 text-emerald-300 text-[10px]">View</span>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-4 space-y-4 animate-fade-in">
          {/* Sub-Tabs & Actions Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line/60 pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTab('sponsored')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === 'sponsored'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                <HeartHandshake className="h-3.5 w-3.5" />
                <span>Sponsored ({sponsoredList.length + externalSponseesList.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('unpaid')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === 'unpaid'
                    ? 'bg-crimson-600 text-white shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Didn't Pay ({unpaidList.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('absentees')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === 'absentees'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                <UserX className="h-3.5 w-3.5" />
                <span>Absentees ({absenteesList.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('notes')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === 'notes'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Additional Notes ({totalNotesCount})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('overview')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  activeTab === 'overview'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                <FileText className="h-3.5 w-3.5" />
                <span>Fleet Attendance Matrix</span>
              </button>
            </div>

            {/* Search Input & Copy Buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative min-w-[180px] flex-1 sm:flex-initial">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter name, note, taxi..."
                  className="input-field py-1 pl-8 text-xs w-full bg-card-2"
                />
              </div>

              {activeTab === 'sponsored' && (
                <button
                  onClick={() => copyToClipboard(generateSponsoredCopyText(), 'sponsored')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-500/40 bg-amber-500/15 text-xs font-bold text-amber-300 hover:bg-amber-500/25 transition-all shadow-xs"
                  title="Copy formatted sponsored list for WhatsApp"
                >
                  {copiedKey === 'sponsored' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedKey === 'sponsored' ? 'Copied!' : 'Copy Sponsored'}</span>
                </button>
              )}

              {activeTab === 'unpaid' && (
                <button
                  onClick={() => copyToClipboard(generateUnpaidCopyText(), 'unpaid')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-crimson-500/40 bg-crimson-500/15 text-xs font-bold text-crimson-300 hover:bg-crimson-500/25 transition-all shadow-xs"
                  title="Copy formatted unpaid list for records"
                >
                  {copiedKey === 'unpaid' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedKey === 'unpaid' ? 'Copied!' : 'Copy Unpaid'}</span>
                </button>
              )}

              {activeTab === 'absentees' && (
                <button
                  onClick={() => copyToClipboard(generateAbsentCopyText(), 'absentees')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-500/40 bg-rose-500/15 text-xs font-bold text-rose-300 hover:bg-rose-500/25 transition-all shadow-xs"
                  title="Copy formatted absentee list for WhatsApp"
                >
                  {copiedKey === 'absentees' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedKey === 'absentees' ? 'Copied!' : 'Copy Absentees'}</span>
                </button>
              )}

              {activeTab === 'notes' && (
                <button
                  onClick={() => copyToClipboard(generateAllNotesCopyText(), 'notes')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sky-500/40 bg-sky-500/15 text-xs font-bold text-sky-300 hover:bg-sky-500/25 transition-all shadow-xs"
                  title="Copy all notes for leadership"
                >
                  {copiedKey === 'notes' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedKey === 'notes' ? 'Copied!' : 'Copy Notes'}</span>
                </button>
              )}
            </div>
          </div>

          {/* TAB 1: SPONSORED PASSENGERS & WHO IS PAYING */}
          {activeTab === 'sponsored' && (
            <div className="space-y-4">
              {filteredSponsored.length === 0 && externalSponseesList.length === 0 ? (
                <div className="rounded-xl border border-line bg-card-2/40 py-8 text-center">
                  <HeartHandshake className="mx-auto h-8 w-8 text-muted/40" />
                  <p className="mt-2 text-xs font-medium text-muted">No sponsored passengers found.</p>
                  <p className="text-[11px] text-muted">
                    When transport reps mark a passenger as Sponsored, the person and sponsor note appear here in real-time.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredSponsored.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-muted font-medium">
                        <span>Vehicles Sponsee Roster ({filteredSponsored.length})</span>
                        <span className="text-[11px]">Includes note of who is paying</span>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        {filteredSponsored.map(({ passenger: p, vehicle: v, sponsorNote, repName, isPresent }) => {
                          const statusBadge = getPassengerStatusBadge(p);
                          return (
                            <div
                              key={p.id}
                              className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 hover:border-amber-500/50 transition-all shadow-xs"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-bold text-xs text-ink">{p.fullName}</span>
                                    {p.structure && (
                                      <span className="badge bg-amber-500/20 text-amber-300 font-mono text-[10px]">
                                        {p.structure}
                                      </span>
                                    )}
                                    {statusBadge && (
                                      <span className={`badge text-[10px] ${statusBadge.colorClass}`}>
                                        {statusBadge.label}
                                      </span>
                                    )}
                                    <span className={`badge text-[10px] ${
                                      isPresent ? 'bg-success/20 text-success-light' : 'bg-crimson-500/20 text-crimson-300'
                                    }`}>
                                      {isPresent ? '✓ Present' : '✗ Absent'}
                                    </span>
                                  </div>

                                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted flex-wrap">
                                    <span className="flex items-center gap-0.5">
                                      <MapPin className="h-3 w-3 text-muted" />
                                      {p.stop}
                                    </span>
                                    <span>·</span>
                                    <span className="font-semibold text-sky-300">
                                      {v.type === 'Bus' ? '🚌' : '🚕'} {v.name}
                                    </span>
                                    <span>·</span>
                                    <span>Rep: <strong className="text-ink">{repName}</strong></span>
                                  </div>
                                </div>

                                {onLocateVehicle && (
                                  <button
                                    type="button"
                                    onClick={() => onLocateVehicle(v.id)}
                                    className="rounded p-1 text-muted hover:text-ink hover:bg-card-2 text-[11px]"
                                    title="Locate vehicle card"
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>

                              {/* Sponsor Note / Who is paying */}
                              <div className="mt-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
                                <div className="flex items-center gap-1 font-bold text-[11px] text-amber-300 uppercase tracking-wider">
                                  <Coins className="h-3 w-3" />
                                  <span>Who is Paying / Sponsor Note:</span>
                                </div>
                                <p className="mt-0.5 text-xs font-medium text-ink">
                                  {sponsorNote || (
                                    <span className="italic text-muted font-normal">
                                      No detailed note attached by rep.
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* External Sponsees */}
                  {externalSponseesList.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-line/60 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300 uppercase tracking-wider">
                        <Coins className="h-3.5 w-3.5" />
                        <span>Cross-Vehicle Sponsees ({externalSponseesList.length})</span>
                      </div>
                      <p className="text-[11px] text-muted">
                        Passengers who rode in a different taxi where their fare was paid for in cash by someone in another vehicle:
                      </p>

                      <div className="grid gap-2 sm:grid-cols-2">
                        {externalSponseesList.map((ext) => (
                          <div
                            key={ext.id}
                            className="rounded-xl border border-line bg-card-2/70 p-3 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-ink">{ext.sponseeName}</span>
                              <span className="badge bg-emerald-500/15 text-emerald-300 font-bold">
                                R{ext.amount} Paid
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-muted">
                              {ext.targetTaxiName ? `Riding in: ${ext.targetTaxiName} · ` : ''}
                              Paid in: <strong className="text-sky-300">{ext.sourceTaxiName}</strong> (Rep: {ext.sourceRepName})
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: DIDN'T PAY PASSENGERS */}
          {activeTab === 'unpaid' && (
            <div className="space-y-4">
              {filteredUnpaid.length === 0 ? (
                <div className="rounded-xl border border-line bg-card-2/40 py-8 text-center">
                  <AlertCircle className="mx-auto h-8 w-8 text-muted/40" />
                  <p className="mt-2 text-xs font-medium text-muted">No unpaid passengers flagged.</p>
                  <p className="text-[11px] text-muted">
                    When transport reps use the "Didn't Pay" button to flag passengers who boarded without paying, they appear here in real-time.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted font-medium">
                    <span>Unpaid Passengers ({filteredUnpaid.length})</span>
                    <span className="text-[11px] text-crimson-300 font-semibold">Flagged for Follow-up</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    {filteredUnpaid.map(({ passenger: p, vehicle: v, unpaidNote, repName, isPresent }) => {
                      const statusBadge = getPassengerStatusBadge(p);
                      return (
                        <div
                          key={p.id}
                          className="rounded-xl border border-crimson-500/30 bg-crimson-500/5 p-3 hover:border-crimson-500/50 transition-all shadow-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-xs text-ink">{p.fullName}</span>
                                {p.structure && (
                                  <span className="badge bg-crimson-500/20 text-crimson-300 font-mono text-[10px]">
                                    {p.structure}
                                  </span>
                                )}
                                {statusBadge && (
                                  <span className={`badge text-[10px] ${statusBadge.colorClass}`}>
                                    {statusBadge.label}
                                  </span>
                                )}
                                <span className="badge bg-crimson-500/25 text-crimson-300 text-[10px] font-bold border border-crimson-500/40">
                                  ⚠️ Didn't Pay
                                </span>
                                <span className={`badge text-[10px] ${
                                  isPresent ? 'bg-success/20 text-success-light' : 'bg-muted/20 text-muted'
                                }`}>
                                  {isPresent ? '✓ Present' : '✗ Absent'}
                                </span>
                              </div>

                              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted flex-wrap">
                                <span className="flex items-center gap-0.5">
                                  <MapPin className="h-3 w-3 text-muted" />
                                  {p.stop}
                                </span>
                                <span>·</span>
                                <span className="font-semibold text-sky-300">
                                  {v.type === 'Bus' ? '🚌' : '🚕'} {v.name}
                                </span>
                                <span>·</span>
                                <span>Rep: <strong className="text-ink">{repName}</strong></span>
                              </div>
                            </div>

                            {onLocateVehicle && (
                              <button
                                type="button"
                                onClick={() => onLocateVehicle(v.id)}
                                className="rounded p-1 text-muted hover:text-ink hover:bg-card-2 text-[11px]"
                                title="Locate vehicle card"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>

                          {/* Unpaid Note / Reason */}
                          <div className="mt-2.5 rounded-lg border border-crimson-500/25 bg-crimson-500/10 px-2.5 py-1.5 text-xs text-crimson-200">
                            <div className="flex items-center gap-1 font-bold text-[11px] text-crimson-300 uppercase tracking-wider">
                              <StickyNote className="h-3 w-3" />
                              <span>Rep Note / Reason:</span>
                            </div>
                            <p className="mt-0.5 text-xs font-medium text-ink">
                              {unpaidNote || (
                                <span className="italic text-muted font-normal">
                                  No note provided by rep.
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: ABSENTEES & CANCELLATIONS */}
          {activeTab === 'absentees' && (
            <div className="space-y-3">
              {filteredAbsentees.length === 0 ? (
                <div className="rounded-xl border border-line bg-card-2/40 py-8 text-center">
                  <UserX className="mx-auto h-8 w-8 text-muted/40" />
                  <p className="mt-2 text-xs font-medium text-muted">No absentees recorded.</p>
                  <p className="text-[11px] text-muted">
                    When transport reps mark passengers absent on their portal, they will automatically appear here with their cancellation records.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted font-medium">
                    <span>Recorded Absentees ({filteredAbsentees.length})</span>
                    <span className="text-[11px] text-crimson-300 font-semibold">Subject to CRC Cancellation Policy</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    {filteredAbsentees.map(({ passenger: p, vehicle: v, repName, note }) => {
                      const statusBadge = getPassengerStatusBadge(p);
                      return (
                        <div
                          key={p.id}
                          className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 hover:border-rose-500/50 transition-all shadow-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-xs text-ink">{p.fullName}</span>
                                {p.structure && (
                                  <span className="badge bg-rose-500/20 text-rose-300 font-mono text-[10px]">
                                    {p.structure}
                                  </span>
                                )}
                                {statusBadge && (
                                  <span className={`badge text-[10px] ${statusBadge.colorClass}`}>
                                    {statusBadge.label}
                                  </span>
                                )}
                                <span className="badge bg-rose-500/25 text-rose-300 text-[10px] font-bold border border-rose-500/40">
                                  Absent
                                </span>
                              </div>

                              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted flex-wrap">
                                <span className="flex items-center gap-0.5">
                                  <MapPin className="h-3 w-3 text-muted" />
                                  {p.stop}
                                </span>
                                <span>·</span>
                                <span className="font-semibold text-sky-300">
                                  {v.type === 'Bus' ? '🚌' : '🚕'} {v.name}
                                </span>
                                <span>·</span>
                                <span>Rep: <strong className="text-ink">{repName}</strong></span>
                              </div>
                            </div>

                            {onLocateVehicle && (
                              <button
                                type="button"
                                onClick={() => onLocateVehicle(v.id)}
                                className="rounded p-1 text-muted hover:text-ink hover:bg-card-2 text-[11px]"
                                title="Locate vehicle card"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>

                          {note && (
                            <div className="mt-2 rounded bg-card-2/80 px-2 py-1 text-[11px] text-muted">
                              <span className="font-semibold text-ink">Rep Note:</span> {note}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: ADDITIONAL NOTES & FEEDBACK */}
          {activeTab === 'notes' && (
            <div className="space-y-4">
              {totalNotesCount === 0 ? (
                <div className="rounded-xl border border-line bg-card-2/40 py-8 text-center">
                  <StickyNote className="mx-auto h-8 w-8 text-muted/40" />
                  <p className="mt-2 text-xs font-medium text-muted">No additional notes recorded yet.</p>
                  <p className="text-[11px] text-muted">
                    Notes submitted by transport reps (e.g. drop-off changes, passenger queries, routing instructions) appear here.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Vehicle General Notes */}
                  {filteredVehicleNotes.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-sky-300 uppercase tracking-wider">
                        <StickyNote className="h-3.5 w-3.5" />
                        <span>Vehicle Dispatch Notes from Reps ({filteredVehicleNotes.length})</span>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        {filteredVehicleNotes.map(({ vehicle: v, repName, note, submittedAt }) => (
                          <div
                            key={v.id}
                            className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs shadow-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-ink">
                                {v.type === 'Bus' ? '🚌' : '🚕'} {v.name}
                              </span>
                              <span className="text-[11px] text-muted">
                                Rep: <strong className="text-sky-300">{repName}</strong>
                              </span>
                            </div>

                            <div className="mt-2 rounded-lg bg-card-2 p-2.5 text-xs font-medium text-ink border border-line/60">
                              "{note}"
                            </div>

                            {submittedAt && (
                              <div className="mt-1.5 text-[10px] text-muted text-right">
                                Submitted {new Date(submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Passenger Specific Notes */}
                  {filteredPassengerNotes.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-line/60">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-ink uppercase tracking-wider">
                        <MessageSquare className="h-3.5 w-3.5 text-muted" />
                        <span>Individual Passenger Notes ({filteredPassengerNotes.length})</span>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        {filteredPassengerNotes.map(({ passenger: p, vehicle: v, repName, note }) => (
                          <div
                            key={p.id}
                            className="rounded-xl border border-line bg-card p-3 text-xs shadow-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-ink">{p.fullName}</span>
                              <span className="font-mono text-[10px] text-muted">{p.structure || '—'}</span>
                            </div>
                            <div className="text-[11px] text-muted mt-0.5">
                              {v.name} · Rep: {repName}
                            </div>
                            <div className="mt-2 rounded bg-card-2 px-2.5 py-1.5 text-xs text-sky-200 border border-sky-500/20">
                              <span className="font-semibold text-sky-400">Note: </span>
                              {note}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Manual Cancellations / Paid Debt Notes */}
                  {manualCancellationsList.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-line/60">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300 uppercase tracking-wider">
                        <Coins className="h-3.5 w-3.5" />
                        <span>Cash Cancellation Debt Receipts ({manualCancellationsList.length})</span>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        {manualCancellationsList.map((m) => (
                          <div
                            key={m.id}
                            className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-ink">{m.passengerName}</span>
                              <span className="badge bg-emerald-500/20 text-emerald-300 font-bold">
                                R{m.amount} Paid
                              </span>
                            </div>
                            <div className="text-[11px] text-muted mt-0.5">
                              {m.vehicleName} · Rep: {m.repName} {m.structure ? `(${m.structure})` : ''}
                            </div>
                            {m.note && (
                              <div className="mt-1.5 text-[11px] text-muted">
                                Note: {m.note}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: FLEET ATTENDANCE MATRIX */}
          {activeTab === 'overview' && (
            <div className="space-y-3">
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
                      <th className="px-3 py-2.5 text-center text-amber-300">Sponsored</th>
                      <th className="px-3 py-2.5 text-center text-crimson-400">Didn't Pay</th>
                      <th className="px-3 py-2.5">Notes</th>
                      <th className="px-3 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {sortVehiclesNatural(manifest.vehicles || []).map((v) => {
                      const riders = (v.riders || []).map((id) => passengerMap.get(id)).filter(Boolean) as Passenger[];
                      const draft = v.draftState;
                      const pIds = new Set<string>(draft?.presentIds || []);
                      const aIds = new Set<string>(draft?.absentIds || []);
                      const sIds = new Set<string>(draft?.sponsoredIds || []);
                      const uIds = new Set<string>(draft?.unpaidIds || []);

                      const presentCount = v.submitted
                        ? riders.filter((r) => r.present).length
                        : riders.filter((r) => pIds.has(r.id)).length;

                      const absentCount = v.submitted
                        ? riders.filter((r) => !r.present).length
                        : riders.filter((r) => aIds.has(r.id)).length;

                      const sponsoredCount = riders.filter((r) => r.sponsored || sIds.has(r.id)).length;
                      const unpaidCount = riders.filter((r) => r.didNotPay || uIds.has(r.id)).length;
                      const repName = v.repName || v.submittedBy || '—';
                      const notesCount = (draft?.notes ? Object.keys(draft.notes).length : 0) + (v.generalNotes ? 1 : 0);

                      return (
                        <tr key={v.id} className="hover:bg-card-2/40 transition-colors">
                          <td className="px-3 py-2.5 font-bold text-ink whitespace-nowrap">
                            {v.type === 'Bus' ? '🚌' : '🚕'} {v.name}
                          </td>
                          <td className="px-3 py-2.5 text-muted font-medium whitespace-nowrap">
                            {repName}
                          </td>
                          <td className="px-3 py-2.5 text-center whitespace-nowrap">
                            {v.submitted ? (
                              <span className="badge bg-success/20 text-success-light text-[10px] font-bold border border-success/30">
                                Submitted
                              </span>
                            ) : draft && (draft.presentIds?.length || draft.absentIds?.length) ? (
                              <span className="badge bg-amber-500/15 text-amber-300 text-[10px] font-semibold border border-amber-500/30">
                                Draft in Progress
                              </span>
                            ) : (
                              <span className="badge bg-card-2 text-muted text-[10px]">
                                Unmarked
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center font-semibold text-ink">
                            {riders.length}
                          </td>
                          <td className="px-3 py-2.5 text-center font-bold text-success-light">
                            {presentCount}
                          </td>
                          <td className="px-3 py-2.5 text-center font-bold text-crimson-300">
                            {absentCount}
                          </td>
                          <td className="px-3 py-2.5 text-center font-bold text-amber-300">
                            {sponsoredCount}
                          </td>
                          <td className="px-3 py-2.5 text-center font-bold text-crimson-400">
                            {unpaidCount}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-muted max-w-[200px] truncate">
                            {v.generalNotes ? (
                              <span className="text-sky-300 font-medium truncate" title={v.generalNotes}>
                                "{v.generalNotes}"
                              </span>
                            ) : notesCount > 0 ? (
                              <span className="text-muted">{notesCount} rider note(s)</span>
                            ) : (
                              <span className="text-muted/50">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {onLocateVehicle && (
                              <button
                                type="button"
                                onClick={() => onLocateVehicle(v.id)}
                                className="btn-ghost p-1 text-muted hover:text-ink text-[11px]"
                                title="Locate Vehicle"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
