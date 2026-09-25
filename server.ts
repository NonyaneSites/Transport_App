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
  const toSave = {
    ...manifest,
    date: key,
    signups: Array.isArray(manifest.signups) ? manifest.signups : [],
    vehicles: Array.isArray(manifest.vehicles) ? manifest.vehicles : [],
    updated_at: nowIso,
  };

  atomicWriteJson(filePath, toSave);
  broadcastSse('manifest_updated', { key, manifest: toSave, timestamp: Date.now() });

  res.json({ success: true, manifest: toSave });
});

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

  // 1. Update target vehicle in manifest
  let targetVehicleName = 'Vehicle';
  let foundTarget = false;
  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (v.id === vehicleId) {
      foundTarget = true;
      targetVehicleName = v.name;
      return {
        ...v,
        submitted: true,
        submittedAt: nowIso,
        submittedBy: (repName || '').trim(),
        repName: (repName || '').trim(),
        licensePlate: (licensePlate || '').trim(),
        coReps: Array.isArray(coReps) ? coReps : [],
        generalNotes: (generalNotes || '').trim(),
        draftState: draftState || v.draftState,
      };
    }
    return v;
  });

  if (!foundTarget) {
    const payloadVeh = req.body?.vehicle;
    const newV = {
      id: vehicleId,
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
      draftState: draftState || payloadVeh?.draftState,
    };
    targetVehicleName = newV.name;
    manifest.vehicles = [...(manifest.vehicles || []), newV];
  }

  // 2. Update signups attendance if provided
  if (Array.isArray(updatedSignups)) {
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
    const riderSet = new Set(allRiderNames);
    ledger = ledger.filter((entry) => !(entry.manifest_key === key && riderSet.has(entry.passenger_name)));
  }

  // Insert new absentees
  if (Array.isArray(absentees) && absentees.length > 0) {
    for (const a of absentees) {
      ledger.push({
        id: `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        manifest_key: key,
        date: parsedDate || key,
        service: serviceLabel || 'Service',
        passenger_name: a.fullName,
        stop: a.stop || '',
        structure: a.structure || '',
        vehicle_name: targetVehicleName,
        submitted_by: (repName || '').trim(),
        rep_name: (repName || '').trim(),
        license_plate: (licensePlate || '').trim(),
        sponsored: Boolean(a.sponsored),
        sponsor_note: cleanSponsorshipNote(a.sponsorNote),
        structure_debt: 40,
        general_notes: a.sponsored ? (cleanSponsorshipNote(a.sponsorNote) || '') : (generalNotes || '').trim(),
        submitted_at: nowIso,
      });
    }
  }

  // Insert riders indicated as "didn't pay" directly into ledger
  const targetRiderIds = new Set((manifest.vehicles.find((v) => v.id === vehicleId)?.riders || []).map(String));
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
      if (!ledger.some((e) => e.manifest_key === key && e.passenger_name.toLowerCase() === u.fullName.toLowerCase())) {
        ledger.push({
          id: `ledger_unpaid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          manifest_key: key,
          date: parsedDate || key,
          service: serviceLabel || 'Service',
          passenger_name: u.fullName,
          stop: u.stop || '',
          structure: u.structure || '',
          vehicle_name: targetVehicleName,
          submitted_by: (repName || '').trim(),
          rep_name: (repName || '').trim(),
          license_plate: (licensePlate || '').trim(),
          sponsored: false,
          sponsor_note: u.unpaidNote ? `Did not pay: ${u.unpaidNote}` : 'Did not pay',
          structure_debt: 40,
          general_notes: `Unpaid ride (Did not pay)${u.unpaidNote ? ` - ${u.unpaidNote}` : ''}`,
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

  const collectedSponsees: Array<{ id?: string; fullName: string; structure?: string; stop?: string; sponsorNote?: string }> = [...rawSponsored];
  if (collectedSponsees.length === 0 && draftSponIds.size > 0 && Array.isArray(manifest.signups)) {
    for (const s of manifest.signups) {
      const sId = String(s.id);
      if (draftSponIds.has(sId) || draftSponIds.has(s.id as unknown as string)) {
        collectedSponsees.push({
          id: sId,
          fullName: s.fullName,
          structure: (s as { structure?: string }).structure || '',
          stop: (s as { stop?: string }).stop || '',
          sponsorNote: (draftNotes[sId] ?? draftNotes[s.id] ?? (s as { sponsorNote?: string }).sponsorNote ?? '').trim(),
        });
      }
    }
  }

  for (const sp of collectedSponsees) {
    if (!sp.fullName || !sp.fullName.trim()) continue;
    const cleanName = sanitizePassengerDisplayName(sp.fullName.trim());
    if (!cleanName) continue;
    const baseDate = normalizeDateToYMD(parsedDate || key);
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const auditId = `sp_${baseDate}_${normName}`;
    const existingIdx = audits.findIndex((a) => {
      if (a.id && (a.id === auditId || a.id === `sp_${normName}`)) return true;
      if (sp.id && a.passenger_id && String(sp.id) === String(a.passenger_id)) return true;
      const aDate = normalizeDateToYMD(a.date || a.manifest_key);
      const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return aName === normName && (!baseDate || !aDate || aDate === baseDate);
    });

    if (existingIdx >= 0) {
      audits[existingIdx] = {
        ...audits[existingIdx],
        passenger_id: sp.id || audits[existingIdx].passenger_id,
        passenger_name: cleanName,
        structure: sp.structure || audits[existingIdx].structure,
        stop: sp.stop || audits[existingIdx].stop,
        vehicle_name: targetVehicleName || audits[existingIdx].vehicle_name,
        rep_name: (repName || '').trim() || audits[existingIdx].rep_name,
        sponsor_note: sp.sponsorNote || audits[existingIdx].sponsor_note,
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
        vehicle_name: targetVehicleName,
        rep_name: (repName || '').trim(),
        sponsor_note: sp.sponsorNote || '',
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
  const { vehicleId, draftState, repName, licensePlate } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }

  const filePath = path.join(MANIFESTS_DIR, `${key}.json`);
  const manifest = readJsonFile<{
    date: string;
    signups: unknown[];
    vehicles: Array<{ id: string; repName?: string; licensePlate?: string; draftState?: unknown }>;
    updated_at?: string;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const nowIso = new Date().toISOString();

  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (v.id === vehicleId) {
      return {
        ...v,
        repName: repName !== undefined ? repName : v.repName,
        licensePlate: licensePlate !== undefined ? licensePlate : v.licensePlate,
        draftState: draftState !== undefined ? draftState : v.draftState,
      };
    }
    return v;
  });

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
              if (a.id && (a.id === auditId || a.id === `sp_${normName}`)) return true;
              if (s.id && a.passenger_id && String(s.id) === String(a.passenger_id)) return true;
              const aDate = normalizeDateToYMD(a.date || a.manifest_key);
              const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
              return aName === normName && (!baseDate || !aDate || aDate === baseDate);
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
            if (a.id && (a.id === auditId || a.id === `sp_${normName}`)) return true;
            if (s.id && a.passenger_id && String(s.id) === String(a.passenger_id)) return true;
            const aDate = normalizeDateToYMD(a.date || a.manifest_key);
            const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            return aName === normName && (!baseDate || !aDate || aDate === baseDate);
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

  // Deduplicate and sanitize records by session date and passenger name
  const deduped: typeof audits = [];
  for (const a of audits) {
    const cleanName = sanitizePassengerDisplayName(a.passenger_name);
    if (!cleanName) continue;
    const baseDate = normalizeDateToYMD(a.date || a.manifest_key);
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');

    const existingIdx = deduped.findIndex((existing) => {
      if (a.id && existing.id && a.id === existing.id) return true;
      if (a.passenger_id && existing.passenger_id && String(a.passenger_id) === String(existing.passenger_id)) {
        const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
        return !baseDate || !existDate || baseDate === existDate;
      }
      const existNormName = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (existNormName === normName) {
        const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
        if (!baseDate || !existDate || baseDate === existDate) return true;
        if (a.manifest_key && existing.manifest_key && a.manifest_key === existing.manifest_key) return true;
      }
      return false;
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

  if (/^(?:unaccounted|unpaid)?\s*sponsorships?$/i.test(trimmed)) return '';
  if (/^(?:unaccounted|unpaid)$/i.test(trimmed)) return '';
  if (/^actually\s*sponsored$/i.test(trimmed)) return '';
  if (/^pending\s*verification$/i.test(trimmed)) return '';
  if (/^(?:(?:from|in)\s+)?(?:taxi|vehicle|bus)\s*\d+$/i.test(trimmed)) return '';
  if (/^vehicle:\s*.*$/i.test(trimmed)) return '';

  // Pattern: "Unaccounted Sponsorship (from ...)"
  if (/^unaccounted\s*sponsorship\s*\(from\s*[^)]+\)$/i.test(trimmed)) return '';

  const mReported = trimmed.match(/^(?:unaccounted|unpaid)\s*sponsorship\s*\(reported\s*sponsor:\s*(.*?)\)$/i);
  if (mReported && mReported[1]) {
    const inner = mReported[1].trim();
    if (!inner || /^(?:unaccounted|unpaid|sponsorship)$/i.test(inner)) return '';
    return cleanSponsorshipNote(inner);
  }

  const mColon = trimmed.match(/^(?:unaccounted|unpaid)\s*sponsorship:\s*(.*)$/i);
  if (mColon && mColon[1]) {
    const after = mColon[1].trim();
    if (!after || /^(?:unaccounted|unpaid|sponsorship)$/i.test(after)) return '';
    return cleanSponsorshipNote(after);
  }

  // Strip vehicle mentions like "(Taxi 1)", "(from Taxi 2)", "(in Vehicle 3)", "(Bus 4)"
  trimmed = trimmed.replace(/\s*\((?:(?:from|in)\s+)?(?:taxi|vehicle|bus)(?:\s*\d+)?(?:\s*-[^)]*)?\)/gi, '').trim();

  // Strip "in/from Taxi X" or "in/from Vehicle X"
  trimmed = trimmed.replace(/\s*(?:(?:from|in)\s+)(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();

  // Strip " - Taxi X" or "Taxi X - "
  trimmed = trimmed.replace(/\s*[-–—]\s*(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();
  trimmed = trimmed.replace(/^(?:taxi|vehicle|bus)\s*\d+\s*[-–—:]\s*/gi, '').trim();

  // Strip general notes boilerplate if accidental full notes got attached
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations)[^;.]*(?:[;.]|$)/gi, '').trim();

  if (/^(?:unaccounted|unpaid)?\s*sponsorships?$/i.test(trimmed)) return '';
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
    const noteText = cleanSponsorshipNote(spon.sponsor_note);

    // Check if debt entry already exists for this sponsorship
    const existingLedgerIdx = ledger.findIndex((e) =>
      (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
      (e.manifest_key === spon.manifest_key && e.passenger_name.toLowerCase() === spon.passenger_name.toLowerCase() && Boolean(e.sponsored))
    );

    if (existingLedgerIdx >= 0) {
      ledger[existingLedgerIdx].general_notes = noteText;
      ledger[existingLedgerIdx].sponsor_note = noteText;
      ledger[existingLedgerIdx].sponsored = true;
      ledger[existingLedgerIdx].structure_debt = 40;
      spon.ledger_entry_id = ledger[existingLedgerIdx].id;
      ledgerChanged = true;
    } else {
      const newEntryId = `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newEntry = {
        id: newEntryId,
        manifest_key: spon.manifest_key,
        date: spon.date,
        service: spon.service || 'Service',
        passenger_name: spon.passenger_name,
        stop: spon.stop || '',
        structure: spon.structure || '',
        vehicle_name: spon.vehicle_name,
        submitted_by: 'Cancellation Admin',
        rep_name: spon.rep_name,
        license_plate: '',
        sponsored: true,
        sponsor_note: noteText,
        structure_debt: 40,
        general_notes: noteText,
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
      ledger = ledger.filter((e) => !(e.manifest_key === spon.manifest_key && e.passenger_name.toLowerCase() === spon.passenger_name.toLowerCase() && Boolean(e.sponsored)));
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
    const { sponsorshipId, status } = item || {};
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

    if (sponIndex < 0) continue;
    const spon = audits[sponIndex];
    spon.status = status;
    spon.status_updated_at = now;

    if (status === 'unpaid_sponsorship' || status === 'unaccounted_sponsorship') {
      const noteText = cleanSponsorshipNote(spon.sponsor_note);

      const existingLedgerIdx = ledger.findIndex((e) =>
        (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
        (e.manifest_key === spon.manifest_key && e.passenger_name.toLowerCase() === spon.passenger_name.toLowerCase() && Boolean(e.sponsored))
      );

      if (existingLedgerIdx >= 0) {
        ledger[existingLedgerIdx].general_notes = noteText;
        ledger[existingLedgerIdx].sponsor_note = noteText;
        ledger[existingLedgerIdx].sponsored = true;
        ledger[existingLedgerIdx].structure_debt = 40;
        spon.ledger_entry_id = ledger[existingLedgerIdx].id;
        ledgerChanged = true;
      } else {
        const newEntryId = `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        ledger.unshift({
          id: newEntryId,
          manifest_key: spon.manifest_key,
          date: spon.date,
          service: spon.service || 'Service',
          passenger_name: spon.passenger_name,
          stop: spon.stop || '',
          structure: spon.structure || '',
          vehicle_name: spon.vehicle_name,
          submitted_by: 'Cancellation Admin',
          rep_name: spon.rep_name,
          license_plate: '',
          sponsored: true,
          sponsor_note: noteText,
          structure_debt: 40,
          general_notes: noteText,
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
        ledger = ledger.filter((e) => !(e.manifest_key === spon.manifest_key && e.passenger_name.toLowerCase() === spon.passenger_name.toLowerCase() && Boolean(e.sponsored)));
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

// List all ledger entries
app.get('/api/ledger', (req, res) => {
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  let dirty = false;

  // Filter out zero-debt items and sanitize boilerplate notes
  const activeLedger = ledger
    .filter((entry) => {
      if (typeof entry.structure_debt === 'number') {
        return entry.structure_debt > 0;
      }
      return true;
    })
    .map((entry) => {
      const origGn = typeof entry.general_notes === 'string' ? entry.general_notes : '';
      const origSn = typeof entry.sponsor_note === 'string' ? entry.sponsor_note : '';
      const cleanGn = cleanSponsorshipNote(origGn);
      const cleanSn = cleanSponsorshipNote(origSn);
      if (cleanGn !== origGn || cleanSn !== origSn) {
        dirty = true;
        return { ...entry, general_notes: cleanGn, sponsor_note: cleanSn };
      }
      return entry;
    });

  if (dirty) {
    ledger = ledger.map((e) => ({
      ...e,
      general_notes: cleanSponsorshipNote(e.general_notes),
      sponsor_note: cleanSponsorshipNote(e.sponsor_note),
    }));
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

  const idSet = new Set(ids);
  let ledger = readJsonFile<Array<{ id: string }>>(LEDGER_FILE, []);
  const beforeCount = ledger.length;
  ledger = ledger.filter((entry) => !idSet.has(entry.id));
  atomicWriteJson(LEDGER_FILE, ledger);

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

  const newEntry = {
    id: entry.id || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    manifest_key: entry.manifest_key || `manual-${Date.now()}`,
    date: entry.date || new Date().toISOString().split('T')[0],
    service: entry.service || 'Service',
    passenger_name: entry.passenger_name,
    stop: entry.stop || 'Manual Entry',
    structure: entry.structure || '',
    vehicle_name: entry.vehicle_name || 'Manual Entry',
    submitted_by: entry.submitted_by || 'Admin',
    rep_name: entry.rep_name || 'Admin',
    license_plate: entry.license_plate || '',
    sponsored: Boolean(entry.sponsored),
    sponsor_note: cleanSponsorshipNote(entry.sponsor_note),
    structure_debt: typeof entry.structure_debt === 'number' ? entry.structure_debt : 40,
    general_notes: cleanSponsorshipNote(entry.general_notes),
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
  let ledger = readJsonFile<Array<{ id: string }>>(LEDGER_FILE, []);
  const before = ledger.length;
  ledger = ledger.filter((e) => e.id !== id);
  atomicWriteJson(LEDGER_FILE, ledger);

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, removed: before - ledger.length });
});

// Update debtor details and instances
app.post('/api/ledger/update-debtor', (req, res) => {
  const { existingEntryIds, updates } = req.body || {};
  if (!Array.isArray(existingEntryIds) || existingEntryIds.length === 0) {
    res.status(400).json({ error: 'existingEntryIds array is required' });
    return;
  }

  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const existingSet = new Set(existingEntryIds);

  const cleanName = updates?.name ? String(updates.name).trim() : '';
  const rawStruct = updates?.structure ? String(updates.structure).trim() : 'No Structure';
  const isSponsored = Boolean(updates?.isSponsored);
  const notes = cleanSponsorshipNote(updates?.notes);

  const instances = Array.isArray(updates?.instances) ? updates.instances : [];
  // If the person's debt for a particular date or service was reduced to zero, remove that debt
  const activeInstances = instances.filter((inst) => {
    const amt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
    return Number.isFinite(amt) && amt > 0;
  });

  if (activeInstances.length === 0) {
    // Settle/remove all entries for this debtor when debt is reduced to zero
    ledger = ledger.filter((e) => !existingSet.has(e.id));
  } else {
    const template = ledger.find((e) => existingSet.has(e.id)) || {};
    const updatedIds = new Set<string>();

    for (const inst of activeInstances) {
      const validAmt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
      const validDate = inst.date ? String(inst.date).trim() : '';
      const validService = inst.service ? String(inst.service).trim() : 'PM';

      if (inst.id && existingSet.has(inst.id)) {
        updatedIds.add(inst.id);
        const idx = ledger.findIndex((e) => e.id === inst.id);
        if (idx !== -1) {
          ledger[idx] = {
            ...ledger[idx],
            date: validDate,
            service: validService,
            passenger_name: cleanName || ledger[idx].passenger_name,
            structure: rawStruct,
            structure_debt: validAmt,
            sponsored: isSponsored,
            sponsor_note: notes,
            general_notes: notes,
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
          submitted_by: template.submitted_by || 'Admin Manual Edit',
          rep_name: template.rep_name || '',
          license_plate: template.license_plate || '',
          sponsored: isSponsored,
          sponsor_note: notes,
          structure_debt: validAmt,
          general_notes: notes,
          submitted_at: new Date().toISOString(),
        });
      }
    }

    // Remove any entries that were reduced to zero or omitted
    ledger = ledger.filter((e) => !existingSet.has(e.id) || updatedIds.has(e.id));
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
