import { useState, useEffect, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, AlertTriangle, CheckCircle2, Copy, Download, Plus, Trash2,
  Clock, ArrowUp, ArrowDown, FileSpreadsheet, Loader2, Sparkles,
  ChevronDown, ChevronRight, Check, ShieldAlert, Save, X, Pencil,
} from 'lucide-react';
import type { Passenger, Vehicle, Manifest } from '@/lib/types';
import { isDreamWeekDate, DREAMWEEK_FARE } from '@/lib/types';
import { prettyDate, shortDate } from '@/lib/dates';
import { naturalCompare } from '@/lib/sort';
import {
  parseRehearsalSheet,
  formatRehearsalWhatsAppManifest,
  autoSuggestRehearsalAllocation,
  saveRehearsalTemplate,
  loadRehearsalTemplate,
  CANONICAL_REHEARSAL_STOPS,
  type ParsedRehearsalRecord,
  type RehearsalImportSummary,
  type RehearsalLegs,
} from '@/lib/rehearsal';
import { downloadRehearsalManifestPdf } from '@/lib/pdfExport';

interface Props {
  date: string;
  onDateChange: (date: string) => void;
  manifest: Manifest | null;
  onSaveManifest: (manifest: Manifest) => Promise<void>;
}

export function ThursdayRehearsalSetup({
  date,
  onDateChange,
  manifest,
  onSaveManifest,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [rawWorkbookBuffer, setRawWorkbookBuffer] = useState<ArrayBuffer | null>(null);
  const [availableDatesInFile, setAvailableDatesInFile] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<RehearsalImportSummary | null>(null);

  // Excluded lists
  const [intercessionList, setIntercessionList] = useState<ParsedRehearsalRecord[]>([]);
  const [privateList, setPrivateList] = useState<ParsedRehearsalRecord[]>([]);
  const [showIntercessionSection, setShowIntercessionSection] = useState(false);
  const [showPrivateSection, setShowPrivateSection] = useState(false);

  // Active working vehicles & passengers
  const [passengers, setPassengers] = useState<Passenger[]>(() => {
    return Array.isArray(manifest?.signups) ? manifest!.signups : [];
  });
  const [vehicles, setVehicles] = useState<Vehicle[]>(() => {
    return Array.isArray(manifest?.vehicles) ? manifest!.vehicles : [];
  });

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState(false);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);

  // Manual passenger add/edit modal
  const [editPassenger, setEditPassenger] = useState<Passenger | null>(null);
  const [editName, setEditName] = useState('');
  const [editStop, setEditStop] = useState('Braam');
  const [editLegs, setEditLegs] = useState<RehearsalLegs>('both');
  const [editStructure, setEditStructure] = useState('S1');
  const [showAddModal, setShowAddModal] = useState(false);

  // Sync with prop manifest if it updates externally
  useEffect(() => {
    if (manifest && manifest.date.includes(date)) {
      if (manifest.signups && manifest.signups.length > 0) {
        setPassengers(manifest.signups);
      }
      if (manifest.vehicles && manifest.vehicles.length > 0) {
        setVehicles(manifest.vehicles);
      }
    }
  }, [manifest, date]);

  // DreamWeek check
  const isDW = isDreamWeekDate(date);

  // Parse Excel file
  async function handleFileUpload(file: File) {
    setParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      setRawWorkbookBuffer(buffer);
      processWorkbook(buffer, date);
    } catch (err) {
      console.error('Failed to parse workbook:', err);
    } finally {
      setParsing(false);
    }
  }

  function processWorkbook(buffer: ArrayBuffer, targetDate: string) {
    const wb = XLSX.read(buffer, { type: 'array' });
    // Use sheet "Form Responses 2" if present, otherwise first sheet
    let sheetName = wb.SheetNames.find((s) => s.toLowerCase().includes('form responses 2'));
    if (!sheetName) sheetName = wb.SheetNames[0];

    const sheet = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

    const result = parseRehearsalSheet(rawRows, targetDate);
    setAvailableDatesInFile(result.availableDates);
    setImportSummary(result.summary);
    setIntercessionList(result.intercessionExcluded);
    setPrivateList(result.privateExcluded);

    const importedPassengers = result.included.map((r) => r.passenger);
    setPassengers(importedPassengers);

    // If no vehicles currently configured or virgin upload, attempt auto-suggest or load template
    if (vehicles.length === 0) {
      const savedTemplate = loadRehearsalTemplate();
      if (savedTemplate && savedTemplate.length > 0) {
        // Build vehicles from saved template
        const templatedVehicles: Vehicle[] = savedTemplate.map((t, idx) => ({
          id: `rehe_taxi_${idx + 1}`,
          name: t.taxiName,
          type: 'Taxi',
          capacity: t.capacity || 15,
          riders: [],
          orderedStops: t.stops.map((s) => s.stopName),
          stopTimes: Object.fromEntries(t.stops.map((s) => [s.stopName, s.time])),
        }));

        // Allocate passengers to stops defined in template
        importedPassengers.forEach((p) => {
          const veh = templatedVehicles.find((v) => v.orderedStops?.includes(p.stop));
          if (veh) {
            veh.riders.push(p.id);
          } else {
            // Put in first taxi
            templatedVehicles[0]?.riders.push(p.id);
          }
        });

        setVehicles(templatedVehicles);
        setTemplateNotice('Loaded stops and times from saved Thursday template.');
      } else {
        // Auto-suggest 2 default taxis
        const suggested = autoSuggestRehearsalAllocation(importedPassengers, 2, 15);
        setVehicles(suggested);
      }
    } else {
      // Re-map passengers to existing vehicles by stop
      const updatedVehs = vehicles.map((v) => ({ ...v, riders: [] as string[] }));
      importedPassengers.forEach((p) => {
        const matchingVeh = updatedVehs.find((v) => v.orderedStops?.includes(p.stop));
        if (matchingVeh) {
          matchingVeh.riders.push(p.id);
        } else {
          // Put in first vehicle
          if (updatedVehs[0]) {
            updatedVehs[0].riders.push(p.id);
            if (!updatedVehs[0].orderedStops?.includes(p.stop)) {
              updatedVehs[0].orderedStops?.push(p.stop);
            }
          }
        }
      });
      setVehicles(updatedVehs);
    }
  }

  // Handle date change and re-parse if buffer exists
  function onSelectDate(newDate: string) {
    onDateChange(newDate);
    if (rawWorkbookBuffer) {
      processWorkbook(rawWorkbookBuffer, newDate);
    }
  }

  // Auto suggest
  function handleAutoSuggest() {
    const suggested = autoSuggestRehearsalAllocation(passengers, vehicles.length || 2, 15);
    setVehicles(suggested);
  }

  // Add Taxi
  function handleAddTaxi() {
    const nextNum = vehicles.length + 1;
    const newVeh: Vehicle = {
      id: `rehe_taxi_${nextNum}_${Date.now()}`,
      name: `Taxi ${nextNum}`,
      type: 'Taxi',
      capacity: 15,
      riders: [],
      orderedStops: [],
      stopTimes: {},
    };
    setVehicles([...vehicles, newVeh]);
  }

  // Remove Taxi
  function handleRemoveTaxi(vId: string) {
    const remaining = vehicles.filter((v) => v.id !== vId);
    setVehicles(remaining);
  }

  // Update stop pickup time
  function handleUpdateTime(vId: string, stopName: string, time: string) {
    setVehicles((prev) =>
      prev.map((v) => {
        if (v.id !== vId) return v;
        return {
          ...v,
          stopTimes: {
            ...(v.stopTimes || {}),
            [stopName]: time,
          },
        };
      })
    );
  }

  // Reorder stop in vehicle
  function handleMoveStop(vId: string, stopIdx: number, direction: 'up' | 'down') {
    setVehicles((prev) =>
      prev.map((v) => {
        if (v.id !== vId || !v.orderedStops) return v;
        const stops = [...v.orderedStops];
        const targetIdx = direction === 'up' ? stopIdx - 1 : stopIdx + 1;
        if (targetIdx < 0 || targetIdx >= stops.length) return v;
        const temp = stops[stopIdx];
        stops[stopIdx] = stops[targetIdx];
        stops[targetIdx] = temp;
        return { ...v, orderedStops: stops };
      })
    );
  }

  // Move stop to another vehicle
  function handleMoveStopToVehicle(fromVId: string, toVId: string, stopName: string) {
    if (fromVId === toVId) return;
    setVehicles((prev) => {
      const fromVeh = prev.find((v) => v.id === fromVId);
      const toVeh = prev.find((v) => v.id === toVId);
      if (!fromVeh || !toVeh) return prev;

      // Passengers at this stop
      const stopPassengerIds = passengers.filter((p) => p.stop === stopName).map((p) => p.id);
      const stopTime = fromVeh.stopTimes?.[stopName] || '';

      return prev.map((v) => {
        if (v.id === fromVId) {
          const nextOrdered = (v.orderedStops || []).filter((s) => s !== stopName);
          const nextTimes = { ...(v.stopTimes || {}) };
          delete nextTimes[stopName];
          return {
            ...v,
            orderedStops: nextOrdered,
            stopTimes: nextTimes,
            riders: v.riders.filter((id) => !stopPassengerIds.includes(id)),
          };
        }
        if (v.id === toVId) {
          const nextOrdered = [...(v.orderedStops || [])];
          if (!nextOrdered.includes(stopName)) nextOrdered.push(stopName);
          const nextTimes = { ...(v.stopTimes || {}) };
          if (stopTime) nextTimes[stopName] = stopTime;
          const nextRiders = Array.from(new Set([...v.riders, ...stopPassengerIds]));
          return {
            ...v,
            orderedStops: nextOrdered,
            stopTimes: nextTimes,
            riders: nextRiders,
          };
        }
        return v;
      });
    });
  }

  // Move individual passenger between vehicles
  function handleMovePassenger(passengerId: string, toVId: string) {
    setVehicles((prev) =>
      prev.map((v) => {
        if (v.id === toVId) {
          return { ...v, riders: Array.from(new Set([...v.riders, passengerId])) };
        }
        return { ...v, riders: v.riders.filter((id) => id !== passengerId) };
      })
    );
  }

  // Save template
  function handleSaveTemplate() {
    const templates = vehicles.map((v) => ({
      taxiName: v.name,
      capacity: v.capacity || 15,
      stops: (v.orderedStops || []).map((s) => ({
        stopName: s,
        time: v.stopTimes?.[s] || '',
      })),
    }));
    saveRehearsalTemplate(templates);
    setTemplateNotice('Template saved successfully! Will pre-fill future Thursdays.');
    setTimeout(() => setTemplateNotice(null), 4000);
  }

  // Add Walk-in / Manual Passenger
  function handleSavePassenger() {
    if (!editName.trim()) return;

    if (editPassenger) {
      // Edit existing
      setPassengers((prev) =>
        prev.map((p) =>
          p.id === editPassenger.id
            ? {
                ...p,
                fullName: editName.trim(),
                stop: editStop,
                structure: editStructure,
                legs: editLegs,
              }
            : p
        )
      );
    } else {
      // Add new
      const newP: Passenger = {
        id: `walkin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fullName: editName.trim(),
        stop: editStop,
        structure: editStructure,
        service: 'Rehearsal',
        category: 'Normal',
        present: false,
        cancellationFeeOwed: false,
        assignedTo: null,
        legs: editLegs,
        walkIn: true,
      };
      setPassengers((prev) => [...prev, newP]);
      // Assign to first vehicle with this stop or vehicle 0
      if (vehicles.length > 0) {
        const targetVeh = vehicles.find((v) => v.orderedStops?.includes(editStop)) || vehicles[0];
        targetVeh.riders.push(newP.id);
        if (!targetVeh.orderedStops?.includes(editStop)) {
          targetVeh.orderedStops = [...(targetVeh.orderedStops || []), editStop];
        }
        setVehicles([...vehicles]);
      }
    }

    setShowAddModal(false);
    setEditPassenger(null);
    setEditName('');
  }

  // Remove Passenger
  function handleRemovePassenger(pId: string) {
    setPassengers((prev) => prev.filter((p) => p.id !== pId));
    setVehicles((prev) =>
      prev.map((v) => ({
        ...v,
        riders: v.riders.filter((id) => id !== pId),
      }))
    );
  }

  // Toggle included for an intercession passenger
  function handleIncludeIntercession(record: ParsedRehearsalRecord) {
    setIntercessionList((prev) => prev.filter((r) => r.id !== record.id));
    setPassengers((prev) => [...prev, record.passenger]);
    if (vehicles.length > 0) {
      const v = vehicles.find((v) => v.orderedStops?.includes(record.passenger.stop)) || vehicles[0];
      v.riders.push(record.passenger.id);
      if (!v.orderedStops?.includes(record.passenger.stop)) {
        v.orderedStops = [...(v.orderedStops || []), record.passenger.stop];
      }
      setVehicles([...vehicles]);
    }
  }

  // Publish Manifest
  async function handlePublish() {
    setSaving(true);
    try {
      const key = `${date}_Rehearsal`;
      const payload: Manifest = {
        date: key,
        signups: passengers,
        vehicles,
      };
      await onSaveManifest(payload);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to publish rehearsal manifest:', err);
    } finally {
      setSaving(false);
    }
  }

  // Copy for WhatsApp
  function handleCopyWhatsApp() {
    const text = formatRehearsalWhatsAppManifest(vehicles, passengers);
    navigator.clipboard.writeText(text);
    setCopiedWhatsApp(true);
    setTimeout(() => setCopiedWhatsApp(false), 3000);
  }

  // Live warnings
  const warnings = useMemo(() => {
    const list: string[] = [];

    // 1. Vehicle capacity
    vehicles.forEach((v) => {
      const cap = v.capacity || 15;
      if (v.riders.length > cap) {
        list.push(`${v.name} is over capacity: ${v.riders.length}/${cap} passengers.`);
      }
    });

    // 2. Stops without pickup time
    vehicles.forEach((v) => {
      (v.orderedStops || []).forEach((s) => {
        if (!v.stopTimes?.[s] || !v.stopTimes[s].trim()) {
          list.push(`${s} in ${v.name} does not have a pickup time set.`);
        }
      });
    });

    // 3. Passengers without stop
    passengers.forEach((p) => {
      if (!p.stop || p.stop === 'Unspecified') {
        list.push(`Passenger ${p.fullName} has no stop specified.`);
      }
    });

    // 4. Duplicate passengers in manifest
    const seenNames = new Set<string>();
    passengers.forEach((p) => {
      const low = p.fullName.trim().toLowerCase();
      if (seenNames.has(low)) {
        list.push(`Potential duplicate passenger: ${p.fullName}.`);
      }
      seenNames.add(low);
    });

    return list;
  }, [vehicles, passengers]);

  return (
    <div className="space-y-6">
      {/* DreamWeek warning banner if applicable */}
      {isDW && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-200 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-sm text-amber-100">DreamWeek Conference Active (29 Sep – 2 Oct 2026)</div>
            <p className="text-xs text-amber-300 mt-0.5">
              DreamWeek rules override Thursday pricing. All trips are R{DREAMWEEK_FARE} per leg for this date.
            </p>
          </div>
        </div>
      )}

      {/* Date Selector & File Upload Header */}
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-5 w-1 rounded-full bg-indigo-500" />
              <h2 className="font-display text-base font-bold uppercase tracking-wider text-ink">
                Thursday Rehearsal Setup
              </h2>
            </div>
            <p className="text-xs text-muted mt-0.5">
              Upload Google Form responses, allocate taxis by stop order, and publish the official rep manifest.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => onSelectDate(e.target.value)}
              className="input-field py-1.5 px-3 text-xs font-semibold"
            />
          </div>
        </div>

        {/* Available Dates pill bar if found in workbook */}
        {availableDatesInFile.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted font-semibold">Dates in spreadsheet:</span>
            {availableDatesInFile.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onSelectDate(d)}
                className={`px-2.5 py-1 text-xs rounded-lg font-semibold border transition-all ${
                  d === date
                    ? 'bg-indigo-600 text-white border-indigo-500 shadow-xs'
                    : 'bg-card-2 text-muted border-line hover:text-ink'
                }`}
              >
                {prettyDate(d)}
              </button>
            ))}
          </div>
        )}

        {/* Upload Drop Zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          className="group relative cursor-pointer rounded-xl border-2 border-dashed border-line bg-card-2/40 p-6 text-center transition-all hover:border-indigo-500/50 hover:bg-indigo-900/5"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
              e.target.value = '';
            }}
            className="hidden"
          />

          {parsing ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-7 w-7 animate-spin text-indigo-400" />
              <p className="text-sm font-semibold text-ink">Processing Rehearsal Google Form sheet…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 border border-indigo-500/30">
                <Upload className="h-5 w-5 text-indigo-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">
                  Upload Google Form Spreadsheet ("Form Responses 2")
                </p>
                <p className="text-xs text-muted mt-0.5">
                  Filters for <strong className="text-ink">{prettyDate(date)}</strong> · Automatically removes duplicates (latest submission wins)
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import Summary Card */}
      {importSummary && (
        <div className="card bg-card-2/50 border border-line">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 mb-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-indigo-400" />
              <span className="font-display text-sm font-bold uppercase text-ink">Import Summary</span>
              <span className="text-xs text-muted">({shortDate(date)})</span>
            </div>
            <div className="text-xs font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
              Expected Total Fare: R{importSummary.expectedTotalFare.toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted">Total Submissions</div>
              <div className="text-base font-bold text-ink">{importSummary.totalResponsesForDate}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted">Duplicates Removed</div>
              <div className="text-base font-bold text-amber-400">-{importSummary.duplicatesRemoved}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted">Manifest Passengers</div>
              <div className="text-base font-bold text-indigo-400">{importSummary.includedCount}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted">Legs Breakdown</div>
              <div className="text-xs font-semibold text-ink mt-0.5">
                Both: {importSummary.legsBothCount} · Going: {importSummary.legsGoingCount} · Return: {importSummary.legsReturnCount}
              </div>
            </div>
          </div>

          {/* Excluded sections */}
          <div className="mt-3 space-y-2">
            {intercessionList.length > 0 && (
              <div className="rounded-lg border border-line bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowIntercessionSection(!showIntercessionSection)}
                  className="flex w-full items-center justify-between p-2.5 text-xs font-semibold text-muted hover:text-ink"
                >
                  <span>Intercession Taxi Excluded ({intercessionList.length})</span>
                  {showIntercessionSection ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showIntercessionSection && (
                  <div className="p-2.5 border-t border-line space-y-1.5 text-xs">
                    <p className="text-[11px] text-muted">
                      These respondents selected Intercession taxi both ways or going only. Click "Include" to add them to Rehearsal:
                    </p>
                    {intercessionList.map((rec) => (
                      <div key={rec.id} className="flex items-center justify-between py-1 border-b border-line/40 last:border-0">
                        <div>
                          <span className="font-semibold text-ink">{rec.passenger.fullName}</span>
                          <span className="text-muted ml-1.5">({rec.passenger.stop})</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleIncludeIntercession(rec)}
                          className="px-2 py-0.5 text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 rounded hover:bg-indigo-500/25"
                        >
                          Include
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {privateList.length > 0 && (
              <div className="rounded-lg border border-line bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowPrivateSection(!showPrivateSection)}
                  className="flex w-full items-center justify-between p-2.5 text-xs font-semibold text-muted hover:text-ink"
                >
                  <span>Private Transport Excluded ({privateList.length})</span>
                  {showPrivateSection ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showPrivateSection && (
                  <div className="p-2.5 border-t border-line space-y-1 text-xs text-muted">
                    {privateList.map((rec) => (
                      <div key={rec.id} className="py-0.5">
                        <span className="font-semibold text-ink">{rec.passenger.fullName}</span> · Using private transport
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Warnings & Notices */}
      {templateNotice && (
        <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-3 text-xs text-indigo-300 flex items-center justify-between">
          <span>{templateNotice}</span>
          <button onClick={() => setTemplateNotice(null)} className="text-muted hover:text-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 space-y-1 text-xs text-amber-200">
          <div className="flex items-center gap-1.5 font-bold text-amber-100">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <span>Setup Warnings ({warnings.length})</span>
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-amber-300/90 pl-1">
            {warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-card p-3 rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleAddTaxi}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-2.5"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Taxi</span>
          </button>
          <button
            type="button"
            onClick={handleAutoSuggest}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-2.5"
            title="Auto-distribute passengers across taxis by route order"
          >
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            <span>Auto-Suggest</span>
          </button>
          <button
            type="button"
            onClick={handleSaveTemplate}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-2.5"
            title="Save stop order and pickup times as reusable template"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Save Template</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditPassenger(null);
              setEditName('');
              setEditStop('Braam');
              setEditLegs('both');
              setShowAddModal(true);
            }}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-2.5"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Passenger</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopyWhatsApp}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-3 text-emerald-400 hover:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10"
          >
            {copiedWhatsApp ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copiedWhatsApp ? 'Copied WhatsApp!' : 'Copy for WhatsApp'}</span>
          </button>
          <button
            type="button"
            onClick={() => downloadRehearsalManifestPdf({ date, vehicles, signups: passengers })}
            className="btn-ghost flex items-center gap-1.5 text-xs py-1.5 px-3 text-crimson-400 hover:text-crimson-300 border-crimson-500/30"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Download PDF</span>
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving}
            className="btn-primary flex items-center gap-1.5 text-xs py-1.5 px-4 shadow-sm"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            <span>{saveSuccess ? 'Published!' : 'Publish Manifest'}</span>
          </button>
        </div>
      </div>

      {/* Taxi Cards Grid */}
      <div className="grid gap-5">
        {vehicles.map((veh) => {
          const riders = (veh.riders || [])
            .map((id) => passengers.find((p) => p.id === id))
            .filter(Boolean) as Passenger[];
          const cap = veh.capacity || 15;
          const isOverCap = riders.length > cap;

          return (
            <div
              key={veh.id}
              className={`rounded-2xl border bg-card p-4 transition-all ${
                isOverCap ? 'border-amber-500/50 bg-amber-500/5' : 'border-line'
              }`}
            >
              {/* Vehicle Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 mb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-bold">
                    🚖
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={veh.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setVehicles((prev) =>
                            prev.map((v) => (v.id === veh.id ? { ...v, name: val } : v))
                          );
                        }}
                        className="font-display text-sm font-bold uppercase text-ink bg-transparent border-b border-dashed border-line/60 focus:border-indigo-400 focus:outline-hidden py-0.5"
                      />
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                          isOverCap
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                            : 'bg-card-2 text-muted border-line'
                        }`}
                      >
                        {riders.length} / {cap} seats
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <span>Capacity:</span>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={cap}
                      onChange={(e) => {
                        const newCap = Number(e.target.value) || 15;
                        setVehicles((prev) =>
                          prev.map((v) => (v.id === veh.id ? { ...v, capacity: newCap } : v))
                        );
                      }}
                      className="input-field w-14 py-1 text-center font-mono text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveTaxi(veh.id)}
                    className="p-1.5 text-muted hover:text-crimson-400 rounded-lg hover:bg-card-2"
                    title="Remove taxi"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Stops list under this taxi */}
              <div className="space-y-3">
                {(veh.orderedStops || []).map((stopName, sIdx) => {
                  const stopRiders = riders.filter((r) => r.stop === stopName);
                  stopRiders.sort((a, b) => naturalCompare(a.fullName, b.fullName));

                  return (
                    <div
                      key={stopName}
                      className="rounded-xl border border-line/60 bg-card-2/30 p-3 space-y-2"
                    >
                      {/* Stop Header with Time and Reorder Controls */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-ink flex items-center gap-1">
                            🛑 {stopName}
                          </span>
                          <span className="text-xs text-muted">({stopRiders.length} riders)</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5 text-muted" />
                            <input
                              type="text"
                              placeholder="e.g. 17:00"
                              value={veh.stopTimes?.[stopName] || ''}
                              onChange={(e) => handleUpdateTime(veh.id, stopName, e.target.value)}
                              className="input-field py-1 px-2 text-xs font-mono w-24 text-center"
                            />
                          </div>

                          {/* Reorder arrows */}
                          <div className="flex items-center border border-line rounded-lg overflow-hidden">
                            <button
                              type="button"
                              onClick={() => handleMoveStop(veh.id, sIdx, 'up')}
                              disabled={sIdx === 0}
                              className="p-1 hover:bg-card-2 text-muted disabled:opacity-30"
                              title="Move stop earlier"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMoveStop(veh.id, sIdx, 'down')}
                              disabled={sIdx === (veh.orderedStops?.length || 0) - 1}
                              className="p-1 hover:bg-card-2 text-muted disabled:opacity-30"
                              title="Move stop later"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                          </div>

                          {/* Move stop to another vehicle select */}
                          {vehicles.length > 1 && (
                            <select
                              value=""
                              onChange={(e) => handleMoveStopToVehicle(veh.id, e.target.value, stopName)}
                              className="input-field text-xs py-1 text-muted"
                            >
                              <option value="" disabled>Move Stop...</option>
                              {vehicles
                                .filter((other) => other.id !== veh.id)
                                .map((other) => (
                                  <option key={other.id} value={other.id}>
                                    To {other.name}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      </div>

                      {/* Passengers for this stop */}
                      <div className="divide-y divide-line/30 pt-1">
                        {stopRiders.map((p, idx) => {
                          let legLabel = '';
                          if (p.legs === 'going') legLabel = '(Going)';
                          else if (p.legs === 'return') legLabel = '(Return)';

                          return (
                            <div
                              key={p.id}
                              className="flex items-center justify-between py-1.5 text-xs text-ink"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-muted text-[11px] w-5">
                                  {idx + 1}.
                                </span>
                                <span className="font-semibold">{p.fullName}</span>
                                {legLabel && (
                                  <span className="text-[10px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 rounded">
                                    {legLabel}
                                  </span>
                                )}
                                {p.notes && (
                                  <span className="text-[10px] text-muted italic">
                                    — {p.notes}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1.5">
                                {/* Move passenger to another taxi */}
                                {vehicles.length > 1 && (
                                  <select
                                    value={veh.id}
                                    onChange={(e) => handleMovePassenger(p.id, e.target.value)}
                                    className="input-field text-[11px] py-0.5 px-1.5 text-muted"
                                  >
                                    {vehicles.map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.name}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditPassenger(p);
                                    setEditName(p.fullName);
                                    setEditStop(p.stop);
                                    setEditLegs(p.legs || 'both');
                                    setEditStructure(p.structure || 'S1');
                                    setShowAddModal(true);
                                  }}
                                  className="p-1 text-muted hover:text-ink rounded"
                                  title="Edit passenger"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemovePassenger(p.id)}
                                  className="p-1 text-muted hover:text-crimson-400 rounded"
                                  title="Remove passenger"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Add a stop to this taxi */}
                <div className="pt-2 flex items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => {
                      const newStop = e.target.value;
                      if (!newStop) return;
                      setVehicles((prev) =>
                        prev.map((v) => {
                          if (v.id !== veh.id) return v;
                          const stops = v.orderedStops || [];
                          if (!stops.includes(newStop)) {
                            return { ...v, orderedStops: [...stops, newStop] };
                          }
                          return v;
                        })
                      );
                    }}
                    className="input-field text-xs py-1.5 w-52"
                  >
                    <option value="" disabled>+ Add Stop to {veh.name}...</option>
                    {CANONICAL_REHEARSAL_STOPS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / Edit Passenger Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-line bg-card p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="font-display text-sm font-bold uppercase text-ink">
                {editPassenger ? 'Edit Passenger' : 'Add Walk-In / Manual Passenger'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setEditPassenger(null);
                }}
                className="text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-muted font-bold uppercase mb-1">Full Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g. Thato Ndwebi"
                  className="input-field w-full py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-muted font-bold uppercase mb-1">Pickup Stop</label>
                <select
                  value={editStop}
                  onChange={(e) => setEditStop(e.target.value)}
                  className="input-field w-full py-2 text-sm"
                >
                  {CANONICAL_REHEARSAL_STOPS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-muted font-bold uppercase mb-1">Structure</label>
                <input
                  type="text"
                  value={editStructure}
                  onChange={(e) => setEditStructure(e.target.value)}
                  placeholder="e.g. S1"
                  className="input-field w-full py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-muted font-bold uppercase mb-1">Legs (Fare)</label>
                <select
                  value={editLegs}
                  onChange={(e) => setEditLegs(e.target.value as RehearsalLegs)}
                  className="input-field w-full py-2 text-sm"
                >
                  <option value="both">Going & Return — R70</option>
                  <option value="going">Going Only — R40</option>
                  <option value="return">Return Only — R40</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setEditPassenger(null);
                }}
                className="btn-ghost py-2 px-3 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSavePassenger}
                disabled={!editName.trim()}
                className="btn-primary py-2 px-4 text-xs font-semibold"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
