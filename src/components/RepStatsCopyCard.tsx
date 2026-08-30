import { useState, useMemo } from 'react';
import {
  Copy, Check, Users, Sparkles, HeartHandshake, UserX,
  FileText, ChevronDown, ChevronUp, AlertCircle
} from 'lucide-react';
import type { Passenger } from '@/lib/types';

interface RepStatsCopyCardProps {
  riders: Passenger[];
  presentIds: Set<string>;
  absentIds: Set<string>;
  sponsoredIds: Set<string>;
  unpaidIds?: Set<string>;
  notes?: Record<string, string>;
  vehicleName: string;
  repName: string;
  isSubmitted?: boolean;
}

/**
 * Checks if a passenger's type, structure, category, ministry, notes, or name suggest they are a First Time Visitor (FTV)
 */
function isAutoFirstTimeVisitor(passenger: Passenger, riderNote?: string): boolean {
  if (passenger.memberType === 'FTV') {
    return true;
  }
  const s = (passenger.structure || '').toUpperCase();
  const m = (passenger.ministry || '').toUpperCase();
  const cat = (passenger.category || '').toUpperCase();
  const n = (riderNote || '').toUpperCase();
  const name = (passenger.fullName || '').toUpperCase();
  
  if (s.includes('FTV') || s.includes('VISITOR') || s.includes('FIRST TIME') || s.includes('GUEST') || s.includes('NEW')) {
    return true;
  }
  if (name.includes('FTV') || name.includes('FIRST TIME') || name.includes('VISITOR')) {
    return true;
  }
  if (m.includes('FTV') || m.includes('VISITOR') || m.includes('FIRST TIME') || m.includes('GUEST')) {
    return true;
  }
  if (cat.includes('FTV') || cat.includes('VISITOR') || cat.includes('FIRST TIME')) {
    return true;
  }
  if (n.includes('FTV') || n.includes('VISITOR') || n.includes('FIRST TIME') || n.includes('GUEST')) {
    return true;
  }
  return false;
}

/**
 * Formats a single passenger for the CRC stats roster: "Full Name Structure"
 * Example: "Thabo Mokoena S3", "Sarah Dlamini S2"
 */
function formatPassengerStat(p: Passenger): string {
  const name = p.fullName.trim();
  const struct = (p.structure || '').trim();
  return struct ? `${name} ${struct}` : name;
}

export function RepStatsCopyCard({
  riders,
  presentIds,
  absentIds,
  sponsoredIds,
  unpaidIds = new Set(),
  notes = {},
  vehicleName,
  repName,
  isSubmitted = false,
}: RepStatsCopyCardProps) {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [manualFtvIds, setManualFtvIds] = useState<Set<string>>(new Set());
  const [formatStyle, setFormatStyle] = useState<'comma' | 'newline'>('comma');

  // Copy helper with visual feedback
  async function copyToClipboard(text: string, sectionKey: string) {
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
    setCopiedSection(sectionKey);
    setTimeout(() => setCopiedSection(null), 2500);
  }

  // 1. Present members and visitors
  const presentPassengers = useMemo(() => {
    return riders.filter((r) => presentIds.has(r.id));
  }, [riders, presentIds]);

  // 2. First-time visitors (present riders who match auto-check or manual toggle)
  const ftvPassengers = useMemo(() => {
    return riders.filter(
      (r) => presentIds.has(r.id) && (isAutoFirstTimeVisitor(r, notes[r.id]) || manualFtvIds.has(r.id))
    );
  }, [riders, presentIds, manualFtvIds, notes]);

  // 3. Sponsorships (sponsored riders)
  const sponsoredPassengers = useMemo(() => {
    return riders.filter((r) => sponsoredIds.has(r.id));
  }, [riders, sponsoredIds]);

  // 4. Unpaid riders (didn't pay fare)
  const unpaidPassengers = useMemo(() => {
    return riders.filter((r) => unpaidIds.has(r.id));
  }, [riders, unpaidIds]);

  // 5. Cancellations (absentees)
  const absenteePassengers = useMemo(() => {
    return riders.filter((r) => absentIds.has(r.id));
  }, [riders, absentIds]);

  function formatList(passengers: Passenger[], delimiter: 'comma' | 'newline' = formatStyle): string {
    if (passengers.length === 0) return '';
    const formatted = passengers.map(formatPassengerStat);
    return delimiter === 'comma' ? formatted.join(', ') : formatted.join('\n');
  }

  const presentText = formatList(presentPassengers);
  const ftvText = formatList(ftvPassengers);
  const sponsoredText = formatList(sponsoredPassengers);
  const unpaidText = formatList(unpaidPassengers);
  const absenteeText = formatList(absenteePassengers);

  // Full unified stats template for pasting into WhatsApp / summaries
  const allStatsTemplate = useMemo(() => {
    const lines: string[] = [];
    lines.push(`*${vehicleName.toUpperCase()} — TRANSPORT STATS*`);
    if (repName.trim()) lines.push(`Rep: ${repName.trim()}`);
    lines.push('');

    lines.push('*List of present members and visitors:*');
    lines.push(presentText || 'None');
    lines.push('');

    lines.push('*List of first time visitors:*');
    lines.push(ftvText || 'None');
    lines.push('');

    lines.push('*List of sponsorships:*');
    lines.push(sponsoredText || 'None');
    lines.push('');

    lines.push('*List of unpaid fares (Didn\'t pay):*');
    lines.push(unpaidText || 'None');
    lines.push('');

    lines.push('*List of cancellations:*');
    lines.push(absenteeText || 'None');

    return lines.join('\n');
  }, [vehicleName, repName, presentText, ftvText, sponsoredText, unpaidText, absenteeText]);

  function toggleManualFtv(passengerId: string) {
    setManualFtvIds((prev) => {
      const next = new Set(prev);
      if (next.has(passengerId)) next.delete(passengerId);
      else next.add(passengerId);
      return next;
    });
  }

  return (
    <div className="card overflow-hidden border-crimson-500/30 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-left"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-crimson-500/15 text-crimson-400">
            <FileText className="h-4 w-4" />
          </div>
          <div>
            <h3 className="font-display text-sm font-bold text-ink flex items-center gap-1.5 flex-wrap">
              Copy Stats for Stats Link
              <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px]">
                {presentPassengers.length} Present · {absenteePassengers.length} Absent
              </span>
              {isSubmitted && (
                <span className="badge bg-success/15 text-success-light text-[10px]">
                  Submitted
                </span>
              )}
            </h3>
            <p className="text-[11px] text-muted">
              Copy individual lists formatted as <span className="font-mono text-crimson-300 font-semibold">Name Structure</span> (e.g. Person A S3)
            </p>
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => copyToClipboard(allStatsTemplate, 'all')}
            className="btn-crimson py-1 px-2.5 text-xs flex items-center gap-1 shadow-sm whitespace-nowrap"
            title="Copy all 4 lists in a formatted summary"
          >
            {copiedSection === 'all' ? (
              <>
                <Check className="h-3.5 w-3.5 text-white" />
                <span>Copied All!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy All</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded p-1 text-muted hover:bg-card-2 hover:text-ink"
          >
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-4 pt-4 animate-fade-in">
          {/* Format style toggle */}
          <div className="flex items-center justify-between text-xs border-b border-line/60 pb-2.5">
            <span className="text-muted text-[11px]">List delimiter format:</span>
            <div className="inline-flex rounded-lg border border-line bg-card-2 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setFormatStyle('comma')}
                className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                  formatStyle === 'comma'
                    ? 'bg-crimson-600 text-white font-bold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Comma separated (, )
              </button>
              <button
                type="button"
                onClick={() => setFormatStyle('newline')}
                className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                  formatStyle === 'newline'
                    ? 'bg-crimson-600 text-white font-bold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                New line per person
              </button>
            </div>
          </div>

          {/* 1. Present members and visitors */}
          <div className="rounded-xl border border-success/30 bg-success/5 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <Users className="h-4 w-4 text-success-light" />
                <span className="text-xs font-bold uppercase tracking-wide text-success-light">
                  List of Present Members & Visitors ({presentPassengers.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(presentText || 'None', 'present')}
                disabled={presentPassengers.length === 0}
                className="btn-ghost py-1 px-2.5 text-xs flex items-center gap-1 bg-success/15 text-success-light border border-success/30 hover:bg-success/25 disabled:opacity-40"
              >
                {copiedSection === 'present' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy Present List</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-black/40 p-2.5 font-mono text-xs text-ink/90 border border-line min-h-[38px] select-all break-words leading-relaxed">
              {presentText ? presentText : <span className="italic text-muted">No passengers marked present yet</span>}
            </div>
          </div>

          {/* 2. First time visitors */}
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-bold uppercase tracking-wide text-amber-300">
                  List of First Time Visitors ({ftvPassengers.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(ftvText || 'None', 'ftv')}
                disabled={ftvPassengers.length === 0}
                className="btn-ghost py-1 px-2.5 text-xs flex items-center gap-1 bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40"
              >
                {copiedSection === 'ftv' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy FTV List</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-black/40 p-2.5 font-mono text-xs text-ink/90 border border-line min-h-[38px] select-all break-words leading-relaxed">
              {ftvText ? ftvText : <span className="italic text-muted">None (or select below if someone is visiting)</span>}
            </div>

            {/* Quick FTV selector for present riders */}
            {presentPassengers.length > 0 && (
              <div className="mt-2.5 pt-2 border-t border-amber-500/20">
                <div className="text-[11px] font-semibold text-muted mb-1.5">
                  Click any present passenger below to tag as First Time Visitor:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {presentPassengers.map((p) => {
                    const isFtv = isAutoFirstTimeVisitor(p) || manualFtvIds.has(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleManualFtv(p.id)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                          isFtv
                            ? 'bg-amber-500/25 text-amber-200 border border-amber-500/50 font-bold'
                            : 'bg-card-2 border border-line text-muted hover:text-ink'
                        }`}
                      >
                        <span>{isFtv ? '★ FTV:' : '+'}</span>
                        <span>{p.fullName}</span>
                        {p.structure && <span className="opacity-75">({p.structure})</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 3. List of sponsorships */}
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <HeartHandshake className="h-4 w-4 text-sky-400" />
                <span className="text-xs font-bold uppercase tracking-wide text-sky-300">
                  List of Sponsorships ({sponsoredPassengers.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(sponsoredText || 'None', 'sponsored')}
                disabled={sponsoredPassengers.length === 0}
                className="btn-ghost py-1 px-2.5 text-xs flex items-center gap-1 bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 disabled:opacity-40"
              >
                {copiedSection === 'sponsored' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy Sponsorships</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-black/40 p-2.5 font-mono text-xs text-ink/90 border border-line min-h-[38px] select-all break-words leading-relaxed">
              {sponsoredText ? sponsoredText : <span className="italic text-muted">None</span>}
            </div>
          </div>

          {/* 4. List of unpaid fares (Didn't Pay) */}
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4 text-rose-400" />
                <span className="text-xs font-bold uppercase tracking-wide text-rose-300">
                  List of Unpaid Fares / Didn't Pay ({unpaidPassengers.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(unpaidText || 'None', 'unpaid')}
                disabled={unpaidPassengers.length === 0}
                className="btn-ghost py-1 px-2.5 text-xs flex items-center gap-1 bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 disabled:opacity-40"
              >
                {copiedSection === 'unpaid' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy Unpaid List</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-black/40 p-2.5 font-mono text-xs text-ink/90 border border-line min-h-[38px] select-all break-words leading-relaxed">
              {unpaidText ? unpaidText : <span className="italic text-muted">None</span>}
            </div>
          </div>

          {/* 5. List of cancellations (absentees) */}
          <div className="rounded-xl border border-crimson-500/30 bg-crimson-500/5 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <UserX className="h-4 w-4 text-crimson-400" />
                <span className="text-xs font-bold uppercase tracking-wide text-crimson-300">
                  List of Cancellations / Absentees ({absenteePassengers.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(absenteeText || 'None', 'absentees')}
                disabled={absenteePassengers.length === 0}
                className="btn-ghost py-1 px-2.5 text-xs flex items-center gap-1 bg-crimson-500/15 text-crimson-300 border border-crimson-500/30 hover:bg-crimson-500/25 disabled:opacity-40"
              >
                {copiedSection === 'absentees' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy Cancellations</span>
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg bg-black/40 p-2.5 font-mono text-xs text-ink/90 border border-line min-h-[38px] select-all break-words leading-relaxed">
              {absenteeText ? absenteeText : <span className="italic text-muted">None</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
