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

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MANIFESTS_DIR)) fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, JSON.stringify([]), 'utf-8');

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
  manifest.vehicles = (manifest.vehicles || []).map((v) => {
    if (v.id === vehicleId) {
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
        sponsor_note: a.sponsorNote || '',
        structure_debt: 40,
        general_notes: (generalNotes || '').trim(),
        submitted_at: nowIso,
      });
    }
  }

  atomicWriteJson(LEDGER_FILE, ledger);

  // 4. Broadcast live updates to all clients
  broadcastSse('manifest_updated', { key, manifest, timestamp: Date.now() });
  broadcastSse('ledger_updated', { timestamp: Date.now() });

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
      };
    }
    return v;
  });

  manifest.updated_at = nowIso;
  atomicWriteJson(filePath, manifest);

  // Withdraw ledger entries for these riders
  if (Array.isArray(allRiderNames) && allRiderNames.length > 0) {
    const riderSet = new Set(allRiderNames);
    let ledger = readJsonFile<Array<{ manifest_key: string; passenger_name: string }>>(LEDGER_FILE, []);
    ledger = ledger.filter((entry) => !(entry.manifest_key === key && riderSet.has(entry.passenger_name)));
    atomicWriteJson(LEDGER_FILE, ledger);
  }

  broadcastSse('manifest_updated', { key, manifest, timestamp: Date.now() });
  broadcastSse('ledger_updated', { timestamp: Date.now() });

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

// ----------------------------------------------------
// LEDGER API
// ----------------------------------------------------

// List all ledger entries
app.get('/api/ledger', (req, res) => {
  const ledger = readJsonFile(LEDGER_FILE, []);
  res.json(ledger);
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
    sponsor_note: entry.sponsor_note || '',
    structure_debt: typeof entry.structure_debt === 'number' ? entry.structure_debt : 40,
    general_notes: entry.general_notes || '',
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
