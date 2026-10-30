import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { createServer as createViteServer } from 'vite';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const serverSupabase: SupabaseClient | null = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const isUUID = (str?: string | null): boolean =>
  Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));

const CANONICAL_LEDGER_COLUMNS = new Set([
  'id',
  'passenger_name',
  'structure',
  'date',
  'service_type',
  'fee',
  'status',
  'notes',
  'sponsored_by',
  'submitted_at',
  'created_at',
  'manifest_key',
  'vehicle_name',
  'vehicle_id',
  'rep_name',
  'service',
  'stop',
  'submitted_by',
  'license_plate',
  'sponsored',
  'sponsor_note',
  'structure_debt',
  'general_notes',
]);

function sanitizeCancellationLedgerPayload(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (CANONICAL_LEDGER_COLUMNS.has(k) && v !== undefined) {
      if (k === 'id' && typeof v === 'string' && !isUUID(v)) {
        continue;
      }
      out[k] = v;
    }
  }
  return out;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const MANIFESTS_DIR = path.join(DATA_DIR, 'manifests');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const SPONSORSHIPS_FILE = path.join(DATA_DIR, 'sponsorship_audits.json');
const REMOVED_SPONSORSHIPS_FILE = path.join(DATA_DIR, 'removed_sponsorship_ids.json');
const REMOVED_LEDGER_KEYS_FILE = path.join(DATA_DIR, 'removed_ledger_keys.json');
const REHEARSAL_TEMPLATE_FILE = path.join(DATA_DIR, 'rehearsal_template.json');
const USER_ROLES_FILE = path.join(DATA_DIR, 'user_roles.json');

function allowedLegsUpgrades(current?: string | null): Array<'both' | 'going' | 'return'> {
  if (current === 'going') return ['going', 'both'];
  if (current === 'return') return ['return', 'both'];
  return ['both'];
}

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MANIFESTS_DIR)) fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(SPONSORSHIPS_FILE)) fs.writeFileSync(SPONSORSHIPS_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(REMOVED_SPONSORSHIPS_FILE)) fs.writeFileSync(REMOVED_SPONSORSHIPS_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(REMOVED_LEDGER_KEYS_FILE)) fs.writeFileSync(REMOVED_LEDGER_KEYS_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(REHEARSAL_TEMPLATE_FILE)) fs.writeFileSync(REHEARSAL_TEMPLATE_FILE, JSON.stringify([]), 'utf-8');
if (!fs.existsSync(USER_ROLES_FILE)) fs.writeFileSync(USER_ROLES_FILE, JSON.stringify({}), 'utf-8');

function getRemovedLedgerKeys(): Set<string> {
  return new Set<string>(readJsonFile<string[]>(REMOVED_LEDGER_KEYS_FILE, []));
}

function recordRemovedLedgerKeys(keys: string[]): void {
  const current = getRemovedLedgerKeys();
  for (const k of keys) {
    if (k) current.add(k.trim().toLowerCase());
  }
  atomicWriteJson(REMOVED_LEDGER_KEYS_FILE, Array.from(current));
}

function getRemovedSponsorshipKeys(): Set<string> {
  return new Set<string>(readJsonFile<string[]>(REMOVED_SPONSORSHIPS_FILE, []));
}

function recordRemovedSponsorshipKeys(keys: string[]): void {
  const current = getRemovedSponsorshipKeys();
  for (const k of keys) {
    if (k) current.add(k.trim());
  }
  atomicWriteJson(REMOVED_SPONSORSHIPS_FILE, Array.from(current));
}

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

// Path sanitization helper to strictly prevent directory traversal attacks
function sanitizeKey(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getSafeManifestPath(rawKey: string): string | null {
  const safe = sanitizeKey(rawKey);
  if (!safe) return null;
  const target = path.resolve(MANIFESTS_DIR, `${safe}.json`);
  if (!target.startsWith(MANIFESTS_DIR)) return null;
  return target;
}

// In-memory rate limiting per client IP (DEV protection)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 60000;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > 400) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }
  next();
}

app.use('/api', rateLimiter);

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Helper: Verify calling user session from Supabase Auth
async function authenticateUser(req: express.Request): Promise<{
  authorized: boolean;
  email?: string;
  userId?: string;
  role?: string;
  status?: string;
  isSuperAdmin?: boolean;
  error?: string;
}> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return { authorized: false, error: 'Authentication required. Authorization header missing.' };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { authorized: false, error: 'Authentication required. Empty bearer token.' };
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return { authorized: false, error: 'Database authentication service unconfigured.' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { authorized: false, error: 'Invalid or expired authentication session.' };
    }

    const userData = (await response.json()) as { id?: string; email?: string };
    const email = userData?.email?.trim().toLowerCase();
    const userId = userData?.id;
    if (!email) {
      return { authorized: false, error: 'User email not found in session.' };
    }

    const roles = readJsonFile<Record<string, Record<string, unknown>>>(USER_ROLES_FILE, {});
    const userRecord = roles[email] || (userId ? Object.values(roles).find((r) => r.userId === userId) : null);
    const role = (userRecord?.role as string) || 'rep';
    const status = (userRecord?.status as string) || 'pending';
    const isSuperAdmin = status === 'approved' && role === 'super_admin';

    return {
      authorized: true,
      email,
      userId,
      role,
      status,
      isSuperAdmin,
    };
  } catch (err) {
    return { authorized: false, error: `Authentication verification error: ${String(err)}` };
  }
}

// Helper: Verify calling user is authenticated Super Admin
async function authenticateSuperAdmin(req: express.Request): Promise<{ authorized: boolean; email?: string; error?: string }> {
  const auth = await authenticateUser(req);
  if (!auth.authorized) {
    return { authorized: false, error: auth.error };
  }
  if (!auth.isSuperAdmin) {
    return { authorized: false, error: 'Access Denied: Only an approved Super Administrator can manage user account authorizations.' };
  }
  return { authorized: true, email: auth.email };
}

// User roles & authorization endpoints
// Unauthenticated callers cannot retrieve the account directory.
// Non-super-admin users receive ONLY their own account information.
// Super Administrators receive the sanitized management directory.
app.get('/api/auth/roles', async (req, res) => {
  try {
    const auth = await authenticateUser(req);
    if (!auth.authorized || !auth.email) {
      res.status(401).json({ error: 'Authentication required to access account authorization information.' });
      return;
    }

    const roles = readJsonFile<Record<string, Record<string, unknown>>>(USER_ROLES_FILE, {});

    // Super Admin: return directory for management console (sanitized)
    if (auth.isSuperAdmin) {
      const sanitizedDirectory: Record<string, Record<string, unknown>> = {};
      for (const [em, rec] of Object.entries(roles)) {
        sanitizedDirectory[em] = {
          userId: rec.userId,
          email: rec.email || em,
          role: rec.role || 'rep',
          status: rec.status || 'pending',
          full_name: rec.full_name || '',
          phone: rec.phone || '',
          structure: rec.structure || '',
          updated_at: rec.updated_at,
        };
      }
      res.json(sanitizedDirectory);
      return;
    }

    // Authenticated non-super-admin: return ONLY their own account information
    const myRecord = roles[auth.email] || {
      userId: auth.userId,
      email: auth.email,
      role: auth.role || 'rep',
      status: auth.status || 'pending',
    };

    res.json({
      [auth.email]: {
        userId: myRecord.userId,
        email: auth.email,
        role: myRecord.role || 'rep',
        status: myRecord.status || 'pending',
        full_name: myRecord.full_name || '',
        structure: myRecord.structure || '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Update user roles: STRICTLY requires Super Administrator authorization
app.post('/api/auth/roles', async (req, res) => {
  try {
    const authCheck = await authenticateSuperAdmin(req);
    if (!authCheck.authorized) {
      res.status(403).json({ error: authCheck.error });
      return;
    }

    const { email, role, status, full_name, phone, structure, userId } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const cleanEmail = String(email).trim().toLowerCase();
    const roles = readJsonFile<Record<string, Record<string, unknown>>>(USER_ROLES_FILE, {});
    const existing = roles[cleanEmail] || {};
    roles[cleanEmail] = {
      ...existing,
      userId: userId || existing.userId || `user_${cleanEmail}`,
      email: cleanEmail,
      role: role || existing.role || 'rep',
      status: status || existing.status || 'approved',
      full_name: full_name !== undefined ? full_name : existing.full_name,
      phone: phone !== undefined ? phone : existing.phone,
      structure: structure !== undefined ? structure : existing.structure,
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(USER_ROLES_FILE, roles);
    res.json({ success: true, user: roles[cleanEmail] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Approve user: STRICTLY requires Super Administrator authorization
app.post('/api/auth/approve', async (req, res) => {
  try {
    const authCheck = await authenticateSuperAdmin(req);
    if (!authCheck.authorized) {
      res.status(403).json({ error: authCheck.error });
      return;
    }

    const { email, userId, status, role } = req.body || {};
    const roles = readJsonFile<Record<string, Record<string, unknown>>>(USER_ROLES_FILE, {});
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    
    let targetKey = cleanEmail;
    if (!targetKey && userId) {
      targetKey = Object.keys(roles).find((k) => roles[k].userId === userId) || null;
    }

    if (targetKey) {
      const existing = roles[targetKey] || {};
      roles[targetKey] = {
        ...existing,
        userId: userId || existing.userId,
        status: status || 'approved',
        role: role || existing.role || 'rep',
        updated_at: new Date().toISOString(),
      };
      atomicWriteJson(USER_ROLES_FILE, roles);
      res.json({ success: true, user: roles[targetKey] });
    } else if (cleanEmail) {
      roles[cleanEmail] = {
        userId: userId || `user_${cleanEmail}`,
        email: cleanEmail,
        status: status || 'approved',
        role: role || 'rep',
        updated_at: new Date().toISOString(),
      };
      atomicWriteJson(USER_ROLES_FILE, roles);
      res.json({ success: true, user: roles[cleanEmail] });
    } else {
      res.status(400).json({ error: 'User email or ID required' });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Profile self-registration: strictly locked to pending status and rep role to prevent self-elevation
app.post('/api/auth/profile', (req, res) => {
  try {
    const { id, email, full_name, phone, structure } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const cleanEmail = String(email).trim().toLowerCase();
    const roles = readJsonFile<Record<string, Record<string, unknown>>>(USER_ROLES_FILE, {});
    const existing = roles[cleanEmail] || {};
    
    // Prevent unauthenticated self-promotion: new registrations MUST be pending and rep role
    roles[cleanEmail] = {
      ...existing,
      userId: id || existing.userId || `user_${cleanEmail}`,
      email: cleanEmail,
      full_name: full_name || existing.full_name,
      phone: phone || existing.phone,
      structure: structure || existing.structure,
      role: existing.role || 'rep',
      status: existing.status || 'pending',
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(USER_ROLES_FILE, roles);
    res.json({ success: true, profile: roles[cleanEmail] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Manifest not found', date: req.params.key });
    return;
  }
  const manifest = readJsonFile(filePath, null);
  if (!manifest) {
    res.status(404).json({ error: 'Manifest not found', date: req.params.key });
    return;
  }
  res.json(manifest);
});

// Get Thursday rehearsal stop-time template
app.get('/api/rehearsal-template', (_req, res) => {
  try {
    const template = readJsonFile<unknown>(REHEARSAL_TEMPLATE_FILE, []);
    res.json({ template });
  } catch (err) {
    console.error('[Server] Failed to read rehearsal template:', err);
    res.status(500).json({ error: 'Failed to read template' });
  }
});

// Save Thursday rehearsal stop-time template
app.post('/api/rehearsal-template', (req, res) => {
  try {
    const template = req.body?.template !== undefined ? req.body.template : req.body;
    if (!template) {
      res.status(400).json({ error: 'Template body is required' });
      return;
    }
    atomicWriteJson(REHEARSAL_TEMPLATE_FILE, template);
    broadcastSse('rehearsal_template_updated', { template, timestamp: Date.now() });
    res.json({ success: true, template });
  } catch (err) {
    console.error('[Server] Failed to save rehearsal template:', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// Get specific manifest timestamp only (low mobile data / egress)
app.get('/api/manifests/:key/timestamp', (req, res) => {
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Manifest not found', date: req.params.key });
    return;
  }
  const manifest = readJsonFile<{ date?: string; updated_at?: string }>(filePath, { date: req.params.key });
  res.json({ date: req.params.key, updated_at: manifest.updated_at || null });
});

// Save/Upsert specific manifest
app.post('/api/manifests/:key', (req, res) => {
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath) {
    res.status(400).json({ error: 'Invalid manifest key format' });
    return;
  }
  const key = sanitizeKey(req.params.key);
  const manifest = req.body;
  if (!manifest || typeof manifest !== 'object') {
    res.status(400).json({ error: 'Invalid manifest body' });
    return;
  }

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
    updated_at?: string;
  }>(filePath, { date: key, signups: [], vehicles: [] });

  const isAdminRequest = Boolean(
    req.body?.isAdmin ||
    req.body?.admin ||
    req.body?.role === 'admin' ||
    req.headers['x-admin'] ||
    (req.headers.referer && req.headers.referer.includes('/admin'))
  );

  // TASK 2: Prevent stale local/server writes from overwriting newer records
  // For admin requests, allow force write so dispatch allocations stick
  if (!isAdminRequest && existingManifest.updated_at && manifest.updated_at) {
    const diskTime = new Date(existingManifest.updated_at).getTime();
    const incomingTime = new Date(manifest.updated_at).getTime();
    if (incomingTime < diskTime) {
      console.warn(`[Server] Stale manifest write rejected for ${key}: disk has ${existingManifest.updated_at}, incoming has ${manifest.updated_at}`);
      res.status(409).json({ error: 'Conflict: Stale manifest payload rejected', manifest: existingManifest });
      return;
    }
  }

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
    if (existV?.submitted && !incV.submitted && !isAdminRequest) {
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

  // Preserve any vehicles that were in existing disk file ONLY for non-admin requests
  // For Admin requests, the admin's vehicle fleet list is authoritative (allows deleting vehicles!)
  if (!isAdminRequest) {
    const incomingVehIds = new Set((manifest.vehicles || []).map((v: { id: string }) => String(v.id)));
    for (const existV of existingManifest.vehicles || []) {
      if (!incomingVehIds.has(String(existV.id))) {
        mergedVehicles.push(existV);
      }
    }
  }

  let mergedSignups = Array.isArray(manifest.signups) ? manifest.signups : (existingManifest.signups || []);
  if (!isAdminRequest && Array.isArray(manifest.signups) && Array.isArray(existingManifest.signups) && existingManifest.signups.length > 0) {
    const existMap = new Map<string, { legs?: 'both' | 'going' | 'return' }>();
    for (const s of existingManifest.signups as Array<{ id: string; fullName?: string; legs?: 'both' | 'going' | 'return' }>) {
      if (s?.id) existMap.set(String(s.id), s);
      if (s?.fullName) existMap.set(`name:${s.fullName.trim().toLowerCase()}`, s);
    }

    mergedSignups = manifest.signups.map((incS: { id: string; fullName?: string; legs?: 'both' | 'going' | 'return' }) => {
      const existS = existMap.get(String(incS.id)) || (incS.fullName ? existMap.get(`name:${incS.fullName.trim().toLowerCase()}`) : undefined);
      if (existS?.legs && incS.legs && incS.legs !== existS.legs) {
        const allowed = allowedLegsUpgrades(existS.legs);
        if (!allowed.includes(incS.legs)) {
          // Reject downgrade from non-admin client
          return {
            ...incS,
            legs: existS.legs,
          };
        }
      }
      return incS;
    });
  }

  const toSave = {
    ...manifest,
    date: key,
    signups: mergedSignups,
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
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath) {
    res.status(400).json({ error: 'Invalid manifest key format' });
    return;
  }
  const key = sanitizeKey(req.params.key);
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
    const existMap = new Map<string, { legs?: 'both' | 'going' | 'return' }>();
    for (const s of (manifest.signups || []) as Array<{ id: string; fullName?: string; legs?: 'both' | 'going' | 'return' }>) {
      if (s?.id) existMap.set(String(s.id), s);
      if (s?.fullName) existMap.set(`name:${s.fullName.trim().toLowerCase()}`, s);
    }
    manifest.signups = updatedSignups.map((incS: { id: string; fullName?: string; legs?: 'both' | 'going' | 'return' }) => {
      const existS = existMap.get(String(incS.id)) || (incS.fullName ? existMap.get(`name:${incS.fullName.trim().toLowerCase()}`) : undefined);
      if (existS?.legs && incS.legs && incS.legs !== existS.legs) {
        const allowed = allowedLegsUpgrades(existS.legs);
        if (!allowed.includes(incS.legs)) {
          return {
            ...incS,
            legs: existS.legs,
          };
        }
      }
      return incS;
    });
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

  // Remove any previous UNPAID ledger entries strictly for this specific manifest session
  if (Array.isArray(allRiderNames) && allRiderNames.length > 0) {
    const riderSet = new Set(allRiderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
    ledger = ledger.filter((entry) => {
      const isSameSession = entry.manifest_key === key;
      const isRider = riderSet.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase());
      const isSettledOrRemoved = (entry as Record<string, unknown>).status === 'Settled' ||
        (entry as Record<string, unknown>).status === 'Paid' ||
        (entry as Record<string, unknown>).status === 'Removed';
      // Never delete settled or removed debts, and never touch entries from other sessions/manifests!
      if (isSettledOrRemoved) return true;
      return !(isSameSession && isRider);
    });
  }

  // Insert new absentees: regular cancellations in debt ledger (not auto-sent to sponsorship section)
  const isReheKey = (serviceLabel || '').toLowerCase().includes('rehe') || (key || '').toLowerCase().includes('rehe');
  const normalizedSvcLabel = isReheKey ? 'Rehe' : (serviceLabel || 'Service');
  const isDW = isDreamWeekDate(parsedDate || key);
  const effectiveDebt = getFareForDate(parsedDate || key);

  if (Array.isArray(absentees) && absentees.length > 0) {
    const removedLedgerKeys = getRemovedLedgerKeys();
    for (const a of absentees) {
      const cleanAbsName = sanitizePassengerDisplayName(a.fullName);
      const normAbsName = cleanAbsName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const lowerClean = cleanAbsName.toLowerCase();
      // Check if rider was previously deleted/removed from ledger
      const isPermanentlyRemoved = (
        removedLedgerKeys.has(normAbsName) ||
        removedLedgerKeys.has(lowerClean) ||
        removedLedgerKeys.has(`${key}:::${lowerClean}`) ||
        removedLedgerKeys.has(`${key}:::${normAbsName}`) ||
        (a.id && removedLedgerKeys.has(String(a.id)))
      );
      if (isPermanentlyRemoved) continue;

      // Check if rider already has a settled, paid, or removed debt for this manifest key
      const alreadyHandled = ledger.some((e) =>
        e.manifest_key === key &&
        sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === lowerClean &&
        ((e as Record<string, unknown>).status === 'Settled' || (e as Record<string, unknown>).status === 'Paid' || (e as Record<string, unknown>).status === 'Removed')
      );
      if (alreadyHandled) continue;

      let aLegs = (a as { id?: string; fullName?: string; legs?: 'both' | 'going' | 'return' }).legs;
      const existS = (manifest.signups as Array<{ id: string; fullName?: string; legs?: 'both' | 'going' | 'return' }> || []).find(
        (s) => (a.id && String(s.id) === String(a.id)) || (s.fullName && a.fullName && s.fullName.trim().toLowerCase() === a.fullName.trim().toLowerCase())
      );
      if (existS?.legs && aLegs && aLegs !== existS.legs) {
        const allowed = allowedLegsUpgrades(existS.legs);
        if (!allowed.includes(aLegs)) {
          aLegs = existS.legs;
        }
      }
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
        fee: absenteeDebt,
        status: 'Unpaid',
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
      const uLegs = (u as { legs?: 'both' | 'going' | 'return' }).legs;
      let unpaidDebt = effectiveDebt;
      if (!isDW) {
        if (uLegs === 'both') unpaidDebt = 70;
        else if (uLegs === 'going' || uLegs === 'return') unpaidDebt = 40;
        else if (isReheKey) unpaidDebt = 70;
      }
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
          structure_debt: unpaidDebt,
          general_notes: `Did not pay${u.unpaidNote ? `: ${u.unpaidNote}` : ''}`,
          source: 'reported_sponsorship_audit',
          submitted_at: nowIso,
          legs: uLegs || (isReheKey ? 'both' : undefined),
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
      const existingStatus = audits[existingIdx].status;
      const keepStatus = existingStatus && existingStatus !== 'pending' ? existingStatus : 'pending';
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
        status: keepStatus,
        status_updated_at: existingStatus !== 'pending' ? audits[existingIdx].status_updated_at : undefined,
        ledger_entry_id: audits[existingIdx].ledger_entry_id,
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
  syncSponsorshipUpsertToSupabase(audits).catch(() => {});

  // 5. Broadcast live updates to all clients
  broadcastSse('manifest_updated', { key, manifest, timestamp: Date.now() });
  broadcastSse('live_action', {
    key,
    type: 'vehicle_submitted',
    vehicleId: String(vehicleId),
    repName: (repName || '').trim(),
    timestamp: Date.now(),
  });
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
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath) {
    res.status(400).json({ error: 'Invalid manifest key format' });
    return;
  }
  const key = sanitizeKey(req.params.key);
  const { vehicleId, allRiderNames } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }
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
  broadcastSse('live_action', {
    key,
    type: 'vehicle_reopened',
    vehicleId: String(vehicleId),
    timestamp: Date.now(),
  });
  broadcastSse('ledger_updated', { timestamp: Date.now() });
  broadcastSse('sponsorships_updated', { timestamp: Date.now() });

  res.json({ success: true, manifest });
});

// Vehicle Draft Update
app.post('/api/manifests/:key/draft', (req, res) => {
  const filePath = getSafeManifestPath(req.params.key);
  if (!filePath) {
    res.status(400).json({ error: 'Invalid manifest key format' });
    return;
  }
  const key = sanitizeKey(req.params.key);
  const { vehicleId, draftState, repName, licensePlate, fullVehicle, manifest: incomingManifest } = req.body;

  if (!vehicleId) {
    res.status(400).json({ error: 'vehicleId is required' });
    return;
  }
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
  const trimmed = String(dateStr).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // Match YYYY-MM-DD even if followed by _ or T or space or end of string
  const ymdMatch = trimmed.match(/(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=[^\d]|$)/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  // Match DD-MM-YYYY or MM-DD-YYYY
  const dmyMatch = trimmed.match(/(?:^|[^\d])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?=[^\d]|$)/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  const part = trimmed.split('_')[0].split('T')[0];
  const partMatch = part.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (partMatch) {
    return `${partMatch[1]}-${partMatch[2].padStart(2, '0')}-${partMatch[3].padStart(2, '0')}`;
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
  return part;
}

// Helper to clean slug/synthetic names like "Passenger bonolo-ngejane-dfc-bus-stop" into "Bonolo Ngejane"
function sanitizePassengerDisplayName(rawName: string): string {
  if (!rawName) return '';
  let name = String(rawName).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

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
  name = name.replace(/^[-\s\d.:#*•]+/, '').replace(/[-\s.:#*•]+$/, '').trim();
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

interface ServerAuditItem {
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

/**
 * Bidirectional reconciliation helper:
 * Guarantees that any sponsorship recorded or indicated in the ledger
 * is automatically reflected in sponsorship_audits with its confirmed status,
 * ensuring already indicated sponsorships never reset to pending.
 */
function syncSponsorshipAuditsWithLedger(
  audits: ServerAuditItem[],
  ledger: Array<Record<string, unknown>>
): { audits: ServerAuditItem[]; changed: boolean } {
  let changed = false;
  const auditMap = new Map<string, ServerAuditItem>();

  for (const a of audits) {
    if (a.id) auditMap.set(String(a.id), a);
    const date = normalizeDateToYMD(a.date || a.manifest_key);
    const norm = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (date && norm) {
      auditMap.set(`${date}::${norm}`, a);
    }
    if (a.ledger_entry_id) {
      auditMap.set(`ledger::${String(a.ledger_entry_id)}`, a);
    }
  }

  for (const entry of ledger) {
    if (entry.status === 'Removed' || entry.status === 'Settled' || Number(entry.structure_debt) <= 0) {
      continue;
    }
    const origGn = typeof entry.general_notes === 'string' ? entry.general_notes : '';
    const origSn = typeof entry.sponsor_note === 'string' ? entry.sponsor_note : '';
    const dt = String(entry.debt_type || entry.debtType || '').toLowerCase();
    const isActually = /actually\s*sponsored/i.test(origGn) || /actually\s*sponsored/i.test(origSn) || dt.includes('actually');
    const isUnpaid = /did not pay|unpaid/i.test(origGn) || /did not pay|unpaid/i.test(origSn) || dt.includes('unpaid');
    const isUnaccounted = /unaccounted/i.test(origGn) || /unaccounted/i.test(origSn) || dt.includes('unaccounted');
    const isSponsored = Boolean(entry.sponsored) || isUnpaid || isUnaccounted || isActually || /sponsor/i.test(origGn) || /sponsor/i.test(origSn) || dt.includes('sponsorship');

    if (!isSponsored) continue;

    const cleanName = sanitizePassengerDisplayName(String(entry.passenger_name || ''));
    if (!cleanName) continue;
    const date = normalizeDateToYMD(String(entry.date || entry.manifest_key || ''));
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const auditId = `sp_${date}_${normName}`;
    const targetStatus: ServerAuditItem['status'] = isActually
      ? 'actually_sponsored'
      : (isUnpaid ? 'unpaid_sponsorship' : 'unaccounted_sponsorship');
    const noteText = isActually
      ? (origSn || origGn || 'Actually Sponsored')
      : isUnpaid
      ? (origSn && !origSn.toLowerCase().includes('did not pay') ? `Did not pay: ${origSn}` : (origSn || origGn || 'Did not pay'))
      : (origSn && !origSn.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${origSn}` : (origSn || origGn || 'Unaccounted Sponsorship'));

    const existing = auditMap.get(`ledger::${String(entry.id)}`) || auditMap.get(auditId) || auditMap.get(`${date}::${normName}`);

    if (existing) {
      if (existing.status === 'pending') {
        existing.status = targetStatus;
        existing.status_updated_at = existing.status_updated_at || String(entry.submitted_at || new Date().toISOString());
        existing.ledger_entry_id = String(entry.id);
        changed = true;
      }
      if (!existing.ledger_entry_id) {
        existing.ledger_entry_id = String(entry.id);
        changed = true;
      }
    } else {
      const newAudit: ServerAuditItem = {
        id: auditId,
        manifest_key: String(entry.manifest_key || ''),
        date: date,
        service: String(entry.service || 'Service'),
        passenger_name: cleanName,
        structure: normalizeStructureCode(String(entry.structure || '')),
        stop: String(entry.stop || ''),
        vehicle_name: String(entry.vehicle_name || 'Vehicle'),
        rep_name: String(entry.rep_name || entry.submitted_by || 'Rep'),
        sponsor_note: cleanSponsorshipNote(noteText) || noteText,
        status: targetStatus,
        status_updated_at: String(entry.submitted_at || new Date().toISOString()),
        ledger_entry_id: String(entry.id),
        submitted_at: String(entry.submitted_at || new Date().toISOString()),
      };
      audits.push(newAudit);
      auditMap.set(auditId, newAudit);
      auditMap.set(`${date}::${normName}`, newAudit);
      auditMap.set(`ledger::${String(entry.id)}`, newAudit);
      changed = true;
    }
  }

  return { audits, changed };
}

async function syncServerSponsorshipsWithSupabase(): Promise<ServerAuditItem[]> {
  const localAudits = readJsonFile<ServerAuditItem[]>(SPONSORSHIPS_FILE, []);
  if (!serverSupabase) return localAudits;

  try {
    const { data: supaRows, error } = await serverSupabase
      .from('sponsorship_audits')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error || !supaRows) {
      console.warn('[Server] Supabase sponsorship sync warning:', error);
      return localAudits;
    }

    const map = new Map<string, ServerAuditItem>();
    for (const row of supaRows as ServerAuditItem[]) {
      if (row && row.id) map.set(String(row.id), { ...row });
    }

    const itemsToUpsertToSupabase: ServerAuditItem[] = [];

    for (const localItem of localAudits) {
      const id = String(localItem.id);
      if (!map.has(id)) {
        map.set(id, localItem);
        itemsToUpsertToSupabase.push(localItem);
      } else {
        const existing = map.get(id)!;
        if (existing.status === 'pending' && localItem.status !== 'pending') {
          existing.status = localItem.status;
          existing.status_updated_at = localItem.status_updated_at || new Date().toISOString();
          existing.ledger_entry_id = localItem.ledger_entry_id || existing.ledger_entry_id;
          itemsToUpsertToSupabase.push(existing);
        } else if (existing.status !== 'pending' && localItem.status !== 'pending') {
          const sTime = existing.status_updated_at ? new Date(existing.status_updated_at).getTime() : 0;
          const lTime = localItem.status_updated_at ? new Date(localItem.status_updated_at).getTime() : 0;
          if (lTime > sTime) {
            existing.status = localItem.status;
            existing.status_updated_at = localItem.status_updated_at;
            existing.ledger_entry_id = localItem.ledger_entry_id || existing.ledger_entry_id;
            itemsToUpsertToSupabase.push(existing);
          }
        }
      }
    }

    const merged = Array.from(map.values());
    atomicWriteJson(SPONSORSHIPS_FILE, merged);

    if (itemsToUpsertToSupabase.length > 0) {
      syncSponsorshipUpsertToSupabase(itemsToUpsertToSupabase).catch(() => {});
    }

    return merged;
  } catch (err) {
    console.warn('[Server] syncServerSponsorshipsWithSupabase error:', err);
    return localAudits;
  }
}

async function syncSponsorshipUpsertToSupabase(items: ServerAuditItem | ServerAuditItem[] | Array<Record<string, unknown>>) {
  if (!serverSupabase) return;
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return;
  const cleanRows = list.map((r) => ({
    id: String(r.id),
    manifest_key: String(r.manifest_key || ''),
    date: String(r.date || ''),
    service: String(r.service || 'Service'),
    passenger_id: String(r.passenger_id || ''),
    passenger_name: String(r.passenger_name || ''),
    structure: String(r.structure || ''),
    stop: String(r.stop || ''),
    vehicle_name: String(r.vehicle_name || ''),
    rep_name: String(r.rep_name || ''),
    sponsor_note: String(r.sponsor_note || ''),
    status: String(r.status || 'pending'),
    status_updated_at: r.status_updated_at ? String(r.status_updated_at) : null,
    ledger_entry_id: String(r.ledger_entry_id || ''),
    submitted_at: String(r.submitted_at || new Date().toISOString()),
  }));
  try {
    for (let i = 0; i < cleanRows.length; i += 50) {
      const chunk = cleanRows.slice(i, i + 50);
      await serverSupabase.from('sponsorship_audits').upsert(chunk, { onConflict: 'id' });
    }
  } catch (err) {
    console.warn('[Server] syncSponsorshipUpsertToSupabase error:', err);
  }
}

async function syncSponsorshipDeleteFromSupabase(ids: string | string[]) {
  if (!serverSupabase) return;
  const list = Array.isArray(ids) ? ids.map(String) : [String(ids)];
  if (list.length === 0) return;
  try {
    await serverSupabase.from('sponsorship_audits').delete().in('id', list);
  } catch (err) {
    console.warn('[Server] syncSponsorshipDeleteFromSupabase error:', err);
  }
}

// Initial sync on server module execution
try {
  const startupLedger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const startupAudits = readJsonFile<ServerAuditItem[]>(SPONSORSHIPS_FILE, []);
  const initialSync = syncSponsorshipAuditsWithLedger(startupAudits, startupLedger);
  if (initialSync.changed) {
    atomicWriteJson(SPONSORSHIPS_FILE, initialSync.audits);
  }
  syncServerSponsorshipsWithSupabase().catch((err) => {
    console.warn('[Server] Background Supabase sync note:', err);
  });
} catch (err) {
  console.warn('[Server] Initial sponsorship sync note:', err);
}

// Record reported sponsorships from attendance check-in or transfers
app.post('/api/ledger/sponsorships', async (req, res) => {
  const { sponsorships } = req.body || {};
  if (Array.isArray(sponsorships) && sponsorships.length > 0) {
    const audits = readJsonFile<ServerAuditItem[]>(SPONSORSHIPS_FILE, []);
    const removedSponKeys = getRemovedSponsorshipKeys();
    const removedLedgerKeys = getRemovedLedgerKeys();

    for (const sp of sponsorships) {
      const rawName = sp.passenger_name || sp.fullName;
      if (!rawName) continue;
      const cleanName = sanitizePassengerDisplayName(rawName);
      if (!cleanName) continue;
      const baseDate = normalizeDateToYMD(sp.date || sp.manifest_key);
      const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const auditId = sp.id || `sp_${baseDate}_${normName}`;

      if (
        (sp.id && removedSponKeys.has(String(sp.id))) ||
        removedSponKeys.has(auditId) ||
        (sp.passenger_id && removedSponKeys.has(String(sp.passenger_id))) ||
        (baseDate && normName && removedSponKeys.has(`${baseDate}::${normName}`)) ||
        removedSponKeys.has(normName) ||
        removedLedgerKeys.has(normName)
      ) {
        continue;
      }

      const cleanNote = cleanSponsorshipNote(sp.sponsor_note ?? sp.sponsorNote);

      const existingIdx = audits.findIndex((a) => {
        if (a.id && (a.id === auditId || a.id === `sp_${normName}`)) return true;
        if (sp.passenger_id && a.passenger_id && String(sp.passenger_id) === String(a.passenger_id)) return true;
        const aDate = normalizeDateToYMD(a.date || a.manifest_key);
        const aName = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return aName === normName && (!baseDate || !aDate || aDate === baseDate);
      });

      if (existingIdx >= 0) {
        const existingStatus = audits[existingIdx].status;
        const keepStatus = existingStatus && existingStatus !== 'pending' ? existingStatus : (sp.status || 'pending');
        audits[existingIdx] = {
          ...audits[existingIdx],
          passenger_name: cleanName,
          structure: sp.structure || audits[existingIdx].structure,
          stop: sp.stop || audits[existingIdx].stop,
          vehicle_name: sp.vehicle_name || audits[existingIdx].vehicle_name,
          rep_name: sp.rep_name || audits[existingIdx].rep_name,
          sponsor_note: cleanNote || audits[existingIdx].sponsor_note,
          status: keepStatus,
          status_updated_at: existingStatus !== 'pending' ? audits[existingIdx].status_updated_at : sp.status_updated_at,
          ledger_entry_id: audits[existingIdx].ledger_entry_id || sp.ledger_entry_id,
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
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }
  res.json({ success: true });
});

// List reported sponsorships for cancellation admin audit
app.get('/api/ledger/sponsorships', async (req, res) => {
  let audits = await syncServerSponsorshipsWithSupabase();
  const ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const removedIds = getRemovedSponsorshipKeys();
  const removedLedger = getRemovedLedgerKeys();

  // Filter out any previously removed or deleted sponsorships
  audits = audits.filter((a) => {
    if (removedIds.has(String(a.id))) return false;
    const baseDate = normalizeDateToYMD(a.date || a.manifest_key);
    const cleanName = sanitizePassengerDisplayName(a.passenger_name);
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const lowerClean = cleanName.toLowerCase();
    if (baseDate && normName && removedIds.has(`${baseDate}::${normName}`)) return false;
    if (a.passenger_id && removedIds.has(String(a.passenger_id))) return false;
    if (removedIds.has(normName) || removedLedger.has(normName) || removedLedger.has(lowerClean)) return false;
    return true;
  });

  // Sync audits with ledger so confirmed indicated debt is never missing or reset
  const syncResult = syncSponsorshipAuditsWithLedger(audits, ledger);
  audits = syncResult.audits;

  // Auto-scan manifests to find any sponsored passengers
  // so all existing historical and in-progress sponsorship data is instantly visible
  try {
    const files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
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
            const lowerClean = cleanName.toLowerCase();
            const auditId = `sp_${baseDate}_${normName}`;
            if (
              removedIds.has(auditId) ||
              removedIds.has(`${baseDate}::${normName}`) ||
              removedIds.has(sId) ||
              removedIds.has(normName) ||
              removedLedger.has(normName) ||
              removedLedger.has(lowerClean)
            ) {
              continue;
            }
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
          const lowerClean = cleanName.toLowerCase();
          const auditId = `sp_${baseDate}_${normName}`;
          if (
            removedIds.has(auditId) ||
            removedIds.has(`${baseDate}::${normName}`) ||
            (ext.sponseeId && removedIds.has(String(ext.sponseeId))) ||
            removedIds.has(normName) ||
            removedLedger.has(normName) ||
            removedLedger.has(lowerClean)
          ) {
            continue;
          }
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
              sponsor_note: cleanSponsorshipNote(
                ext.note
                  ? `Paid by ${ext.payerName || 'Rider'} in ${v.name} (${ext.note})`
                  : `Paid by ${ext.payerName || 'Rider'} in ${v.name}`
              ),
              status: 'pending',
              submitted_at: new Date().toISOString(),
            });
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
          const lowerClean = cleanName.toLowerCase();
          const auditId = `sp_${baseDate}_${normName}`;
          if (
            removedIds.has(auditId) ||
            removedIds.has(`${baseDate}::${normName}`) ||
            (s.id && removedIds.has(String(s.id))) ||
            removedIds.has(normName) ||
            removedLedger.has(normName) ||
            removedLedger.has(lowerClean)
          ) {
            continue;
          }
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
          }
        }
      }
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
      // PRESERVE confirmed status: if either record was indicated (not pending), the indicated status wins!
      const existingStatus = deduped[existingIdx].status;
      const resolvedStatus = (existingStatus && existingStatus !== 'pending')
        ? existingStatus
        : (a.status && a.status !== 'pending' ? a.status : 'pending');

      const isIncomingNewer = Boolean(
        a.status_updated_at &&
        (!deduped[existingIdx].status_updated_at || a.status_updated_at >= deduped[existingIdx].status_updated_at)
      );
      const resolvedStructure = isIncomingNewer
        ? (normalizeStructureCode(a.structure) || deduped[existingIdx].structure || '')
        : (deduped[existingIdx].structure || normalizeStructureCode(a.structure) || '');

      deduped[existingIdx] = {
        ...deduped[existingIdx],
        passenger_name: cleanName,
        structure: resolvedStructure,
        stop: deduped[existingIdx].stop || a.stop,
        vehicle_name: deduped[existingIdx].vehicle_name || a.vehicle_name,
        rep_name: deduped[existingIdx].rep_name || a.rep_name,
        sponsor_note: cleanSponsorshipNote(deduped[existingIdx].sponsor_note) || cleanedSponsorNote,
        status: resolvedStatus,
        status_updated_at: (existingStatus !== 'pending' ? deduped[existingIdx].status_updated_at : a.status_updated_at) || deduped[existingIdx].status_updated_at || a.status_updated_at,
        ledger_entry_id: deduped[existingIdx].ledger_entry_id || a.ledger_entry_id,
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
  syncSponsorshipUpsertToSupabase(audits).catch(() => {});

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

  // If this note describes a cross-taxi sponsorship or specific payment note, preserve it in full!
  const isCrossOrPayerNote = /(?:paid by|paying for|sponsored by|cross-taxi|sponsee)/i.test(trimmed);
  if (isCrossOrPayerNote) {
    // Clean only accidental full general notes boilerplate
    trimmed = trimmed.replace(/(?:co-reps|cash collected|past cancellations):?[^;.]*(?:[;.]|$)/gi, '').trim();
    return trimmed;
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
      const newEntryId = (spon.ledger_entry_id && isUUID(spon.ledger_entry_id)) ? spon.ledger_entry_id : randomUUID();
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
  syncSponsorshipUpsertToSupabase(spon as ServerAuditItem).catch(() => {});
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
        const newEntryId = (spon.ledger_entry_id && isUUID(spon.ledger_entry_id)) ? spon.ledger_entry_id : randomUUID();
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
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
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

  // Record into removed sponsorships set to prevent resurrection from manifests
  const removedIds = new Set<string>(readJsonFile<string[]>(REMOVED_SPONSORSHIPS_FILE, []));
  removedIds.add(id);
  const baseDate = normalizeDateToYMD(String(spon.date || spon.manifest_key || ''));
  const normName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (baseDate && normName) removedIds.add(`${baseDate}::${normName}`);
  if (spon.passenger_id) removedIds.add(String(spon.passenger_id));
  atomicWriteJson(REMOVED_SPONSORSHIPS_FILE, Array.from(removedIds));

  audits = audits.filter((a) => a.id !== id);
  atomicWriteJson(SPONSORSHIPS_FILE, audits);
  syncSponsorshipDeleteFromSupabase(id).catch(() => {});

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
  syncSponsorshipDeleteFromSupabase(ids).catch(() => {});

  // Record into removed sponsorships set to prevent resurrection from manifests
  const removedIds = new Set<string>(readJsonFile<string[]>(REMOVED_SPONSORSHIPS_FILE, []));
  for (const id of ids) removedIds.add(String(id));
  for (const spon of toDelete) {
    const baseDate = normalizeDateToYMD(String(spon.date || spon.manifest_key || ''));
    const normName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (baseDate && normName) removedIds.add(`${baseDate}::${normName}`);
    if (spon.passenger_id) removedIds.add(String(spon.passenger_id));
  }
  atomicWriteJson(REMOVED_SPONSORSHIPS_FILE, Array.from(removedIds));

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

// Batch update reported sponsorships (mass correct structure, date, service, status, notes)
app.post('/api/ledger/sponsorships/batch-update', (req, res) => {
  const { ids, updates } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !updates) {
    res.status(400).json({ error: 'ids array and updates object are required' });
    return;
  }
  const idSet = new Set(ids.map(String));
  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  let ledgerChanged = false;
  let updatedCount = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < audits.length; i++) {
    const spon = audits[i];
    if (!idSet.has(String(spon.id))) continue;

    const origCleanName = sanitizePassengerDisplayName(String(spon.passenger_name || '')).toLowerCase();

    if (updates.structure !== undefined) spon.structure = normalizeStructureCode(String(updates.structure));
    if (updates.date !== undefined) spon.date = normalizeDateToYMD(String(updates.date)) || String(updates.date);
    if (updates.service !== undefined) spon.service = String(updates.service);
    if (updates.stop !== undefined) spon.stop = String(updates.stop);
    if (updates.sponsor_note !== undefined) spon.sponsor_note = cleanSponsorshipNote(String(updates.sponsor_note));
    if (updates.status !== undefined) {
      spon.status = updates.status;
      spon.status_updated_at = now;
    }

    const entryIdx = ledger.findIndex((e) =>
      (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
      (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === origCleanName && Boolean(e.sponsored))
    );

    const customDebt = updates.debtAmount !== undefined && Number(updates.debtAmount) > 0
      ? Number(updates.debtAmount)
      : getFareForDate(String(spon.date));

    if (spon.status === 'unaccounted_sponsorship' || spon.status === 'unpaid_sponsorship') {
      const rawNote = spon.sponsor_note ? cleanSponsorshipNote(String(spon.sponsor_note)) : '';
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
        ledgerChanged = true;
      } else {
        const newEntryId = (spon.ledger_entry_id && isUUID(spon.ledger_entry_id)) ? spon.ledger_entry_id : randomUUID();
        spon.ledger_entry_id = newEntryId;
        ledger.unshift({
          id: newEntryId,
          manifest_key: spon.manifest_key || `manual-${Date.now()}`,
          date: normalizeDateToYMD(String(spon.date)) || String(spon.date),
          service: spon.service || 'Service',
          passenger_name: sanitizePassengerDisplayName(String(spon.passenger_name)),
          stop: spon.stop || '',
          structure: normalizeStructureCode(String(spon.structure)),
          vehicle_name: spon.vehicle_name || '—',
          submitted_by: 'Cancellation Admin',
          rep_name: spon.rep_name || '',
          license_plate: '',
          sponsored: true,
          sponsor_note: noteText,
          structure_debt: customDebt,
          general_notes: noteText,
          source: 'reported_sponsorship_audit',
          submitted_at: now,
        });
        ledgerChanged = true;
      }
    } else if (spon.status === 'actually_sponsored' || spon.status === 'pending') {
      if (entryIdx >= 0) {
        ledger.splice(entryIdx, 1);
        spon.ledger_entry_id = null;
        ledgerChanged = true;
      }
    } else if (entryIdx >= 0) {
      ledger[entryIdx].structure = spon.structure;
      ledger[entryIdx].date = spon.date;
      ledger[entryIdx].service = spon.service;
      ledgerChanged = true;
    }

    audits[i] = spon;
    updatedCount++;
  }

  if (updatedCount > 0) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
    if (ledgerChanged) {
      atomicWriteJson(LEDGER_FILE, ledger);
      broadcastSse('ledger_updated', { timestamp: Date.now() });
    }
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  res.json({ success: true, updatedCount, ledgerChanged });
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
  syncSponsorshipUpsertToSupabase(spon as ServerAuditItem).catch(() => {});

  if (ledgerChanged) {
    atomicWriteJson(LEDGER_FILE, ledger);
    broadcastSse('ledger_updated', { timestamp: Date.now() });
  }

  broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  res.json({ success: true, sponsorship: spon, ledgerChanged });
});

// Diagnostic endpoint: Inspect cancellation_ledger table IDs and log suspicious patterns
app.get('/api/ledger/diagnostics/ids', async (_req, res) => {
  let rows: Array<Record<string, unknown>> = [];
  let source = 'server_file';

  if (serverSupabase) {
    try {
      const allRows: Array<Record<string, unknown>> = [];
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await serverSupabase
          .from('cancellation_ledger')
          .select('id, passenger_name, structure, date, service, status, structure_debt, fee, manifest_key, submitted_at')
          .range(from, from + pageSize - 1);
        if (error || !data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      if (allRows.length > 0) {
        rows = allRows;
        source = 'supabase';
      }
    } catch (sbErr) {
      console.warn('[Server Diagnostics] Supabase query note:', sbErr);
    }
  }

  if (rows.length === 0) {
    rows = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
    source = 'server_file';
  }

  const isUUID = (str?: unknown): boolean =>
    Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str).trim()));

  let validUuidCount = 0;
  let syntheticLedgerSp = 0;
  let syntheticMock = 0;
  let syntheticTest = 0;
  let syntheticVSpon = 0;
  let emptyOrNull = 0;
  let otherMalformed = 0;

  const suspiciousRows: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const rawId = r?.id != null ? String(r.id).trim() : '';
    if (isUUID(rawId)) {
      validUuidCount++;
    } else {
      let pattern = 'other_malformed';
      if (!rawId) {
        pattern = 'empty_or_null';
        emptyOrNull++;
      } else if (/^ledger_sp_/i.test(rawId)) {
        pattern = 'synthetic_ledger_sp';
        syntheticLedgerSp++;
      } else if (/^mock_/i.test(rawId)) {
        pattern = 'synthetic_mock';
        syntheticMock++;
      } else if (/^test[-_]/i.test(rawId)) {
        pattern = 'synthetic_test';
        syntheticTest++;
      } else if (/^v_spon_/i.test(rawId)) {
        pattern = 'synthetic_v_spon';
        syntheticVSpon++;
      } else {
        pattern = 'other_malformed';
        otherMalformed++;
      }

      suspiciousRows.push({
        id: rawId,
        pattern,
        passenger_name: r.passenger_name || '—',
        structure: r.structure || '—',
        date: r.date || '—',
        service: r.service || '—',
        status: r.status || 'Unpaid',
        structure_debt: r.structure_debt,
        fee: r.fee,
      });
    }
  }

  const totalRecords = rows.length;
  const malformedCount = suspiciousRows.length;
  const validUuidPercentage = totalRecords > 0 ? Number(((validUuidCount / totalRecords) * 100).toFixed(2)) : 100;

  console.log(`\n================== CANCELLATION LEDGER ID DIAGNOSTIC ==================`);
  console.log(`Source: ${source} | Total records: ${totalRecords}`);
  console.log(`Valid RFC4122 UUIDs: ${validUuidCount} (${validUuidPercentage}%)`);
  console.log(`Malformed / Suspicious IDs: ${malformedCount}`);
  if (malformedCount > 0) {
    console.log(`  - synthetic ledger_sp_: ${syntheticLedgerSp}`);
    console.log(`  - synthetic mock_:      ${syntheticMock}`);
    console.log(`  - test identifiers:     ${syntheticTest}`);
    console.log(`  - virtual display:      ${syntheticVSpon}`);
    console.log(`  - empty or null:        ${emptyOrNull}`);
    console.log(`  - other malformed:      ${otherMalformed}`);
    console.log(`Suspicious rows list:`);
    console.table(suspiciousRows.slice(0, 50));
  } else {
    console.log(`🎉 100% ID Integrity: All cancellation_ledger records have valid UUIDs.`);
  }
  console.log(`=======================================================================\n`);

  res.json({
    timestamp: new Date().toISOString(),
    source,
    totalRecords,
    validUuidCount,
    malformedCount,
    validUuidPercentage,
    byPattern: {
      syntheticLedgerSp,
      syntheticMock,
      syntheticTest,
      syntheticVSpon,
      emptyOrNull,
      otherMalformed,
    },
    suspiciousRows,
  });
});

// Update / Edit a reported sponsorship
app.patch('/api/ledger/sponsorships/:id', async (req, res) => {
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

      if (serverSupabase && isUUID(ledger[entryIdx].id)) {
        serverSupabase
          .from('cancellation_ledger')
          .update(
            sanitizeCancellationLedgerPayload({
              passenger_name: spon.passenger_name,
              structure: spon.structure,
              date: spon.date,
              service: spon.service,
              service_type: spon.service,
              stop: spon.stop || '',
              structure_debt: customDebt,
              fee: customDebt,
              status: 'Unpaid',
              sponsored: true,
              sponsored_by: spon.rep_name || '',
              sponsor_note: noteText,
              general_notes: noteText,
            })
          )
          .eq('id', ledger[entryIdx].id)
          .then(() => {})
          .catch(() => {});
      }
    } else {
      let newEntryId = (spon.ledger_entry_id && isUUID(spon.ledger_entry_id)) ? spon.ledger_entry_id : randomUUID();
      if (serverSupabase) {
        try {
          const insertPayload = sanitizeCancellationLedgerPayload({
            manifest_key: spon.manifest_key || `manual-${Date.now()}`,
            date: spon.date,
            service: spon.service,
            service_type: spon.service,
            passenger_name: spon.passenger_name,
            stop: spon.stop || '',
            structure: spon.structure,
            vehicle_name: spon.vehicle_name || '—',
            submitted_by: 'Cancellation Admin',
            rep_name: spon.rep_name || '',
            license_plate: '',
            sponsored: true,
            sponsored_by: spon.rep_name || '',
            sponsor_note: noteText,
            structure_debt: customDebt,
            fee: customDebt,
            status: 'Unpaid',
            general_notes: noteText,
            submitted_at: new Date().toISOString(),
          });
          const { data: newRow } = await serverSupabase
            .from('cancellation_ledger')
            .insert([insertPayload])
            .select('id')
            .single();
          if (newRow?.id && isUUID(newRow.id)) {
            newEntryId = newRow.id;
          }
        } catch {
          /* ignore */
        }
      }

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
      if (serverSupabase && isUUID(ledger[entryIdx].id)) {
        serverSupabase
          .from('cancellation_ledger')
          .update({ status: 'Settled', structure_debt: 0 })
          .eq('id', ledger[entryIdx].id)
          .then(() => {})
          .catch(() => {});
      }
      ledger.splice(entryIdx, 1);
      spon.ledger_entry_id = null;
      ledgerChanged = true;
    } else if (spon.ledger_entry_id && isUUID(spon.ledger_entry_id) && serverSupabase) {
      serverSupabase
        .from('cancellation_ledger')
        .update({ status: 'Settled', structure_debt: 0 })
        .eq('id', spon.ledger_entry_id)
        .then(() => {})
        .catch(() => {});
      spon.ledger_entry_id = null;
    }
  }

  audits[sponIndex] = spon;
  atomicWriteJson(SPONSORSHIPS_FILE, audits);
  syncSponsorshipUpsertToSupabase(spon as ServerAuditItem).catch(() => {});

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
      const sponDate = normalizeDateToYMD(spon.date) || spon.date;
      const hasEntry = ledger.some((e) =>
        (spon.ledger_entry_id && String(e.id) === String(spon.ledger_entry_id)) ||
        (sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase() === cleanSponName &&
         (normalizeDateToYMD(String(e.date || '')) || String(e.date || '')) === sponDate)
      );
      if (!hasEntry) {
        const newId = (spon.ledger_entry_id && isUUID(spon.ledger_entry_id)) ? spon.ledger_entry_id : null;
        if (!newId) continue;
        const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
        const noteText = spon.status === 'unaccounted_sponsorship'
          ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
          : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));
        const auditDebt = getFareForDate(spon.date);
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

  const actuallySponsoredIds = new Set<string>();
  const actuallySponsoredKeys = new Set<string>();
  for (const a of audits) {
    if (a.status === 'actually_sponsored') {
      if (a.ledger_entry_id) actuallySponsoredIds.add(String(a.ledger_entry_id));
      const d = normalizeDateToYMD(a.date) || a.date;
      actuallySponsoredKeys.add(`${sanitizePassengerDisplayName(a.passenger_name).toLowerCase()}:::${d}`);
    }
  }

  // Filter out zero-debt items, settled items, removed items, actually-sponsored items, parse numeric debt, and sanitize boilerplate notes
  const activeLedger = ledger
    .filter((entry) => {
      if (entry.status === 'Paid' || entry.status === 'Settled' || entry.status === 'Removed') return false;
      if (actuallySponsoredIds.has(String(entry.id))) return false;
      const dateStr = normalizeDateToYMD(entry.date as string) || (entry.manifest_key ? String(entry.manifest_key).split('_')[0] : (entry.date as string) || '');
      if (entry.sponsored) {
        const key = `${sanitizePassengerDisplayName(entry.passenger_name as string).toLowerCase()}:::${dateStr}`;
        if (actuallySponsoredKeys.has(key)) return false;
      }
      let rawVal = entry.structure_debt;
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        rawVal = entry.fee;
      }
      const debt = parseDebtAmount(rawVal, dateStr);
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
  const settledEntries = ledger.filter((entry) => idSet.has(entry.id));
  const settledNow = new Date().toISOString();
  ledger = ledger.map((entry) => {
    if (idSet.has(entry.id)) {
      return {
        ...entry,
        status: 'Settled',
        structure_debt: 0,
        settled_at: settledNow,
      };
    }
    return entry;
  });
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
  res.json({ success: true, count: settledEntries.length });
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

  const parsedDebt = typeof entry.structure_debt === 'number'
    ? entry.structure_debt
    : (entry.structure_debt !== undefined && entry.structure_debt !== null && entry.structure_debt !== ''
        ? Number(entry.structure_debt) || getFareForDate(entry.date)
        : getFareForDate(entry.date));

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
    structure_debt: parsedDebt,
    fee: parsedDebt,
    status: 'Unpaid',
    general_notes: noteText,
    submitted_at: entry.submitted_at || new Date().toISOString(),
  };

  const ledger = readJsonFile<Array<unknown>>(LEDGER_FILE, []);
  ledger.unshift(newEntry);
  atomicWriteJson(LEDGER_FILE, ledger);

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, entry: newEntry });
});

// Remove specific ledger entry (durable removal)
// Remove specific ledger entry (durable removal)
app.delete('/api/ledger/:id', async (req, res) => {
  const id = req.params.id;
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const nowIso = new Date().toISOString();
  let found = false;
  let removedItem: Record<string, unknown> | null = null;

  ledger = ledger.filter((e) => {
    if (e.id === id) {
      found = true;
      removedItem = e;
      return false;
    }
    return true;
  });
  atomicWriteJson(LEDGER_FILE, ledger);

  const cleanName = removedItem ? sanitizePassengerDisplayName(String(removedItem.passenger_name || '')).toLowerCase() : '';
  const normName = cleanName.replace(/[^a-z0-9]/g, '');

  // Record tombstone into removed ledger keys
  const removedKeys = [id];
  if (removedItem?.manifest_key && cleanName) removedKeys.push(`${removedItem.manifest_key}:::${cleanName}`);
  if (removedItem?.date && cleanName) removedKeys.push(`${normalizeDateToYMD(String(removedItem.date))}:::${cleanName}`);
  recordRemovedLedgerKeys(removedKeys);

  // Synchronize with sponsorship audits so it does not resurrect
  let audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  let auditChanged = false;
  const sponTombstones: string[] = [];

  audits = audits.map((a) => {
    const aName = sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase();
    const aNorm = aName.replace(/[^a-z0-9]/g, '');
    if (
      String(a.ledger_entry_id) === id ||
      (cleanName && (aName === cleanName || aNorm === normName))
    ) {
      auditChanged = true;
      if (a.id) sponTombstones.push(String(a.id));
      const bDate = normalizeDateToYMD(String(a.date || a.manifest_key || ''));
      if (bDate && aNorm) sponTombstones.push(`${bDate}::${aNorm}`);
      return {
        ...a,
        status: 'actually_sponsored',
        status_updated_at: nowIso,
        ledger_entry_id: null,
        sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled / Removed from ledger)` : 'Settled / Removed from ledger',
      };
    }
    return a;
  });

  if (sponTombstones.length > 0) {
    recordRemovedSponsorshipKeys(sponTombstones);
  }

  if (auditChanged) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  if (serverSupabase && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    serverSupabase.from('cancellation_ledger').update({ status: 'Removed', structure_debt: 0 }).eq('id', id).catch(() => {});
  }

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, removed: found ? 1 : 0 });
});

// Batch remove ledger entries (durable removal)
app.post('/api/ledger/batch-delete', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.json({ success: true, count: 0 });
    return;
  }
  const idSet = new Set(ids.map(String));
  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const nowIso = new Date().toISOString();
  const removedEntries = ledger.filter((e) => idSet.has(String(e.id)));

  ledger = ledger.filter((e) => !idSet.has(String(e.id)));
  atomicWriteJson(LEDGER_FILE, ledger);

  const removedKeys: string[] = Array.from(idSet);
  for (const r of removedEntries) {
    const rName = sanitizePassengerDisplayName(String(r.passenger_name || '')).toLowerCase();
    if (rName) {
      if (r.manifest_key) removedKeys.push(`${r.manifest_key}:::${rName}`);
      if (r.date) removedKeys.push(`${normalizeDateToYMD(String(r.date))}:::${rName}`);
    }
  }
  recordRemovedLedgerKeys(removedKeys);

  // Synchronize with sponsorship audits so they do not resurrect
  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  let auditChanged = false;
  const removedNames = new Set(removedEntries.map((r) => sanitizePassengerDisplayName(String(r.passenger_name || '')).toLowerCase()).filter(Boolean));
  const sponTombstones: string[] = [];

  for (let i = 0; i < audits.length; i++) {
    const a = audits[i];
    const aName = sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase();
    const aNorm = aName.replace(/[^a-z0-9]/g, '');
    if (
      idSet.has(String(a.ledger_entry_id || '')) ||
      (aName && removedNames.has(aName))
    ) {
      audits[i] = {
        ...a,
        status: 'actually_sponsored',
        status_updated_at: nowIso,
        ledger_entry_id: null,
        sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled / Removed from ledger)` : 'Settled / Removed from ledger',
      };
      auditChanged = true;
      if (a.id) sponTombstones.push(String(a.id));
      const bDate = normalizeDateToYMD(String(a.date || a.manifest_key || ''));
      if (bDate && aNorm) sponTombstones.push(`${bDate}::${aNorm}`);
    }
  }

  if (sponTombstones.length > 0) {
    recordRemovedSponsorshipKeys(sponTombstones);
  }

  if (auditChanged) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  if (serverSupabase) {
    const isUUID = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));
    const uuids = Array.from(idSet).filter(isUUID);
    if (uuids.length > 0) {
      serverSupabase.from('cancellation_ledger').update({ status: 'Removed', structure_debt: 0 }).in('id', uuids).catch(() => {});
    }
  }

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, count: removedEntries.length });
});

// Permanently delete an entire debtor and all their instances across ledger and sponsorships
app.post('/api/ledger/delete-debtor', async (req, res) => {
  const { name, entryIds } = req.body || {};
  if (!name && (!Array.isArray(entryIds) || entryIds.length === 0)) {
    res.status(400).json({ error: 'Debtor name or entryIds are required' });
    return;
  }

  const cleanName = sanitizePassengerDisplayName(String(name || ''));
  const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const idSet = new Set((Array.isArray(entryIds) ? entryIds : []).map(String));

  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const nowIso = new Date().toISOString();

  const isMatchingEntry = (e: Record<string, unknown>) => {
    if (idSet.has(String(e.id))) return true;
    if (cleanName) {
      const eName = sanitizePassengerDisplayName(String(e.passenger_name || ''));
      if (eName.toLowerCase() === cleanName.toLowerCase()) return true;
      if (normName && eName.toLowerCase().replace(/[^a-z0-9]/g, '') === normName) return true;
    }
    return false;
  };

  const toRemove = ledger.filter(isMatchingEntry);
  const removedKeys: string[] = [];
  if (normName) removedKeys.push(normName);
  if (cleanName) removedKeys.push(cleanName.toLowerCase());

  for (const r of toRemove) {
    if (r.id) removedKeys.push(String(r.id));
    const rName = sanitizePassengerDisplayName(String(r.passenger_name || '')).toLowerCase();
    if (r.manifest_key && rName) removedKeys.push(`${r.manifest_key}:::${rName}`);
    if (r.date && rName) removedKeys.push(`${normalizeDateToYMD(String(r.date))}:::${rName}`);
  }
  recordRemovedLedgerKeys(removedKeys);

  // Remove matching entries from active ledger
  ledger = ledger.filter((e) => !isMatchingEntry(e));
  atomicWriteJson(LEDGER_FILE, ledger);

  // Synchronize linked sponsorships so they never resurrect
  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const sponTombstones: string[] = [];
  if (normName) sponTombstones.push(normName);
  let auditChanged = false;

  for (let i = 0; i < audits.length; i++) {
    const a = audits[i];
    const aName = sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase();
    const aNorm = aName.replace(/[^a-z0-9]/g, '');
    const isAuditMatch = (
      idSet.has(String(a.id || '')) ||
      idSet.has(String(a.ledger_entry_id || '')) ||
      (cleanName && (aName === cleanName.toLowerCase() || aNorm === normName))
    );

    if (isAuditMatch) {
      audits[i] = {
        ...a,
        status: 'actually_sponsored',
        status_updated_at: nowIso,
        ledger_entry_id: null,
        sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Debtor removed from ledger)` : 'Debtor removed from ledger',
      };
      auditChanged = true;
      if (a.id) sponTombstones.push(String(a.id));
      const baseDate = normalizeDateToYMD(String(a.date || a.manifest_key || ''));
      if (baseDate && aNorm) sponTombstones.push(`${baseDate}::${aNorm}`);
      if (a.passenger_id) sponTombstones.push(String(a.passenger_id));
    }
  }

  if (sponTombstones.length > 0) {
    recordRemovedSponsorshipKeys(sponTombstones);
  }

  if (auditChanged) {
    atomicWriteJson(SPONSORSHIPS_FILE, audits);
    syncSponsorshipUpsertToSupabase(audits).catch(() => {});
    broadcastSse('sponsorships_updated', { timestamp: Date.now() });
  }

  // Synchronize Supabase cancellation_ledger if available
  if (serverSupabase) {
    try {
      const isUUID = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));
      const uuids = Array.from(idSet).filter(isUUID);
      if (uuids.length > 0) {
        await serverSupabase.from('cancellation_ledger').update({ status: 'Removed', structure_debt: 0 }).in('id', uuids);
      }
      if (cleanName) {
        await serverSupabase.from('cancellation_ledger').update({ status: 'Removed', structure_debt: 0 }).ilike('passenger_name', cleanName);
      }
    } catch (sbErr) {
      console.warn('[Server] Supabase delete-debtor sync note:', sbErr);
    }
  }

  broadcastSse('ledger_updated', { timestamp: Date.now() });
  res.json({ success: true, count: toRemove.length });
});

// Update specific ledger entry (e.g. partial payment or fee adjustment)
app.patch('/api/ledger/:id', (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  const ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const idx = ledger.findIndex((e) => e.id === id);
  if (idx !== -1) {
    const wasZeroDebt = updates.structure_debt !== undefined && Number(updates.structure_debt) <= 0;
    if (wasZeroDebt) {
      ledger[idx] = {
        ...ledger[idx],
        ...updates,
        status: 'Settled',
        structure_debt: 0,
        settled_at: new Date().toISOString(),
        settled_by: 'Cancellation Admin',
      };
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
      if (wasZeroDebt) {
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
app.post('/api/ledger/update-debtor', async (req, res) => {
  const { existingEntryIds, updates } = req.body || {};
  if (!Array.isArray(existingEntryIds) || existingEntryIds.length === 0) {
    res.status(400).json({ error: 'existingEntryIds array is required' });
    return;
  }

  let ledger = readJsonFile<Array<Record<string, unknown>>>(LEDGER_FILE, []);
  const audits = readJsonFile<Array<Record<string, unknown>>>(SPONSORSHIPS_FILE, []);
  const existingSet = new Set(existingEntryIds.map(String));
  const existingEntries = ledger.filter((e) => existingSet.has(String(e.id)));
  const cleanName = updates?.name ? String(updates.name).trim() : '';
  const rawStruct = updates?.structure ? normalizeStructureCode(String(updates.structure).trim()) : 'No Structure';
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

  const origNames = Array.from(new Set([
    ...existingEntries.map((e) => sanitizePassengerDisplayName(String(e.passenger_name || '')).toLowerCase()),
    ...audits.filter((a) => existingSet.has(String(a.id)) || (a.ledger_entry_id && existingSet.has(String(a.ledger_entry_id)))).map((a) => sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase()),
    cleanName.toLowerCase()
  ])).filter(Boolean);

  const instances = Array.isArray(updates?.instances) ? updates.instances : [];
  // If the person's debt for a particular date or service was reduced to zero, remove that debt
  const activeInstances = instances.filter((inst) => {
    const amt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
    return Number.isFinite(amt) && amt > 0;
  });

  let auditChanged = false;
  const isAuditMatch = (a: Record<string, unknown>) => {
    if (existingSet.has(String(a.id || ''))) return true;
    if (existingSet.has(String(a.ledger_entry_id || ''))) return true;
    const aName = sanitizePassengerDisplayName(String(a.passenger_name || '')).toLowerCase();
    return origNames.includes(aName);
  };

  const nowIso = new Date().toISOString();

  if (activeInstances.length === 0) {
    // Settle/remove all entries for this debtor when debt is reduced to zero
    ledger = ledger.filter((e) => !existingSet.has(String(e.id)));

    const removedKeys: string[] = Array.from(existingSet);
    if (cleanName) {
      removedKeys.push(cleanName.toLowerCase());
      removedKeys.push(cleanName.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }
    for (const r of existingEntries) {
      const rName = sanitizePassengerDisplayName(String(r.passenger_name || '')).toLowerCase();
      if (rName) {
        if (r.manifest_key) removedKeys.push(`${r.manifest_key}:::${rName}`);
        if (r.date) removedKeys.push(`${normalizeDateToYMD(String(r.date))}:::${rName}`);
      }
    }
    recordRemovedLedgerKeys(removedKeys);

    // Also update any linked sponsorships so they do not resurrect
    const sponTombstones: string[] = [];
    if (cleanName) sponTombstones.push(cleanName.toLowerCase().replace(/[^a-z0-9]/g, ''));

    for (let i = 0; i < audits.length; i++) {
      if (isAuditMatch(audits[i])) {
        audits[i].status = 'actually_sponsored';
        audits[i].status_updated_at = nowIso;
        audits[i].ledger_entry_id = null;
        audits[i].sponsor_note = `${audits[i].sponsor_note || ''} (Settled / Debt removed)`.trim();
        auditChanged = true;
        if (audits[i].id) sponTombstones.push(String(audits[i].id));
        const bDate = normalizeDateToYMD(String(audits[i].date || audits[i].manifest_key || ''));
        const aNorm = sanitizePassengerDisplayName(String(audits[i].passenger_name || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (bDate && aNorm) sponTombstones.push(`${bDate}::${aNorm}`);
      }
    }
    if (sponTombstones.length > 0) {
      recordRemovedSponsorshipKeys(sponTombstones);
    }
    if (auditChanged) {
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
      syncSponsorshipUpsertToSupabase(audits).catch(() => {});
      broadcastSse('sponsorships_updated', { timestamp: Date.now() });
    }
  } else {
    const template = existingEntries[0] || ledger.find((e) => existingSet.has(String(e.id))) || {};
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
            fee: validAmt,
            sponsored: isSponsored,
            debt_type: debtType,
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
          debt_type: debtType,
          sponsor_note: isSponsored ? noteText : '',
          structure_debt: validAmt,
          fee: validAmt,
          general_notes: noteText,
          submitted_at: nowIso,
        });
      }
    }

    // Remove any entries that were reduced to zero or omitted and tombstone them
    const removedEntryIds = Array.from(existingSet).filter((id) => !updatedIds.has(id));
    if (removedEntryIds.length > 0) {
      recordRemovedLedgerKeys(removedEntryIds);
    }
    ledger = ledger.filter((e) => !existingSet.has(String(e.id)) || updatedIds.has(String(e.id)));

    // Ensure all other historical or linked records for this debtor in active/historical ledger also display updated name
    if (cleanName) {
      for (let i = 0; i < ledger.length; i++) {
        const lName = sanitizePassengerDisplayName(String(ledger[i].passenger_name || '')).toLowerCase();
        if (origNames.includes(lName) || existingSet.has(String(ledger[i].id))) {
          ledger[i].passenger_name = cleanName;
          if (rawStruct && rawStruct !== 'No Structure') {
            ledger[i].structure = rawStruct;
          }
        }
      }

      // Untomb cleanName if it was previously tombstoned so the renamed debtor is never hidden
      const removedKeys = getRemovedLedgerKeys();
      const lowerClean = cleanName.toLowerCase();
      const normClean = lowerClean.replace(/[^a-z0-9]/g, '');
      const filteredKeys = removedKeys.filter((k) => k !== lowerClean && k !== normClean);
      if (filteredKeys.length !== removedKeys.length) {
        atomicWriteJson(REMOVED_LEDGER_KEYS_FILE, filteredKeys);
      }
    }

    // Synchronize linked sponsorships if debt was edited or type changed
    const primaryId = Array.from(updatedIds)[0] || null;
    for (let i = 0; i < audits.length; i++) {
      if (isAuditMatch(audits[i])) {
        if (!isSponsored) {
          // Changed to cancellation (not sponsored)
          if (cleanName) audits[i].passenger_name = cleanName;
          if (rawStruct) audits[i].structure = rawStruct;
          audits[i].status = 'actually_sponsored';
          audits[i].status_updated_at = nowIso;
          audits[i].ledger_entry_id = null;
          audits[i].sponsor_note = audits[i].sponsor_note
            ? `${audits[i].sponsor_note} (Reclassified as regular cancellation)`.trim()
            : 'Reclassified as regular cancellation';
          auditChanged = true;
        } else {
          if (cleanName) audits[i].passenger_name = cleanName;
          if (rawStruct) audits[i].structure = rawStruct;
          audits[i].sponsor_note = noteText;
          audits[i].status = debtType;
          audits[i].status_updated_at = nowIso;
          if (primaryId) audits[i].ledger_entry_id = primaryId;
          auditChanged = true;
        }
      }
    }
    if (auditChanged) {
      atomicWriteJson(SPONSORSHIPS_FILE, audits);
      syncSponsorshipUpsertToSupabase(audits).catch(() => {});
      broadcastSse('sponsorships_updated', { timestamp: Date.now() });
    }
  }

  // Sync to Supabase cancellation_ledger if available
  if (serverSupabase) {
    try {
      const isUUID = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));
      if (activeInstances.length === 0) {
        const uuids = existingEntryIds.filter(isUUID);
        if (uuids.length > 0) {
          await serverSupabase.from('cancellation_ledger').update({ status: 'Settled', structure_debt: 0 }).in('id', uuids);
        }
      } else {
        for (const inst of activeInstances) {
          const validAmt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
          const validDate = inst.date ? String(inst.date).trim() : '';
          const validService = inst.service ? String(inst.service).trim() : 'PM';
          if (inst.id && isUUID(inst.id)) {
            await serverSupabase.from('cancellation_ledger').update({
              passenger_name: cleanName,
              structure: rawStruct,
              structure_debt: validAmt,
              fee: validAmt,
              date: validDate,
              service: validService,
              sponsored: isSponsored,
              sponsor_note: isSponsored ? noteText : '',
              general_notes: noteText,
            }).eq('id', inst.id);
          }
        }
      }

      // Also update any other historical or linked records for this debtor across Supabase tables
      if (cleanName) {
        for (const prevName of origNames) {
          if (prevName && prevName !== cleanName.toLowerCase()) {
            serverSupabase.from('cancellation_ledger').update({ passenger_name: cleanName, structure: rawStruct }).ilike('passenger_name', prevName).catch(() => {});
            serverSupabase.from('sponsorship_audits').update({ passenger_name: cleanName, structure: rawStruct }).ilike('passenger_name', prevName).catch(() => {});
          }
        }
      }
    } catch (sbErr) {
      console.warn('[Server] Supabase cancellation_ledger sync error during update-debtor:', sbErr);
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
