import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

const DATA_DIR = path.join(process.cwd(), 'data');
const MANIFESTS_DIR = path.join(DATA_DIR, 'manifests');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const SPONSORSHIPS_FILE = path.join(DATA_DIR, 'sponsorship_audits.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MANIFESTS_DIR)) fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(SPONSORSHIPS_FILE)) fs.writeFileSync(SPONSORSHIPS_FILE, JSON.stringify([]), 'utf-8');

// Atomic write helper
function atomicWriteJson(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    console.warn(`[Server] Error reading JSON from ${filePath}:`, err);
    return fallback;
  }
}

// SSE clients for live synchronization
const sseClients = new Set<express.Response>();

function broadcastSse(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// SSE Live Sync Stream
app.get('/api/sync/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// List all manifests
app.get('/api/manifests', (req, res) => {
  try {
    const files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
    const list: Array<{
      date: string;
      updated_at?: string;
      vehiclesCount: number;
      signupsCount: number;
      submittedCount: number;
    }> = [];

    for (const file of files) {
      const key = file.replace(/\.json$/, '');
      const m = readJsonFile<{
        date: string;
        updated_at?: string;
        vehicles?: Array<{ submitted?: boolean }>;
        signups?: unknown[];
      }>(path.join(MANIFESTS_DIR, file), { date: key });

      list.push({
        date: m.date || key,
        updated_at: m.updated_at,
        vehiclesCount: Array.isArray(m.vehicles) ? m.vehicles.length : 0,
        signupsCount: Array.isArray(m.signups) ? m.signups.length : 0,
        submittedCount: Array.isArray(m.vehicles) ? m.vehicles.filter((v) => v.submitted).length : 0,
      });
    }

    list.sort((a, b) => b.date.localeCompare(a.date));
    res.json(list);
  } catch (err) {
    console.error('[Server] Failed to list manifests:', err);
    res.status(500).json({ error: 'Failed to list manifests' });
  }
});

// Get specific manifest
app.get('/api/manifests/:key', (req, res) => {
  const key = req.params.key;
  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Manifest not found', date: key });
    return;
  }
  const manifest = readJsonFile(filePath, null);
  if (!manifest) {
    res.status(404).json({ error: 'Manifest not found', date: key });
    return;
  }
  res.json(manifest);
});

// Save/Upsert specific manifest
app.post('/api/manifests/:key', (req, res) => {
  const key = req.params.key;
  const manifest = req.body;
  if (!manifest || typeof manifest !== 'object') {
    res.status(400).json({ error: 'Invalid manifest body' });
    return;
  }

  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  const nowIso = new Date().toISOString();

  // Read existing manifest on disk to guarantee submitted vehicles and their attendance notes are NEVER wiped out by concurrent saves
  const existingManifest = readJsonFile<{
    date?: string;
    signups?: unknown[];
    vehicles?: Array<{
      id: string;
      name?: string;
      submitted?: boolean;
      submittedAt?: string;
      submittedBy?: string;
      repName?: string;
      licensePlate?: string;
      coReps?: string[];
      generalNotes?: string;
      draftState?: unknown;
      riders?: string[];
    }>;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const existingVehMap = new Map((existingManifest.vehicles || []).map((v) => [String(v.id), v]));

  // Reconcile incoming vehicles with disk: if vehicle was already submitted on disk, NEVER let a routine save un-submit it!
  const mergedVehicles = (Array.isArray(manifest.vehicles) ? manifest.vehicles : []).map((incV: {
    id: string;
    submitted?: boolean;
    submittedAt?: string;
    submittedBy?: string;
    repName?: string;
    licensePlate?: string;
    generalNotes?: string;
    draftState?: Record<string, unknown>;
  }) => {
    const sId = String(incV.id);
    const existV = existingVehMap.get(sId);
    if (existV?.submitted && !incV.submitted) {
      return {
        ...incV,
        submitted: true,
        submittedAt: existV.submittedAt || incV.submittedAt,
        submittedBy: existV.submittedBy || incV.submittedBy,
        repName: existV.repName || incV.repName,
        licensePlate: existV.licensePlate || incV.licensePlate,
        generalNotes: existV.generalNotes || incV.generalNotes,
        draftState: {
          ...(typeof incV.draftState === 'object' && incV.draftState ? incV.draftState : {}),
          ...(typeof existV.draftState === 'object' && existV.draftState ? (existV.draftState as Record<string, unknown>) : {}),
          submitted: true,
          submittedAt: existV.submittedAt || incV.submittedAt,
        },
      };
    }
    return incV;
  });

  // Preserve any vehicles that were in existing disk file but missing from partial payload
  const incomingVehIds = new Set((manifest.vehicles || []).map((v: { id: string }) => String(v.id)));
  for (const existV of existingManifest.vehicles || []) {
    if (!incomingVehIds.has(String(existV.id))) {
      mergedVehicles.push(existV);
    }
  }

  const toSave = {
    ...manifest,
    date: key,
    signups: Array.isArray(manifest.signups) ? manifest.signups : (existingManifest.signups || []),
    vehicles: mergedVehicles,
    updated_at: nowIso,
  };

  atomicWriteJson(filePath, toSave);
  broadcastSse('manifest_updated', { key, manifest: toSave, timestamp: Date.now() });

  res.json({ success: true, manifest: toSave });
});

// Helper to thoroughly strip vehicle summary boilerplate from personal absentee notes
function cleanPersonalAbsenteeNote(note?: unknown): string {
  if (!note || typeof note !== 'string') return '';
  let trimmed = note.trim();
  if (!trimmed) return '';

  // Strip vehicle-wide summary prefixes and their trailing contents
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:[^.]*(?:\.|$)/gi, '');
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:.*?(?=(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:|$)/gi, '');
  trimmed = trimmed.replace(/\b(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\b[^.]*(\.|$)/gi, '');
  trimmed = trimmed.replace(/\bpaid by\s*:[^;.]*(?:[;.]|$)/gi, '');
  trimmed = trimmed.replace(/\s{2,}/g, ' ').trim();

  // If after stripping only punctuation or whitespace remains, return empty string
  if (/^[-–—:;,.\s]*$/.test(trimmed)) return '';
  return trimmed;
}

// Atomic Vehicle Attendance Submission
app.post('/api/manifests/:key/submit-vehicle', (req, res) => {
  const key = req.params.key;
  const {
    vehicleId,
    repName,
    licensePlate,
    coReps,
    generalNotes,
    draftState,
    absentees,
    sponsoredRiders,
    unpaidRiders,
    allRiderNames,
    serviceLabel,
    parsedDate,
    updatedSignups,
    allVehicles,
  } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }

  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  const manifest = readJsonFile<{
    date: string;
    signups: Array<{ id: string; fullName: string; present?: boolean; sponsored?: boolean; didNotPay?: boolean }>;
    vehicles: Array<{
      id: string;
      name: string;
      repName?: string;
      licensePlate?: string;
      submitted?: boolean;
      submittedAt?: string;
      submittedBy?: string;
      coReps?: string[];
      generalNotes?: string;
      draftState?: unknown;
    }>;
    updated_at?: string;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const nowIso = new Date().toISOString();

  // If manifest has no vehicles or missing vehicles, merge with allVehicles from payload
  const incomingFleet = Array.isArray(allVehicles)
    ? allVehicles
    : Array.isArray(req.body?.vehicles)
    ? req.body.vehicles
    : [];

  if ((manifest.vehicles || []).length === 0 && incomingFleet.length > 0) {
    manifest.vehicles = incomingFleet;
  } else if (incomingFleet.length > 0) {
    const existingVehIds = new Set((manifest.vehicles || []).map((v) => String(v.id)));
    for (const incV of incomingFleet) {
      if (!existingVehIds.has(String(incV.id))) {
        manifest.vehicles.push(incV);
      }
    }
  }

  // 1. Update target vehicle in manifest (using String comparison to avoid number vs string mismatch)
  let targetVehicleName = 'Vehicle';
  let foundTarget = false;
  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (String(v.id) === String(vehicleId)) {
      foundTarget = true;
      targetVehicleName = v.name;
      const vDraft = typeof draftState === 'object' && draftState ? draftState : (v.draftState || {});
      return {
        ...v,
        submitted: true,
        submittedAt: nowIso,
        submittedBy: (repName || '').trim(),
        repName: (repName || '').trim(),
        licensePlate: (licensePlate || '').trim(),
        coReps: Array.isArray(coReps) ? coReps : [],
        generalNotes: (generalNotes || '').trim(),
        draftState: {
          ...(typeof v.draftState === 'object' && v.draftState ? v.draftState : {}),
          ...(typeof vDraft === 'object' && vDraft ? (vDraft as Record<string, unknown>) : {}),
          submitted: true,
          submittedAt: nowIso,
          repName: (repName || '').trim(),
          licensePlate: (licensePlate || '').trim(),
          generalNotes: (generalNotes || '').trim(),
        },
      };
    }
    return v;
  });

  if (!foundTarget) {
    const payloadVeh = req.body?.vehicle;
    const vDraft = typeof draftState === 'object' && draftState ? draftState : (payloadVeh?.draftState || {});
    const newV = {
      id: String(vehicleId),
      name: payloadVeh?.name || `Vehicle ${(manifest.vehicles || []).length + 1}`,
      type: payloadVeh?.type || 'Taxi',
      capacity: payloadVeh?.capacity,
      driverName: payloadVeh?.driverName,
      driverPhone: payloadVeh?.driverPhone,
      notes: payloadVeh?.notes,
      riders: Array.isArray(payloadVeh?.riders) ? payloadVeh.riders : [],
      orderedStops: Array.isArray(payloadVeh?.orderedStops) ? payloadVeh.orderedStops : [],
      submitted: true,
      submittedAt: nowIso,
      submittedBy: (repName || '').trim(),
      repName: (repName || '').trim(),
      licensePlate: (licensePlate || '').trim(),
      coReps: Array.isArray(coReps) ? coReps : [],
      generalNotes: (generalNotes || '').trim(),
      draftState: {
        ...(typeof vDraft === 'object' && vDraft ? (vDraft as Record<string, unknown>) : {}),
        submitted: true,
        submittedAt: nowIso,
        repName: (repName || '').trim(),
        licensePlate: (licensePlate || '').trim(),
        generalNotes: (generalNotes || '').trim(),
      },
    };
    targetVehicleName = newV.name;
    manifest.vehicles = [...(manifest.vehicles || []), newV];
  }

  // 2. Update signups attendance if provided
  if (Array.isArray(updatedSignups) && updatedSignups.length > 0) {
    manifest.signups = updatedSignups;
  }

  manifest.updated_at = nowIso;
  atomicWriteJson(filePath, manifest);

  // 3. Atomically record absentees in the cancellation ledger
  let ledger = readJsonFile<Array<{
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_name: string;
    stop?: string;
    structure?: string;
    vehicle_name?: string;
    submitted_by?: string;
    rep_name?: string;
    license_plate?: string;
    sponsored?: boolean;
    sponsor_note?: string;
    structure_debt: number;
    general_notes?: string;
    submitted_at: string;
  }>>(LEDGER_FILE, []);

  // Remove any previous ledger entries for these riders in this session
  if (Array.isArray(allRiderNames) && allRiderNames.length > 0) {
    const riderSet = new Set(allRiderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
    ledger = ledger.filter((entry) => {
      const eDate = normalizeDateToYMD(entry.date) || entry.date || (entry.manifest_key ? String(entry.manifest_key).split('_')[0] : '');
      const isSameDate = entry.manifest_key === key || (parsedDate && eDate === normalizeDateToYMD(parsedDate));
      const isRider = riderSet.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase());
      return !(isSameDate && isRider);
    });
  }

  // Insert new absentees: regular cancellations in debt ledger (not auto-sent to sponsorship section)
  const isReheKey = (serviceLabel || '').toLowerCase().includes('rehe') || (key || '').toLowerCase().includes('rehe');
  const normalizedSvcLabel = isReheKey ? 'Rehe' : (serviceLabel || 'Service');
  const isDW = isDreamWeekDate(parsedDate || key);
  const effectiveDebt = getFareForDate(parsedDate || key);

  if (Array.isArray(absentees) && absentees.length > 0) {
    for (const a of absentees) {
      const aLegs = (a as { legs?: 'both' | 'going' | 'return' }).legs;
      let absenteeDebt = effectiveDebt;
      if (!isDW) {
        if (aLegs === 'both') absenteeDebt = 70;
        else if (aLegs === 'going' || aLegs === 'return') absenteeDebt = 40;
        else if (isReheKey) absenteeDebt = 70;
      }
      ledger.push({
        id: `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        manifest_key: key,
        date: parsedDate || key,
        service: normalizedSvcLabel,
        passenger_name: a.fullName,
        stop: a.stop || '',
        structure: a.structure || '',
        vehicle_name: targetVehicleName,
        submitted_by: (repName || '').trim(),
        rep_name: (repName || '').trim(),
        license_plate: (licensePlate || '').trim(),
        sponsored: false,
        sponsor_note: '',
        structure_debt: absenteeDebt,
        general_notes: cleanPersonalAbsenteeNote((a as { notes?: string }).notes || ''),
        submitted_at: nowIso,
        legs: aLegs || (isReheKey ? 'both' : undefined),
      });
    }
  }

  // Insert riders indicated as "didn't pay" directly into ledger
  const targetRiderIds = new Set((manifest.vehicles.find((v) => String(v.id) === String(vehicleId))?.riders || []).map(String));
  const effectiveUnpaid: Array<{ fullName: string; stop?: string; structure?: string; unpaidNote?: string }> = [];

  if (Array.isArray(unpaidRiders) && unpaidRiders.length > 0) {
    effectiveUnpaid.push(...unpaidRiders);
  } else if (Array.isArray(manifest.signups)) {
    for (const s of manifest.signups) {
      if (targetRiderIds.has(String(s.id)) && s.didNotPay) {
        effectiveUnpaid.push({
          fullName: s.fullName,
          stop: (s as { stop?: string }).stop || '',
          structure: (s as { structure?: string }).structure || '',
          unpaidNote: (s as { unpaidNote?: string }).unpaidNote || '',
        });
      }
    }
  }

  if (effectiveUnpaid.length > 0) {
    for (const u of effectiveUnpaid) {
      const cleanName = sanitizePassengerDisplayName(u.fullName);
      if (!ledger.some((e) => e.manifest_key === key && sanitizePassengerDisplayName(e.passenger_name as string).toLowerCase() === cleanName.toLowerCase())) {
        ledger.push({
          id: `ledger_unpaid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          manifest_key: key,
          date: parsedDate || key,
          service: serviceLabel || 'Service',
          passenger_name: cleanName,
          stop: u.stop || '',
          structure: normalizeStructureCode(u.structure),
          vehicle_name: targetVehicleName,
          submitted_by: (repName || '').trim(),
          rep_name: (repName || '').trim(),
          license_plate: (licensePlate || '').trim(),
          sponsored: true,
          debt_type: 'unpaid_sponsorship',
          sponsor_note: u.unpaidNote ? `Did not pay: ${u.unpaidNote}` : 'Did not pay',
          structure_debt: effectiveDebt,
          general_notes: `Did not pay${u.unpaidNote ? `: ${u.unpaidNote}` : ''}`,
          source: 'reported_sponsorship_audit',
          submitted_at: nowIso,
        });
      }
    }
  }

  atomicWriteJson(LEDGER_FILE, ledger);

  // 4. Record reported sponsorships for cancellation admin audit
  const audits = readJsonFile<Array<{
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_id?: string;
    passenger_name: string;
    structure: string;
    stop?: string;
    vehicle_name: string;
    rep_name: string;
    sponsor_note: string;
    status: 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';
    status_updated_at?: string;
    ledger_entry_id?: string;
    submitted_at: string;
  }>>(SPONSORSHIPS_FILE, []);

  const rawSponsored = Array.isArray(sponsoredRiders) ? sponsoredRiders : [];
  const draftSponIds = new Set(
    Array.isArray((draftState as { sponsoredIds?: Array<string | number> })?.sponsoredIds)
      ? (draftState as { sponsoredIds?: Array<string | number> }).sponsoredIds.map(String)
      : []
  );
  const draftNotes = (draftState as { notes?: Record<string, string> })?.notes || {};

  const collectedSponsees: Array<{
    id?: string;
    fullName: string;
    structure?: string;
    stop?: string;
    vehicleName?: string;
    vehicle_name?: string;
    taxiName?: string;
    sponsorNote?: string;
  }> = [...rawSponsored];

  // Include any riders in draftState.sponsoredIds that were not already in rawSponsored
  if (draftSponIds.size > 0 && Array.isArray(manifest.signups)) {
    for (const s of manifest.signups) {
      const sId = String(s.id);
      if (
        (draftSponIds.has(sId) || draftSponIds.has(s.id as unknown as string)) &&
        !collectedSponsees.some((c) => c.fullName.toLowerCase() === s.fullName.toLowerCase())
      ) {
        collectedSponsees.push({
          id: sId,
          fullName: s.fullName,
          structure: (s as { structure?: string }).structure || '',
          stop: (s as { stop?: string }).stop || '',
          vehicleName: targetVehicleName,
          sponsorNote: (draftNotes[sId] ?? draftNotes[s.id] ?? (s as { sponsorNote?: string }).sponsorNote ?? '').trim(),
        });
      }
    }
  }

  // Also include any external cross-taxi sponsees recorded in draftState
  const extSponsees = Array.isArray((draftState as { externalSponsees?: unknown[] })?.externalSponsees)
    ? (draftState as { externalSponsees: Array<{ sponseeId?: string; sponseeName: string; taxiName?: string; payerName?: string; note?: string }> }).externalSponsees
    : [];
  for (const ext of extSponsees) {
    if (ext.sponseeName && !collectedSponsees.some((c) => c.fullName.toLowerCase() === ext.sponseeName.toLowerCase())) {
      const matchedSignup = (manifest.signups || []).find((s) => s.fullName.toLowerCase() === ext.sponseeName.toLowerCase());
      collectedSponsees.push({
        id: ext.sponseeId || (matchedSignup ? String(matchedSignup.id) : undefined),
        fullName: ext.sponseeName,
        structure: (matchedSignup as { structure?: string })?.structure || '',
        stop: (matchedSignup as { stop?: string })?.stop || '',
        vehicleName: ext.taxiName || targetVehicleName,
        sponsorNote: cleanSponsorshipNote(ext.note || `Paid by ${ext.payerName || 'Rider'} in ${targetVehicleName}`),
      });
    }
  }

  for (const sp of collectedSponsees) {
    if (!sp.fullName || !sp.fullName.trim()) continue;
    const cleanName = sanitizePassengerDisplayName(sp.fullName.trim());
    if (!cleanName) continue;
    const baseDate = normalizeDateToYMD(parsedDate || key);
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const auditId = `sp_${baseDate}_${normName}`;
    const specificVehicle = sp.vehicleName || sp.vehicle_name || sp.taxiName || targetVehicleName;

    // Strict date-scoped search: ONLY match within the same session date
    const existingIdx = audits.findIndex((a) => {
      const aDate = normalizeDateToYMD(a.date || a.manifest_key);
      const isSameDate = (!baseDate && !aDate) || (baseDate && aDate && baseDate === aDate) || (a.manifest_key === key);
      if (!isSameDate) return false;

      if (a.id && a.id === auditId) return true;
      if (sp.id && a.passenger_id && String(sp.id) === String(a.passenger_id)) return true;
      const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return aName === normName;
    });

    if (existingIdx >= 0) {
      audits[existingIdx] = {
        ...audits[existingIdx],
        passenger_id: sp.id || audits[existingIdx].passenger_id,
        passenger_name: cleanName,
        structure: sp.structure || audits[existingIdx].structure,
        stop: sp.stop || audits[existingIdx].stop,
        vehicle_name: specificVehicle || audits[existingIdx].vehicle_name,
        rep_name: (repName || '').trim() || audits[existingIdx].rep_name,
        sponsor_note: cleanSponsorshipNote(sp.sponsorNote) || audits[existingIdx].sponsor_note,
        date: parsedDate || key,
        service: serviceLabel || 'Service',
      };
    } else {
      audits.push({
        id: auditId,
        manifest_key: key,
        date: parsedDate || key,
        service: serviceLabel || 'Service',
        passenger_id: sp.id,
        passenger_name: cleanName,
        structure: sp.structure || '',
        stop: sp.stop || '',
        vehicle_name: specificVehicle,
        rep_name: (repName || '').trim(),
        sponsor_note: cleanSponsorshipNote(sp.sponsorNote) || '',
        status: 'pending',
        submitted_at: nowIso,
      });
    }
  }

  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  // 5. Broadcast live updates to all clients
  broadcastSse('manifest_updated', { key, manifest, timestamp: Date.now() });
  broadcastSse('ledger_updated', { timestamp: Date.now() });
  broadcastSse('sponsorships_updated', { timestamp: Date.now() });

  res.json({
    success: true,
    manifest,
    submittedAt: nowIso,
    absenteesRecorded: Array.isArray(absentees) ? absentees.length : 0,
  });
});

// Reopen Vehicle Attendance
app.post('/api/manifests/:key/reopen-vehicle', (req, res) => {
  const key = req.params.key;
  const { vehicleId, allRiderNames } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }

  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  const manifest = readJsonFile<{
    date: string;
    signups: unknown[];
    vehicles: Array<{ id: string; submitted?: boolean; submittedAt?: string; submittedBy?: string }>;
    updated_at?: string;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const nowIso = new Date().toISOString();

  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (v.id === vehicleId) {
      return {
        ...v,
        submitted: false,
        submittedAt: undefined,
        submittedBy: undefined,
        draftState: v.draftState ? { ...(v.draftState as Record<string, unknown>), submitted: false, submittedAt: undefined } : undefined,
      };
    }
    return v;
  });

  // Revoke submitted attendance flags for riders in this vehicle
  const targetVehicle = (manifest.vehicles || []).find((v) => v.id === vehicleId);
  const targetRiderIds = new Set(((targetVehicle as { riders?: string[] })?.riders || []).map(String));
  if (Array.isArray(manifest.signups)) {
    manifest.signups = manifest.signups.map((s) => {
      const p = s as { id: string | number; present?: boolean; sponsored?: boolean; didNotPay?: boolean };
      if (targetRiderIds.has(String(p.id))) {
        return {
          ...p,
          present: false,
          sponsored: false,
          didNotPay: false,
        };
      }
      return p;
    });
  }

  manifest.updated_at = nowIso;
  atomicWriteJson(filePath, manifest);

  // Withdraw ledger entries and pending sponsorships for these riders
  if (Array.isArray(allRiderNames) && allRiderNames.length > 0) {
    const riderSet = new Set(allRiderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
    const baseDate = key.split('_')[0];

    let ledger = readJsonFile<Array<{ manifest_key: string; passenger_name: string; date?: string }>>(LEDGER_FILE, []);
    ledger = ledger.filter((entry) => {
      const eDate = (entry.date || entry.manifest_key || '').split('_')[0];
      const isSameDate = entry.manifest_key === key || eDate === baseDate;
      const isRider = riderSet.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase());
      return !(isSameDate && isRider);
    });
    atomicWriteJson(LEDGER_FILE, ledger);

    let audits = readJsonFile<Array<{ manifest_key: string; passenger_name: string; status: string; date?: string }>>(SPONSORSHIPS_FILE, []);
    audits = audits.filter((entry) => {
      const eDate = (entry.date || entry.manifest_key || '').split('_')[0];
      const isSameDate = entry.manifest_key === key || eDate === baseDate;
      const isRider = riderSet.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase());
      return !(isSameDate && isRider && entry.status === 'pending');
    });
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
  }

  broadcastSse('manifest_updated', { key, manifest, timestamp: Date.now() });
  broadcastSse('ledger_updated', { timestamp: Date.now() });
  broadcastSse('sponsorships_updated', { timestamp: Date.now() });

  res.json({ success: true, manifest });
});

// Vehicle Draft Update
app.post('/api/manifests/:key/draft', (req, res) => {
  const key = req.params.key;
  const { vehicleId, draftState, repName, licensePlate, fullVehicle, manifest: incomingManifest } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }

  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  const manifest = readJsonFile<{
    date: string;
    signups: unknown[];
    vehicles: Array<{ id: string; name?: string; type?: string; riders?: unknown[]; repName?: string; licensePlate?: string; draftState?: unknown }>;
    updated_at?: string;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const nowIso = new Date().toISOString();

  // If server manifest file is empty or missing vehicles, seed from incoming manifest or fullVehicle
  if ((!manifest.vehicles || manifest.vehicles.length === 0)) {
    if (incomingManifest && Array.isArray(incomingManifest.vehicles) && incomingManifest.vehicles.length > 0) {
      manifest.vehicles = incomingManifest.vehicles;
      if (Array.isArray(incomingManifest.signups) && incomingManifest.signups.length > 0) {
        manifest.signups = incomingManifest.signups;
      }
    } else if (fullVehicle && typeof fullVehicle === 'object') {
      manifest.vehicles = [fullVehicle];
    }
  }

  let found = false;
  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (String(v.id) === String(vehicleId)) {
      found = true;
      return {
        ...v,
        repName: repName !== undefined ? repName : v.repName,
        licensePlate: licensePlate !== undefined ? licensePlate : v.licensePlate,
        draftState: draftState !== undefined ? draftState : v.draftState,
      };
    }
    return v;
  });

  // If vehicle wasn't found in list but fullVehicle was supplied, append it
  if (!found && fullVehicle && typeof fullVehicle === 'object') {
    manifest.vehicles.push({
      ...fullVehicle,
      repName: repName !== undefined ? repName : fullVehicle.repName,
      licensePlate: licensePlate !== undefined ? licensePlate : fullVehicle.licensePlate,
      draftState: draftState !== undefined ? draftState : fullVehicle.draftState,
    });
  }

  manifest.updated_at = nowIso;
  atomicWriteJson(filePath, manifest);

  broadcastSse('vehicle_draft_delta', { key, vehicleId, draftState, repName, licensePlate, timestamp: Date.now() });

  res.json({ success: true, manifest });
});

// Broadcast fine-grained live actions (attendance toggles, sponsorship clicks, didn't pay clicks)
app.post('/api/sync/live-action', (req, res) => {
  const action = req.body;
  if (action && typeof action === 'object') {
    broadcastSse('live_action', action);
  }
  res.json({ success: true });
});

// ----------------------------------------------------
// LEDGER API
// ----------------------------------------------------

// Helper to convert any flexible date into YYYY-MM-DD
function normalizeDateToYMD(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = String(dateStr).trim();
  const ymdMatch = trimmed.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  const dmyMatch = trimmed.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      if (year >= 2000 && year <= 2100) {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${m}-${day}`;
      }
    }
  } catch {
    /* ignore */
  }
  return trimmed.split('_')[0];
}

// Helper to clean slug/synthetic names like "Passenger bonolo-ngejane-dfc-bus-stop" into "Bonolo Ngejane"
function sanitizePassengerDisplayName(rawName: string): string {
  if (!rawName) return '';
  let name = rawName.trim();

  if (/^passenger\s+/i.test(name)) {
    name = name.replace(/^passenger\s+/i, '').trim();
  }

  // Strip parenthetical badges or tags like (Bus), (DFC), [SZ 1]
  name = name.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, ' ').trim();

  if (/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(name)) {
    const stopSlugs = [
      '-dfc-bus-stop', '-dfc', '-sunnyside', '-amic-deck', '-david-webster',
      '-barnato', '-midrand', '-braamfontein', '-auckland-park', '-kingsway',
      '-bunting-road', '-soweto', '-park-station', '-parktown'
    ];
    let cleanedSlug = name;
    for (const slug of stopSlugs) {
      if (cleanedSlug.toLowerCase().endsWith(slug)) {
        cleanedSlug = cleanedSlug.slice(0, -slug.length);
        break;
      }
    }
    name = cleanedSlug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  // Strip trailing stop notes like " - DFC Bus Stop"
  name = name.replace(/\s*-\s*(?:dfc|amic|sunnyside|kingsway|bunting|midrand|soweto|barnato|park).*$/i, '').trim();
  name = name.replace(/\s+/g, ' ').trim();

  return name;
}

// Helper to normalize structure codes
function normalizeStructureCode(raw: string | null | undefined): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'No Structure';

  const lower = trimmed.toLowerCase();

  // 1. Unidentified variants
  if (
    lower === 'unidentified' ||
    lower === 'sunidentified' ||
    lower === 's-unidentified' ||
    lower === 's_unidentified' ||
    lower === 'unassigned'
  ) {
    return 'Unidentified';
  }

  // 2. No Structure variants
  if (
    lower === 'no structure' ||
    lower === 'none' ||
    lower === 'no struct' ||
    lower === 'nostructure' ||
    lower === 'unknown'
  ) {
    return 'No Structure';
  }

  // 3. FTV structures
  if (lower === 'ftv' || lower === 'ftv 20' || lower === 'ftv20' || lower === 'ftv-20') {
    return 'FTV 20';
  }

  // 4. Standard S structures (e.g. S1, S2, S15, S2B)
  const sMatch = trimmed.match(/^s\s*(\d+[a-z]?)$/i);
  if (sMatch) {
    return `S${sMatch[1].toUpperCase()}`;
  }

  // 5. YZ structures (e.g. YZ1, YZ12)
  const yzMatch = trimmed.match(/^yz\s*(\d+[a-z]?)$/i);
  if (yzMatch) {
    return `YZ${yzMatch[1].toUpperCase()}`;
  }

  // 6. Bare numbers entered by user (e.g. "1" -> "S1", "14" -> "S14")
  if (/^\d+[a-z]?$/i.test(trimmed)) {
    return `S${trimmed.toUpperCase()}`;
  }

  // 7. "Structure 1" or "Structure S1" -> "S1"
  const structWord = trimmed.match(/^Structure\s*(S?\d+[a-z]?)$/i);
  if (structWord) {
    const num = structWord[1].toUpperCase();
    return num.startsWith('S') ? num : `S${num}`;
  }

  // 8. Accidental 's' prefix on other non-numeric words
  if (lower.startsWith('s') && lower.slice(1) === 'unidentified') {
    return 'Unidentified';
  }

  return trimmed;
}

// DreamWeek date bounds: ONLY Tue 29 Sep 2026 to Fri 2 Oct 2026 inclusive (R45 per trip)
const DREAMWEEK_START = '2026-09-29';
const DREAMWEEK_END = '2026-10-02';

function isDreamWeekDate(dateStr?: string | null): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return false;
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  return normalized >= DREAMWEEK_START && normalized <= DREAMWEEK_END;
}

function getFareForDate(dateStr?: string | null): number {
  return isDreamWeekDate(dateStr) ? 45 : 40;
}

// Helper to safely parse debt amount
function parseDebtAmount(val: unknown, dateStr?: string | null): number {
  const fallback = dateStr ? getFareForDate(dateStr) : 40;
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'number') {
    if (isNaN(val)) return fallback;
    return val;
  }
  const str = String(val).trim();
  if (!str) return fallback;
  if (str === '0' || str === 'R0' || str === 'R 0' || str === '0.00' || str === 'R0.00') return 0;
  const numStr = str.replace(/[^\d.]/g, '');
  if (!numStr) return fallback;
  const parsed = Number(numStr);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Record reported sponsorships from attendance check-in or transfers
app.post('/api/ledger/sponsorships', (req, res) => {
  const { sponsorships } = req.body || {};
  if (Array.isArray(sponsorships) && sponsorships.length > 0) {
    const audits = readJsonFile<Array<{
      id: string;
      manifest_key: string;
      date: string;
      service: string;
      passenger_id?: string;
      passenger_name: string;
      structure: string;
      stop?: string;
      vehicle_name: string;
      rep_name: string;
      sponsor_note: string;
      status: 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';
      status_updated_at?: string;
      ledger_entry_id?: string;
      submitted_at: string;
    }>>(SPONSORSHIPS_FILE, []);

    for (const sp of sponsorships) {
      const rawName = sp.passenger_name || sp.fullName;
      if (!rawName) continue;
      const cleanName = sanitizePassengerDisplayName(rawName);
      if (!cleanName) continue;
      const baseDate = normalizeDateToYMD(sp.date || sp.manifest_key);
      const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const auditId = sp.id || `sp_${baseDate}_${normName}`;
      const cleanNote = cleanSponsorshipNote(sp.sponsor_note ?? sp.sponsorNote);

      const existingIdx = audits.findIndex((a) => {
        if (a.id && (a.id === auditId || a.id === `sp_${normName}`)) return true;
        if (sp.passenger_id && a.passenger_id && String(sp.passenger_id) === String(a.passenger_id)) return true;
        const aDate = normalizeDateToYMD(a.date || a.manifest_key);
        const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return aName === normName && (!baseDate || !aDate || aDate === baseDate);
      });

      if (existingIdx >= 0) {
        audits[existingIdx] = {
          ...audits[existingIdx],
          passenger_name: cleanName,
          structure: sp.structure || audits[existingIdx].structure,
          stop: sp.stop || audits[existingIdx].stop,
          vehicle_name: sp.vehicle_name || audits[existingIdx].vehicle_name,
          rep_name: sp.rep_name || audits[existingIdx].rep_name,
          sponsor_note: cleanNote || audits[existingIdx].sponsor_note,
        };
      } else {
        audits.push({
          id: auditId,
          manifest_key: sp.manifest_key || '',
          date: sp.date || baseDate,
          service: sp.service || 'Service',
          passenger_id: sp.passenger_id || sp.id,
          passenger_name: cleanName,
          structure: sp.structure || '',
          stop: sp.stop || '',
          vehicle_name: sp.vehicle_name || 'Vehicle',
          rep_name: sp.rep_name || 'Rep',
          sponsor_note: cleanNote,
          status: sp.status || 'pending',
          submitted_at: sp.submitted_at || new Date().toISOString(),
        });
      }
    }

    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }
  res.json({ success: true });
});

// List reported sponsorships for cancellation admin audit
app.get('/api/ledger/sponsorships', (req, res) => {
  let audits = readJsonFile<Array<{
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_id?: string;
    passenger_name: string;
    structure: string;
    stop?: string;
    vehicle_name: string;
    rep_name: string;
    sponsor_note: string;
    status: 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';
    status_updated_at?: string;
    ledger_entry_id?: string;
    submitted_at: string;
  }>>(SPONSORSHIPS_FILE, []);

  // Auto-scan manifests to find any sponsored passengers
  // so all existing historical and in-progress sponsorship data is instantly visible
  try {
    const files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
    let addedCount = 0;
    for (const file of files) {
      const key = file.replace(/\.json$/, '');
      const m = readJsonFile<{
        date?: string;
        signups?: Array<{ id: string; fullName: string; structure?: string; stop?: string; sponsored?: boolean; sponsorNote?: string }>;
        vehicles?: Array<{
          id: string;
          name: string;
          submitted?: boolean;
          repName?: string;
          submittedBy?: string;
          riders?: string[];
          draftState?: { sponsoredIds?: string[]; notes?: Record<string, string> };
        }>;
      }>(path.join(MANIFESTS_DIR, file), {});

      for (const v of m.vehicles || []) {
        const vehicleRiderIds = new Set((v.riders || []).map(String));
        const sponIds = new Set((v.draftState?.sponsoredIds || []).map(String));
        const sponNotes = v.draftState?.notes || {};
        const signups = (m.signups || []).filter((s) => vehicleRiderIds.has(String(s.id)));
        for (const s of signups) {
          const sId = String(s.id);
          if (sponIds.has(sId) || s.sponsored) {
            const cleanName = sanitizePassengerDisplayName(s.fullName || '');
            if (!cleanName) continue;
            const baseDate = normalizeDateToYMD(m.date || key);
            const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const auditId = `sp_${baseDate}_${normName}`;
            const exists = audits.some((a) => {
              const aDate = normalizeDateToYMD(a.date || a.manifest_key);
              const isSameDate = (!baseDate && !aDate) || (baseDate && aDate && baseDate === aDate) || (a.manifest_key === key);
              if (!isSameDate) return false;

              if (a.id && a.id === auditId) return true;
              if (s.id && a.passenger_id && String(s.id) === String(a.passenger_id)) return true;
              const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
              return aName === normName;
            });
            if (!exists) {
              audits.push({
                id: auditId,
                manifest_key: key,
                date: m.date || key,
                service: 'Service',
                passenger_id: s.id,
                passenger_name: cleanName,
                structure: s.structure || '',
                stop: s.stop || '',
                vehicle_name: v.name,
                rep_name: v.repName || v.submittedBy || 'Rep',
                sponsor_note: cleanSponsorshipNote(sponNotes[s.id] ?? s.sponsorNote),
                status: 'pending',
                submitted_at: new Date().toISOString(),
              });
              addedCount++;
            }
          }
        }

        // Also scan external cross-taxi sponsees in draftState
        const extSponsees = Array.isArray(v.draftState?.externalSponsees)
          ? (v.draftState.externalSponsees as Array<{ sponseeId?: string; sponseeName?: string; taxiName?: string; payerName?: string; note?: string }>)
          : [];
        for (const ext of extSponsees) {
          if (!ext.sponseeName || !ext.sponseeName.trim()) continue;
          const cleanName = sanitizePassengerDisplayName(ext.sponseeName);
          if (!cleanName) continue;
          const baseDate = normalizeDateToYMD(m.date || key);
          const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const auditId = `sp_${baseDate}_${normName}`;
          const matchedSignup = (m.signups || []).find((p) => p.fullName.toLowerCase() === ext.sponseeName?.toLowerCase());
          const exists = audits.some((a) => {
            const aDate = normalizeDateToYMD(a.date || a.manifest_key);
            const isSameDate = (!baseDate && !aDate) || (baseDate && aDate && baseDate === aDate) || (a.manifest_key === key);
            if (!isSameDate) return false;

            if (a.id && a.id === auditId) return true;
            if (ext.sponseeId && a.passenger_id && String(ext.sponseeId) === String(a.passenger_id)) return true;
            const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            return aName === normName;
          });
          if (!exists) {
            audits.push({
              id: auditId,
              manifest_key: key,
              date: m.date || key,
              service: 'Service',
              passenger_id: ext.sponseeId || (matchedSignup ? String(matchedSignup.id) : undefined),
              passenger_name: cleanName,
              structure: (matchedSignup as { structure?: string })?.structure || '',
              stop: (matchedSignup as { stop?: string })?.stop || '',
              vehicle_name: ext.taxiName || v.name,
              rep_name: v.repName || v.submittedBy || 'Rep',
              sponsor_note: cleanSponsorshipNote(ext.note || `Paid by ${ext.payerName || 'Rider'} in ${v.name}`),
              status: 'pending',
              submitted_at: new Date().toISOString(),
            });
            addedCount++;
          }
        }
      }

      // Also scan all signups directly for any passengers marked sponsored
      for (const s of m.signups || []) {
        if (s.sponsored) {
          const cleanName = sanitizePassengerDisplayName(s.fullName || '');
          if (!cleanName) continue;
          const baseDate = normalizeDateToYMD(m.date || key);
          const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const auditId = `sp_${baseDate}_${normName}`;
          const exists = audits.some((a) => {
            const aDate = normalizeDateToYMD(a.date || a.manifest_key);
            const isSameDate = (!baseDate && !aDate) || (baseDate && aDate && baseDate === aDate) || (a.manifest_key === key);
            if (!isSameDate) return false;

            if (a.id && a.id === auditId) return true;
            if (s.id && a.passenger_id && String(s.id) === String(a.passenger_id)) return true;
            const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            return aName === normName;
          });
          if (!exists) {
            audits.push({
              id: auditId,
              manifest_key: key,
              date: m.date || key,
              service: 'Service',
              passenger_id: s.id,
              passenger_name: cleanName,
              structure: s.structure || '',
              stop: s.stop || '',
              vehicle_name: 'Vehicle',
              rep_name: 'Rep',
              sponsor_note: cleanSponsorshipNote(s.sponsorNote),
              status: 'pending',
              submitted_at: new Date().toISOString(),
            });
            addedCount++;
          }
        }
      }
    }
    if (addedCount > 0) {
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
    }
  } catch (err) {
    console.warn('[Server] Manifest scan for sponsorships note:', err);
  }

  // Deduplicate and sanitize records strictly by session date and passenger name
  const deduped: typeof audits = [];
  for (const a of audits) {
    const cleanName = sanitizePassengerDisplayName(a.passenger_name);
    if (!cleanName) continue;
    const baseDate = normalizeDateToYMD(a.date || a.manifest_key);
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');

    const existingIdx = deduped.findIndex((existing) => {
      const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
      const isSameDate = (!baseDate && !existDate) || (baseDate && existDate && baseDate === existDate) || (a.manifest_key && existing.manifest_key && a.manifest_key === existing.manifest_key);
      if (!isSameDate) return false;

      if (a.id && existing.id && a.id === existing.id) return true;
      if (a.passenger_id && existing.passenger_id && String(a.passenger_id) === String(existing.passenger_id)) {
        return true;
      }
      const existNormName = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return existNormName === normName;
    });

    const cleanedSponsorNote = cleanSponsorshipNote(a.sponsor_note);

    if (existingIdx >= 0) {
      deduped[existingIdx] = {
        ...deduped[existingIdx],
        passenger_name: cleanName,
        structure: deduped[existingIdx].structure || a.structure,
        stop: deduped[existingIdx].stop || a.stop,
        vehicle_name: deduped[existingIdx].vehicle_name || a.vehicle_name,
        rep_name: deduped[existingIdx].rep_name || a.rep_name,
        sponsor_note: cleanSponsorshipNote(deduped[existingIdx].sponsor_note) || cleanedSponsorNote,
        status: deduped[existingIdx].status !== 'pending' ? deduped[existingIdx].status : a.status,
      };
    } else {
      deduped.push({
        ...a,
        passenger_name: cleanName,
        sponsor_note: cleanedSponsorNote,
        date: baseDate || a.date,
      });
    }
  }

  audits = deduped;
  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  // Sort: newest first
  audits.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
  res.json(audits);
});

// Helper to strip boilerplate and vehicle notes from sponsorship notes
function cleanSponsorshipNote(note?: unknown): string {
  if (!note || typeof note !== 'string') return '';
  let trimmed = note.trim();
  if (!trimmed) return '';

  if (/^actually\s*sponsored$/i.test(trimmed)) return '';
  if (/^pending\s*verification$/i.test(trimmed)) return '';
  if (/^(?:(?:from|in)\s+)?(?:taxi|vehicle|bus)\s*\d+$/i.test(trimmed)) return '';
  if (/^vehicle:\s*.*$/i.test(trimmed)) return '';

  // Strip vehicle mentions like "(Taxi 1)", "(from Taxi 2)", "(in Vehicle 3)", "(Bus 4)"
  trimmed = trimmed.replace(/\s*\((?:(?:from|in)\s+)?(?:taxi|vehicle|bus)(?:\s*\d+)?(?:\s*-[^)]*)?\)/gi, '').trim();

  // Strip "in/from Taxi X" or "in/from Vehicle X"
  trimmed = trimmed.replace(/\s*(?:(?:from|in)\s+)(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();

  // Strip " - Taxi X" or "Taxi X - "
  trimmed = trimmed.replace(/\s*[-–—]\s*(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();
  trimmed = trimmed.replace(/^(?:taxi|vehicle|bus)\s*\d+\s*[-–—:]\s*/gi, '').trim();

  // Strip general notes boilerplate if accidental full notes got attached
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations)[^;.]*(?:[;.]|$)/gi, '').trim();

  if (/^(?:(?:from|in)\s+)?(?:taxi|vehicle|bus)\s*\d+$/i.test(trimmed)) return '';

  return trimmed;
}

// Verify sponsorship status (cancellation admin action)
app.post('/api/ledger/verify-sponsorship', (req, res) => {
  const { sponsorshipId, status } = req.body || {};
  if (!sponsorshipId || !status) {
    res.status(400).json({ error: 'sponsorshipId and status are required' });
    return;
  }

  interface AuditItem {
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_id?: string;
    passenger_name: string;
    structure: string;
    stop?: string;
    vehicle_name: string;
    rep_name: string;
    sponsor_note: string;
    status: 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';
    status_updated_at?: string;
    ledger_entry_id?: string | null;
    submitted_at: string;
  }

  interface LedgerItem {
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_name: string;
    stop: string;
    structure: string;
    vehicle_name: string;
    submitted_by: string;
    rep_name: string;
    license_plate: string;
    sponsored: boolean;
    sponsor_note: string;
    structure_debt: number;
    general_notes: string;
    submitted_at: string;
  }

  const audits = readJsonFile<AuditItem[]>(SPONSORSHIPS_FILE, []);
  let sponIndex = audits.findIndex((a) => a.id === sponsorshipId);
  if (sponIndex < 0) {
    const cleanReqId = String(sponsorshipId).toLowerCase();
    sponIndex = audits.findIndex((a) => {
      if (cleanReqId.includes(a.id.toLowerCase()) || a.id.toLowerCase().includes(cleanReqId)) return true;
      const aBase = (a.date || a.manifest_key || '').split('_')[0];
      const aNorm = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return aNorm && cleanReqId.includes(aNorm) && (cleanReqId.includes(aBase) || cleanReqId.includes(a.manifest_key.toLowerCase()));
    });
  }

  const incomingSingleSpon = req.body?.sponsorship;
  if (sponIndex < 0 && incomingSingleSpon) {
    const newSingleAudit: AuditItem = {
      id: incomingSingleSpon.id || sponsorshipId,
      manifest_key: incomingSingleSpon.manifest_key || '',
      date: incomingSingleSpon.date || '',
      service: incomingSingleSpon.service || 'Service',
      passenger_id: incomingSingleSpon.passenger_id || '',
      passenger_name: incomingSingleSpon.passenger_name || '',
      structure: incomingSingleSpon.structure || '',
      stop: incomingSingleSpon.stop || '',
      vehicle_name: incomingSingleSpon.vehicle_name || '',
      rep_name: incomingSingleSpon.rep_name || '',
      sponsor_note: incomingSingleSpon.sponsor_note || '',
      status: status,
      status_updated_at: new Date().toISOString(),
      ledger_entry_id: incomingSingleSpon.ledger_entry_id || null,
      submitted_at: incomingSingleSpon.submitted_at || new Date().toISOString(),
    };
    audits.push(newSingleAudit);
    sponIndex = audits.length - 1;
  }

  if (sponIndex < 0) {
    res.status(404).json({ error: 'Sponsorship record not found' });
    return;
  }

  const spon = audits[sponIndex];
  spon.status = status;
  spon.status_updated_at = new Date().toISOString();

  let ledger = readJsonFile<LedgerItem[]>(LEDGER_FILE, []);
  let ledgerChanged = false;

  if (status === 'unpaid_sponsorship' || status === 'unaccounted_sponsorship') {
    const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
    const noteText = status === 'unaccounted_sponsorship'
      ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
      : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));

    // Check if debt entry already exists for this sponsorship
    const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
    const existingLedgerIdx = ledger.findIndex((e) =>
      (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
      (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored))
    );

    const auditDebt = getFareForDate(spon.date);
    if (existingLedgerIdx >= 0) {
      ledger[existingLedgerIdx].general_notes = noteText;
      ledger[existingLedgerIdx].sponsor_note = noteText;
      ledger[existingLedgerIdx].sponsored = true;
      ledger[existingLedgerIdx].structure_debt = auditDebt;
      ledger[existingLedgerIdx].structure = normalizeStructureCode(spon.structure);
      ledger[existingLedgerIdx].submitted_by = 'Cancellation Admin';
      ledger[existingLedgerIdx].source = 'reported_sponsorship_audit';
      spon.ledger_entry_id = ledger[existingLedgerIdx].id;
      ledgerChanged = true;
    } else {
      const newEntryId = spon.ledger_entry_id || `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newEntry = {
        id: newEntryId,
        manifest_key: spon.manifest_key || `manual-${Date.now()}`,
        date: normalizeDateToYMD(spon.date) || spon.date,
        service: spon.service || 'Service',
        passenger_name: sanitizePassengerDisplayName(spon.passenger_name),
        stop: spon.stop || '',
        structure: normalizeStructureCode(spon.structure),
        vehicle_name: spon.vehicle_name || '—',
        submitted_by: 'Cancellation Admin',
        rep_name: spon.rep_name || '',
        license_plate: '',
        sponsored: true,
        sponsor_note: noteText,
        structure_debt: auditDebt,
        general_notes: noteText,
        source: 'reported_sponsorship_audit',
        submitted_at: new Date().toISOString(),
      };
      ledger.unshift(newEntry);
      spon.ledger_entry_id = newEntryId;
      ledgerChanged = true;
    }
  } else if (status === 'actually_sponsored' || status === 'pending') {
    // If they are actually sponsored, nothing else happens, so clear any debt entry!
    if (spon.ledger_entry_id) {
      ledger = ledger.filter((e) => e.id !== spon.ledger_entry_id);
      spon.ledger_entry_id = null;
      ledgerChanged = true;
    } else {
      const beforeLen = ledger.length;
      const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
      ledger = ledger.filter((e) => !(e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored)));
      if (ledger.length !== beforeLen) ledgerChanged = true;
    }
  }

  audits[sponIndex] = spon;
  atomicWriteJson(SPONSORSHIPS_FILE, audits);
  if (ledgerChanged) {
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }
  broadcastSse('sponsorships_updated', { timestamp: Date.now() });

  res.json({ success: true, sponsorship: spon, ledgerUpdated: ledgerChanged });
});

// Batch verify or update reported sponsorships (cancellation admin action)
app.post('/api/ledger/verify-sponsorships-batch', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  interface AuditItem {
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_id?: string;
    passenger_name: string;
    structure: string;
    stop?: string;
    vehicle_name: string;
    rep_name: string;
    sponsor_note: string;
    status: 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';
    status_updated_at?: string;
    ledger_entry_id?: string | null;
    submitted_at: string;
  }

  interface LedgerItem {
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_name: string;
    stop: string;
    structure: string;
    vehicle_name: string;
    submitted_by: string;
    rep_name: string;
    license_plate: string;
    sponsored: boolean;
    sponsor_note: string;
    structure_debt: number;
    general_notes: string;
    submitted_at: string;
  }

  const audits = readJsonFile<AuditItem[]>(SPONSORSHIPS_FILE, []);
  let ledger = readJsonFile<LedgerItem[]>(LEDGER_FILE, []);
  let ledgerChanged = false;
  let updatedCount = 0;
  const now = new Date().toISOString();

  for (const item of items) {
    const { sponsorshipId, status, sponsorship: incomingSpon } = item || {};
    if (!sponsorshipId || !status) continue;

    let sponIndex = audits.findIndex((a) => a.id === sponsorshipId);
    if (sponIndex < 0) {
      const cleanReqId = String(sponsorshipId).toLowerCase();
      sponIndex = audits.findIndex((a) => {
        if (cleanReqId.includes(a.id.toLowerCase()) || a.id.toLowerCase().includes(cleanReqId)) return true;
        const aBase = (a.date || a.manifest_key || '').split('_')[0];
        const aNorm = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return aNorm && cleanReqId.includes(aNorm) && (cleanReqId.includes(aBase) || cleanReqId.includes(a.manifest_key.toLowerCase()));
      });
    }

    if (sponIndex < 0 && incomingSpon) {
      const newAudit: AuditItem = {
        id: incomingSpon.id || sponsorshipId,
        manifest_key: incomingSpon.manifest_key || '',
        date: incomingSpon.date || '',
        service: incomingSpon.service || 'Service',
        passenger_id: incomingSpon.passenger_id || '',
        passenger_name: incomingSpon.passenger_name || '',
        structure: incomingSpon.structure || '',
        stop: incomingSpon.stop || '',
        vehicle_name: incomingSpon.vehicle_name || '',
        rep_name: incomingSpon.rep_name || '',
        sponsor_note: incomingSpon.sponsor_note || '',
        status: status,
        status_updated_at: now,
        ledger_entry_id: incomingSpon.ledger_entry_id || null,
        submitted_at: incomingSpon.submitted_at || now,
      };
      audits.push(newAudit);
      sponIndex = audits.length - 1;
    }

    if (sponIndex < 0) continue;
    const spon = audits[sponIndex];
    spon.status = status;
    spon.status_updated_at = now;

    if (status === 'unpaid_sponsorship' || status === 'unaccounted_sponsorship') {
      const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
      const noteText = status === 'unaccounted_sponsorship'
        ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
        : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));
      const batchAuditDebt = getFareForDate(spon.date);
      const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();

      const existingLedgerIdx = ledger.findIndex((e) =>
        (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
        (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored))
      );

      if (existingLedgerIdx >= 0) {
        ledger[existingLedgerIdx].general_notes = noteText;
        ledger[existingLedgerIdx].sponsor_note = noteText;
        ledger[existingLedgerIdx].sponsored = true;
        ledger[existingLedgerIdx].structure_debt = batchAuditDebt;
        ledger[existingLedgerIdx].structure = normalizeStructureCode(spon.structure);
        ledger[existingLedgerIdx].submitted_by = 'Cancellation Admin';
        ledger[existingLedgerIdx].source = 'reported_sponsorship_audit';
        spon.ledger_entry_id = ledger[existingLedgerIdx].id;
        ledgerChanged = true;
      } else {
        const newEntryId = spon.ledger_entry_id || `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        ledger.unshift({
          id: newEntryId,
          manifest_key: spon.manifest_key || `manual-${Date.now()}`,
          date: normalizeDateToYMD(spon.date) || spon.date,
          service: spon.service || 'Service',
          passenger_name: sanitizePassengerDisplayName(spon.passenger_name),
          stop: spon.stop || '',
          structure: normalizeStructureCode(spon.structure),
          vehicle_name: spon.vehicle_name || '—',
          submitted_by: 'Cancellation Admin',
          rep_name: spon.rep_name || '',
          license_plate: '',
          sponsored: true,
          sponsor_note: noteText,
          structure_debt: batchAuditDebt,
          general_notes: noteText,
          source: 'reported_sponsorship_audit',
          submitted_at: now,
        });
        spon.ledger_entry_id = newEntryId;
        ledgerChanged = true;
      }
    } else if (status === 'actually_sponsored' || status === 'pending') {
      if (spon.ledger_entry_id) {
        ledger = ledger.filter((e) => e.id !== spon.ledger_entry_id);
        spon.ledger_entry_id = null;
        ledgerChanged = true;
      } else {
        const beforeLen = ledger.length;
        const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
        ledger = ledger.filter((e) => !(e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored)));
        if (ledger.length !== beforeLen) ledgerChanged = true;
      }
    }

    audits[sponIndex] = spon;
    updatedCount++;
  }

  if (updatedCount > 0) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    if (ledgerChanged) {
      atomicWriteJson(LEDGER_FILE, ledger);
      broadcastSse('ledger_updated', { timestamp: Date.now() });
    }
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  res.json({ success: true, updatedCount, ledgerUpdated: ledgerChanged });
});

// Delete a reported sponsorship and remove any corresponding debt entry
app.delete('/api/ledger/sponsorships/:id', (req, res) => {
  const id = req.params.id;
  let audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const spon = audits.find((a) => a.id === id);
  if (!spon) {
    res.status(404).json({ error: 'Sponsorship record not found' });
    return;
  }

  audits = audits.filter((a) => a.id !== id);
  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  // Remove any associated debt entry from ledger
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const beforeLen = ledger.length;
  const cleanName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase();

  ledger = ledger.filter((e) => {
    if (spon.ledger_entry_id && e.id === spon.ledger_entry_id) return false;
    if (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === cleanName && Boolean(e.sponsored)) {
      return false;
    }
    return true;
  });

  let ledgerChanged = false;
  if (ledger.length !== beforeLen) {
    ledgerChanged = true;
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }

  broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  res.json({ success: true, removedId: id, ledgerChanged });
});

// Batch delete reported sponsorships
app.post('/api/ledger/sponsorships/batch-delete', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' });
    return;
  }
  const idSet = new Set(ids.map(String));
  let audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const toDelete = audits.filter((a) => idSet.has(String(a.id)));
  audits = audits.filter((a) => !idSet.has(String(a.id)));
  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const beforeLen = ledger.length;
  for (const spon of toDelete) {
    const cleanName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase();
    ledger = ledger.filter((e) => {
      if (spon.ledger_entry_id && e.id === spon.ledger_entry_id) return false;
      if (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === cleanName && Boolean(e.sponsored)) {
        return false;
      }
      return true;
    });
  }

  let ledgerChanged = false;
  if (ledger.length !== beforeLen) {
    ledgerChanged = true;
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }

  broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  res.json({ success: true, count: toDelete.length, ledgerChanged });
});

// Record payment for a reported sponsorship
app.post('/api/ledger/sponsorships/:id/pay', (req, res) => {
  const id = req.params.id;
  const { amount, notes } = req.body || {};
  const payAmt = Number(amount);
  if (!Number.isFinite(payAmt) || payAmt <= 0) {
    res.status(400).json({ error: 'A valid positive payment amount is required' });
    return;
  }

  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const sponIndex = audits.findIndex((a) => a.id === id);
  if (sponIndex === -1) {
    res.status(404).json({ error: 'Sponsorship record not found' });
    return;
  }

  const spon = audits[sponIndex];
  const dateStr = String(spon.date || '');
  const totalDebt = getFareForDate(dateStr);
  const now = new Date().toISOString();
  const payNote = notes ? String(notes).trim() : `Paid R${payAmt} on ${now.slice(0, 10)}`;

  const ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  let ledgerChanged = false;
  const cleanName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase();

  const entryIdx = ledger.findIndex((e) =>
    (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
    (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === cleanName && Boolean(e.sponsored))
  );

  if (payAmt >= totalDebt || entryIdx === -1) {
    // Fully settled / paid
    spon.status = 'actually_sponsored';
    spon.status_updated_at = now;
    spon.sponsor_note = spon.sponsor_note ? `${spon.sponsor_note} (Settled: ${payNote})` : `Settled: ${payNote}`;
    spon.ledger_entry_id = null;

    if (entryIdx >= 0) {
      ledger.splice(entryIdx, 1);
      ledgerChanged = true;
    }
  } else {
    // Partial payment
    const remainingDebt = totalDebt - payAmt;
    spon.sponsor_note = spon.sponsor_note ? `${spon.sponsor_note} (Partially paid R${payAmt}, owing R${remainingDebt})` : `Partially paid R${payAmt}, owing R${remainingDebt}`;
    spon.status_updated_at = now;

    if (entryIdx >= 0) {
      ledger[entryIdx].structure_debt = remainingDebt;
      ledger[entryIdx].general_notes = `${ledger[entryIdx].general_notes || ''} (Paid R${payAmt})`;
      ledgerChanged = true;
    }
  }

  audits[sponIndex] = spon;
  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  if (ledgerChanged) {
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }

  broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  res.json({ success: true, sponsorship: spon, ledgerChanged });
});

// Update / Edit a reported sponsorship
app.patch('/api/ledger/sponsorships/:id', (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};

  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const sponIndex = audits.findIndex((a) => a.id === id);
  if (sponIndex === -1) {
    res.status(404).json({ error: 'Sponsorship record not found' });
    return;
  }

  const spon = audits[sponIndex];
  const origCleanName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase();

  if (updates.passenger_name !== undefined) spon.passenger_name = sanitizePassengerDisplayName(String(updates.passenger_name));
  if (updates.structure !== undefined) spon.structure = normalizeStructureCode(String(updates.structure));
  if (updates.date !== undefined) spon.date = normalizeDateToYMD(String(updates.date)) || String(updates.date);
  if (updates.service !== undefined) spon.service = String(updates.service);
  if (updates.stop !== undefined) spon.stop = String(updates.stop);
  if (updates.vehicle_name !== undefined) spon.vehicle_name = String(updates.vehicle_name);
  if (updates.rep_name !== undefined) spon.rep_name = String(updates.rep_name);
  if (updates.sponsor_note !== undefined) spon.sponsor_note = cleanSponsorshipNote(String(updates.sponsor_note));
  if (updates.status !== undefined) {
    spon.status = updates.status;
    spon.status_updated_at = new Date().toISOString();
  }

  const ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  let ledgerChanged = false;

  const entryIdx = ledger.findIndex((e) =>
    (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
    (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === origCleanName && Boolean(e.sponsored))
  );

  const customDebt = updates.debtAmount !== undefined && Number(updates.debtAmount) > 0
    ? Number(updates.debtAmount)
    : getFareForDate(String(spon.date));

  if (spon.status === 'unaccounted_sponsorship' || spon.status === 'unpaid_sponsorship') {
    const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
    const noteText = spon.status === 'unaccounted_sponsorship'
      ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
      : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));

    if (entryIdx >= 0) {
      ledger[entryIdx].passenger_name = spon.passenger_name;
      ledger[entryIdx].structure = spon.structure;
      ledger[entryIdx].date = spon.date;
      ledger[entryIdx].service = spon.service;
      ledger[entryIdx].stop = spon.stop || '';
      ledger[entryIdx].structure_debt = customDebt;
      ledger[entryIdx].sponsor_note = noteText;
      ledger[entryIdx].general_notes = noteText;
      ledger[entryIdx].sponsored = true;
      spon.ledger_entry_id = ledger[entryIdx].id;
      ledgerChanged = true;
    } else {
      const newEntryId = spon.ledger_entry_id || `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      ledger.unshift({
        id: newEntryId,
        manifest_key: spon.manifest_key || `manual-${Date.now()}`,
        date: spon.date,
        service: spon.service,
        passenger_name: spon.passenger_name,
        stop: spon.stop || '',
        structure: spon.structure,
        vehicle_name: spon.vehicle_name || '—',
        submitted_by: 'Cancellation Admin',
        rep_name: spon.rep_name || '',
        license_plate: '',
        sponsored: true,
        sponsor_note: noteText,
        structure_debt: customDebt,
        general_notes: noteText,
        source: 'reported_sponsorship_audit',
        submitted_at: new Date().toISOString(),
      });
      spon.ledger_entry_id = newEntryId;
      ledgerChanged = true;
    }
  } else if (spon.status === 'actually_sponsored' || spon.status === 'pending') {
    if (entryIdx >= 0) {
      ledger.splice(entryIdx, 1);
      spon.ledger_entry_id = null;
      ledgerChanged = true;
    }
  }

  audits[sponIndex] = spon;
  atomicWriteJson(SPONSORSHIPS_FILE, audits);

  if (ledgerChanged) {
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }

  broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  res.json({ success: true, sponsorship: spon, ledgerChanged });
});

// List all ledger entries
app.get('/api/ledger', (req, res) => {
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  let dirty = false;

  // Reconcile any confirmed unaccounted sponsorships or unpaid sponsorships from audits
  const audits = readJsonFile<Array<{
    id: string;
    manifest_key: string;
    date: string;
    service: string;
    passenger_name: string;
    structure: string;
    stop?: string;
    vehicle_name: string;
    rep_name: string;
    sponsor_note: string;
    status: string;
    submitted_at: string;
    ledger_entry_id?: string | null;
  }>>(SPONSORSHIPS_FILE, []);

  for (const spon of audits) {
    if (spon.status === 'unaccounted_sponsorship' || spon.status === 'unpaid_sponsorship') {
      const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
      const hasEntry = ledger.some((e) =>
        (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
        (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name as string).toLowerCase() === cleanSponName && Boolean(e.sponsored))
      );
      if (!hasEntry) {
        const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
        const noteText = spon.status === 'unaccounted_sponsorship'
          ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
          : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));
        const auditDebt = getFareForDate(spon.date);
        const newId = spon.ledger_entry_id || `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        ledger.unshift({
          id: newId,
          manifest_key: spon.manifest_key || `manual-${Date.now()}`,
          date: normalizeDateToYMD(spon.date) || spon.date,
          service: spon.service || 'Service',
          passenger_name: sanitizePassengerDisplayName(spon.passenger_name),
          stop: spon.stop || '',
          structure: normalizeStructureCode(spon.structure),
          vehicle_name: spon.vehicle_name || '—',
          submitted_by: 'Cancellation Admin',
          rep_name: spon.rep_name || '',
          license_plate: '',
          sponsored: true,
          sponsor_note: noteText,
          structure_debt: auditDebt,
          general_notes: noteText,
          source: 'reported_sponsorship_audit',
          submitted_at: spon.submitted_at || new Date().toISOString(),
        });
        dirty = true;
      }
    }
  }

  // Filter out zero-debt items, parse numeric debt, and sanitize boilerplate notes
  const activeLedger = ledger
    .filter((entry) => {
      let rawVal = entry.structure_debt;
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        rawVal = entry.fee;
      }
      const debt = parseDebtAmount(rawVal, (entry.date as string) || (entry.manifest_key as string));
      return debt > 0;
    })
    .map((entry) => {
      const origGn = typeof entry.general_notes === 'string' ? entry.general_notes : '';
      const origSn = typeof entry.sponsor_note === 'string' ? entry.sponsor_note : '';
      const dt = String(entry.debt_type || entry.debtType || '').toLowerCase();
      const isUnaccOrUnpaid = /unaccounted|did not pay|unpaid/i.test(origGn) ||
        /unaccounted|did not pay|unpaid/i.test(origSn) ||
        dt.includes('sponsorship');
      const isSpon = Boolean(entry.sponsored) || isUnaccOrUnpaid;
      let cleanGn = origGn;
      let cleanSn = origSn;
      let rawVal = entry.structure_debt;
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        rawVal = entry.fee;
      }
      const dateStr = normalizeDateToYMD(entry.date as string) || (entry.manifest_key ? String(entry.manifest_key).split('_')[0] : (entry.date as string) || '');
      const parsedDebt = parseDebtAmount(rawVal, dateStr);

      // If entry is not sponsored, clean out vehicle summaries mentioning other people's sponsorships
      if (!isSpon) {
        cleanSn = '';
        cleanGn = cleanPersonalAbsenteeNote(origGn);
        if (/sponsorship|paid by/i.test(cleanGn)) {
          cleanGn = '';
        }
      } else {
        cleanGn = cleanSponsorshipNote(origGn) || origGn;
        cleanSn = cleanSponsorshipNote(origSn) || origSn;
        if (!cleanSn && !cleanGn) {
          cleanSn = 'Unaccounted Sponsorship';
          cleanGn = 'Unaccounted Sponsorship';
        }
      }

      if (cleanGn !== origGn || cleanSn !== origSn || entry.structure_debt !== parsedDebt || entry.sponsored !== isSpon || entry.date !== dateStr) {
        dirty = true;
        return {
          ...entry,
          date: dateStr,
          sponsored: isSpon,
          structure_debt: parsedDebt,
          general_notes: cleanGn,
          sponsor_note: cleanSn,
        };
      }
      return {
        ...entry,
        date: dateStr,
        structure_debt: parsedDebt,
      };
    });

  if (dirty) {
    ledger = ledger.map((e) => {
      const origGn = typeof e.general_notes === 'string' ? e.general_notes : '';
      const origSn = typeof e.sponsor_note === 'string' ? e.sponsor_note : '';
      const dt = String(e.debt_type || e.debtType || '').toLowerCase();
      const isUnaccOrUnpaid = /unaccounted|did not pay|unpaid/i.test(origGn) ||
        /unaccounted|did not pay|unpaid/i.test(origSn) ||
        dt.includes('sponsorship');
      const isSpon = Boolean(e.sponsored) || isUnaccOrUnpaid;
      let cleanedGn = (!isSpon) ? cleanPersonalAbsenteeNote(origGn) : (cleanSponsorshipNote(origGn) || origGn);
      if (!isSpon && /sponsorship|paid by/i.test(cleanedGn)) {
        cleanedGn = '';
      }
      const cleanedSn = isSpon ? (cleanSponsorshipNote(origSn) || origSn || 'Unaccounted Sponsorship') : '';
      const dateStr = normalizeDateToYMD(e.date as string) || (e.manifest_key ? String(e.manifest_key).split('_')[0] : (e.date as string) || '');
      let rawVal = e.structure_debt;
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        rawVal = e.fee;
      }
      const parsedDebt = parseDebtAmount(rawVal, dateStr);

      return {
        ...e,
        date: dateStr,
        structure_debt: parsedDebt,
        sponsored: isSpon,
        general_notes: cleanedGn,
        sponsor_note: cleanedSn,
      };
    });
    atomicWriteJson(LEDGER_FILE, ledger);
  }

  res.json(activeLedger);
});

// Settle / Delete Ledger Entries
app.post('/api/ledger/settle', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.json({ success: true, count: 0 });
    return;
  }

  const idSet = new Set(ids.map(String));
  let ledger = readJsonFile<Array<{ id: string; passenger_name?: string; manifest_key?: string }>>(LEDGER_FILE, []);
  const beforeCount = ledger.length;
  const settledEntries = ledger.filter((entry) => idSet.has(entry.id));
  ledger = ledger.filter((entry) => !idSet.has(entry.id));
  atomicWriteJson(LEDGER_FILE, ledger);

  // Synchronize with sponsorship audits so settled sponsorships do not resurrect
  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  let auditChanged = false;
  for (const item of settledEntries) {
    const cleanName = sanitizePassengerDisplayName(item.passenger_name || '').toLowerCase();
    for (let i = 0; i < audits.length; i++) {
      const a = audits[i];
      if (
        idSet.has(String(a.ledger_entry_id || '')) ||
        (item.manifest_key && a.manifest_key === item.manifest_key && sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase() === cleanName)
      ) {
        audits[i] = {
          ...a,
          status: 'actually_sponsored',
          status_updated_at: new Date().toISOString(),
          ledger_entry_id: null,
          sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled from ledger)` : 'Settled from ledger',
        };
        auditChanged = true;
      }
    }
  }
  if (auditChanged) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, count: beforeCount - ledger.length });
});

// Add Manual Ledger Entry
app.post('/api/ledger/manual', (req, res) => {
  const entry = req.body;
  if (!entry || !entry.passenger_name) {
    res.status(400).json({ error: 'passenger_name is required' });
    return;
  }

  const debtType = entry.debtType || (entry.sponsored ? 'unaccounted_sponsorship' : 'cancellation');
  const isSponsored = debtType !== 'cancellation';
  let noteText = '';
  const rawNote = entry.notes ? String(entry.notes).trim() : (entry.general_notes ? String(entry.general_notes).trim() : '');
  if (debtType === 'unaccounted_sponsorship') {
    noteText = rawNote && !rawNote.toLowerCase().includes('unaccounted')
      ? `Unaccounted Sponsorship: ${rawNote}`
      : (rawNote || 'Unaccounted Sponsorship');
  } else if (debtType === 'unpaid_sponsorship') {
    noteText = rawNote && !rawNote.toLowerCase().includes('did not pay')
      ? `Did not pay: ${rawNote}`
      : (rawNote || 'Did not pay');
  } else {
    noteText = rawNote;
  }

  const newEntry = {
    id: entry.id || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    manifest_key: entry.manifest_key || `manual-${Date.now()}`,
    date: entry.date || new Date().toISOString().split('T')[0],
    service: entry.service || 'Service',
    passenger_name: entry.passenger_name,
    stop: entry.stop || 'Manual Entry',
    structure: entry.structure || '',
    vehicle_name: entry.vehicle_name || 'Manual Entry',
    submitted_by: 'Cancellation Admin',
    rep_name: entry.rep_name || 'Cancellation Admin',
    license_plate: entry.license_plate || '',
    sponsored: isSponsored,
    sponsor_note: isSponsored ? noteText : '',
    structure_debt: typeof entry.structure_debt === 'number'
      ? entry.structure_debt
      : (entry.structure_debt !== undefined && entry.structure_debt !== null && entry.structure_debt !== ''
          ? Number(entry.structure_debt) || getFareForDate(entry.date)
          : getFareForDate(entry.date)),
    general_notes: noteText,
    submitted_at: entry.submitted_at || new Date().toISOString(),
  };

  const ledger = readJsonFile<Array<unknown>>(LEDGER_FILE, []);
  ledger.unshift(newEntry);
  atomicWriteJson(LEDGER_FILE, ledger);

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, entry: newEntry });
});

// Delete specific ledger entry
app.delete('/api/ledger/:id', (req, res) => {
  const id = req.params.id;
  let ledger = readJsonFile<Array<{ id: string; passenger_name?: string; manifest_key?: string }>>(LEDGER_FILE, []);
  const before = ledger.length;
  const deletedItem = ledger.find((e) => e.id === id);
  ledger = ledger.filter((e) => e.id !== id);
  atomicWriteJson(LEDGER_FILE, ledger);

  // Synchronize with sponsorship audits so it does not resurrect
  let audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  let auditChanged = false;
  const cleanName = deletedItem ? sanitizePassengerDisplayName(deletedItem.passenger_name || '').toLowerCase() : '';
  audits = audits.map((a) => {
    if (
      String(a.ledger_entry_id) === id ||
      (deletedItem && a.manifest_key === deletedItem.manifest_key && sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase() === cleanName)
    ) {
      auditChanged = true;
      return {
        ...a,
        status: 'actually_sponsored',
        status_updated_at: new Date().toISOString(),
        ledger_entry_id: null,
        sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled / Removed from ledger)` : 'Settled / Removed from ledger',
      };
    }
    return a;
  });
  if (auditChanged) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, removed: before - ledger.length });
});

// Update specific ledger entry (e.g. partial payment or fee adjustment)
app.patch('/api/ledger/:id', (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const idx = ledger.findIndex((e) => e.id === id);
  if (idx !== -1) {
    const wasRemoved = updates.structure_debt !== undefined && Number(updates.structure_debt) <= 0;
    if (wasRemoved) {
      ledger = ledger.filter((e) => e.id !== id);
    } else {
      ledger[idx] = { ...ledger[idx], ...updates };
      if (updates.structure_debt !== undefined) {
        ledger[idx].structure_debt = Number(updates.structure_debt);
      }
    }
    atomicWriteJson(LEDGER_FILE, ledger);

    // Sync sponsorship audit
    const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
    const sponIdx = audits.findIndex((a) => String(a.ledger_entry_id) === id);
    if (sponIdx !== -1) {
      if (wasRemoved) {
        audits[sponIdx].status = 'actually_sponsored';
        audits[sponIdx].status_updated_at = new Date().toISOString();
        audits[sponIdx].ledger_entry_id = null;
        audits[sponIdx].sponsor_note = `${audits[sponIdx].sponsor_note || ''} (Paid in full)`.trim();
      } else {
        if (updates.passenger_name) audits[sponIdx].passenger_name = sanitizePassengerDisplayName(String(updates.passenger_name));
        if (updates.structure) audits[sponIdx].structure = normalizeStructureCode(String(updates.structure));
      }
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
      broadcastSse('sponsorships_updated', { timestamp: Date.now() });
    }

    broadcastSse('ledger_updated', { timestamp: Date.now() });
    res.json({ success: true, entry: ledger[idx] });
  } else {
    res.status(404).json({ error: 'Entry not found' });
  }
});

// Update debtor details and instances
app.post('/api/ledger/update-debtor', (req, res) => {
  const { existingEntryIds, updates } = req.body || {};
  if (!Array.isArray(existingEntryIds) || existingEntryIds.length === 0) {
    res.status(400).json({ error: 'existingEntryIds array is required' });
    return;
  }

  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const existingSet = new Set(existingEntryIds.map(String));

  const cleanName = updates?.name ? String(updates.name).trim() : '';
  const rawStruct = updates?.structure ? String(updates.structure).trim() : 'No Structure';
  const debtType = updates?.debtType || (updates?.isSponsored ? 'unaccounted_sponsorship' : 'cancellation');
  const isSponsored = debtType !== 'cancellation';
  let noteText = '';
  const rawNote = updates?.notes ? String(updates.notes).trim() : '';
  if (debtType === 'unaccounted_sponsorship') {
    noteText = rawNote && !rawNote.toLowerCase().includes('unaccounted')
      ? `Unaccounted Sponsorship: ${rawNote}`
      : (rawNote || 'Unaccounted Sponsorship');
  } else if (debtType === 'unpaid_sponsorship') {
    noteText = rawNote && !rawNote.toLowerCase().includes('did not pay')
      ? `Did not pay: ${rawNote}`
      : (rawNote || 'Did not pay');
  } else {
    noteText = rawNote;
  }

  const instances = Array.isArray(updates?.instances) ? updates.instances : [];
  // If the person's debt for a particular date or service was reduced to zero, remove that debt
  const activeInstances = instances.filter((inst) => {
    const amt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
    return Number.isFinite(amt) && amt > 0;
  });

  if (activeInstances.length === 0) {
    // Settle/remove all entries for this debtor when debt is reduced to zero
    ledger = ledger.filter((e) => !existingSet.has(String(e.id)));

    // Also update any linked sponsorships so they do not resurrect
    const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
    let auditChanged = false;
    for (let i = 0; i < audits.length; i++) {
      if (existingSet.has(String(audits[i].ledger_entry_id || ''))) {
        audits[i].status = 'actually_sponsored';
        audits[i].status_updated_at = new Date().toISOString();
        audits[i].ledger_entry_id = null;
        audits[i].sponsor_note = `${audits[i].sponsor_note || ''} (Settled / Debt removed)`.trim();
        auditChanged = true;
      }
    }
    if (auditChanged) {
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
      broadcastSse('sponsorships_updated', { timestamp: Date.now() });
    }
  } else {
    const template = ledger.find((e) => existingSet.has(String(e.id))) || {};
    const updatedIds = new Set<string>();

    for (const inst of activeInstances) {
      const validAmt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
      const validDate = inst.date ? String(inst.date).trim() : '';
      const validService = inst.service ? String(inst.service).trim() : 'PM';

      if (inst.id && existingSet.has(String(inst.id))) {
        updatedIds.add(String(inst.id));
        const idx = ledger.findIndex((e) => String(e.id) === String(inst.id));
        if (idx !== -1) {
          ledger[idx] = {
            ...ledger[idx],
            date: validDate,
            service: validService,
            passenger_name: cleanName || ledger[idx].passenger_name,
            structure: rawStruct,
            structure_debt: validAmt,
            sponsored: isSponsored,
            sponsor_note: isSponsored ? noteText : '',
            general_notes: noteText,
            submitted_by: 'Cancellation Admin',
          };
        }
      } else {
        const newId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        updatedIds.add(newId);
        ledger.unshift({
          id: newId,
          manifest_key: template.manifest_key || `manual-${Date.now()}`,
          date: validDate,
          service: validService,
          passenger_name: cleanName || template.passenger_name || 'Debtor',
          stop: template.stop || 'Structure Stop',
          structure: rawStruct,
          vehicle_name: template.vehicle_name || '—',
          submitted_by: 'Cancellation Admin',
          rep_name: template.rep_name || '',
          license_plate: template.license_plate || '',
          sponsored: isSponsored,
          sponsor_note: isSponsored ? noteText : '',
          structure_debt: validAmt,
          general_notes: noteText,
          submitted_at: new Date().toISOString(),
        });
      }
    }

    // Remove any entries that were reduced to zero or omitted
    ledger = ledger.filter((e) => !existingSet.has(String(e.id)) || updatedIds.has(String(e.id)));

    // Synchronize linked sponsorships if debt was edited or type changed
    const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
    let auditChanged = false;
    for (let i = 0; i < audits.length; i++) {
      if (existingSet.has(String(audits[i].ledger_entry_id || ''))) {
        if (!isSponsored) {
          // Changed to cancellation (not sponsored)
          audits[i].status = 'actually_sponsored';
          audits[i].status_updated_at = new Date().toISOString();
          audits[i].ledger_entry_id = null;
          audits[i].sponsor_note = `${audits[i].sponsor_note || ''} (Converted to regular cancellation)`.trim();
          auditChanged = true;
        } else {
          if (cleanName) audits[i].passenger_name = cleanName;
          if (rawStruct) audits[i].structure = rawStruct;
          audits[i].sponsor_note = noteText;
          audits[i].status = debtType;
          audits[i].status_updated_at = new Date().toISOString();
          auditChanged = true;
        }
      }
    }
    if (auditChanged) {
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
      broadcastSse('sponsorships_updated', { timestamp: Date.now() });
    }
  }

  atomicWriteJson(LEDGER_FILE, ledger);
  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, count: ledger.length });
});

// ----------------------------------------------------
// FRONTEND SERVING (VITE & STATIC)
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] CRC Transport Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
