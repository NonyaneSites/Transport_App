import type { Manifest, Vehicle, VehicleDraftState, LiveSyncAction } from '@/lib/types';
import type { LedgerEntry, AbsenteeInput } from '@/lib/ledger';

export interface SubmitVehiclePayload {
  vehicleId: string;
  vehicle?: Vehicle;
  allVehicles?: Vehicle[];
  repName: string;
  licensePlate: string;
  coReps?: string[];
  generalNotes?: string;
  draftState: VehicleDraftState;
  absentees: AbsenteeInput[];
  sponsoredRiders?: Array<{
    id: string;
    fullName: string;
    structure?: string;
    stop?: string;
    vehicleName?: string;
    vehicle_name?: string;
    taxiName?: string;
    sponsorNote?: string;
  }>;
  unpaidRiders?: Array<{
    id: string;
    fullName: string;
    structure?: string;
    stop?: string;
    unpaidNote?: string;
  }>;
  allRiderNames: string[];
  serviceLabel: string;
  parsedDate: string;
  updatedSignups?: Manifest['signups'];
}

export type SponsorshipStatus = 'pending' | 'actually_sponsored' | 'unpaid_sponsorship' | 'unaccounted_sponsorship';

export interface ReportedSponsorship {
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
  status: SponsorshipStatus;
  status_updated_at?: string;
  ledger_entry_id?: string | null;
  submitted_at: string;
}

export interface ReopenVehiclePayload {
  vehicleId: string;
  allRiderNames: string[];
}

export interface ManifestSummary {
  date: string;
  updated_at?: string;
  vehiclesCount: number;
  signupsCount: number;
  submittedCount: number;
}

const PENDING_QUEUE_KEY = 'crc_pending_submissions_queue';

let serverAvailable: boolean | null = null;

export function isServerOnline(): boolean {
  if (typeof window === 'undefined') return false;
  return serverAvailable !== false;
}

export function markServerOffline(): void {
  serverAvailable = false;
}

export function markServerOnline(): void {
  serverAvailable = true;
}

function isJsonResponse(res: Response): boolean {
  if (res.status === 404) {
    markServerOffline();
    return false;
  }
  const cType = res.headers.get('content-type') || '';
  if (cType.includes('text/html')) {
    // This is an SPA rewrite returning index.html, NOT a backend API server!
    markServerOffline();
    return false;
  }
  return cType.includes('application/json');
}

interface PendingQueueItem {
  id: string;
  type: 'submit_vehicle' | 'save_manifest' | 'reopen_vehicle';
  key: string;
  payload: unknown;
  timestamp: number;
}

function getPendingQueue(): PendingQueueItem[] {
  if (!isServerOnline()) {
    try {
      localStorage.removeItem(PENDING_QUEUE_KEY);
    } catch {
      // ignore
    }
    return [];
  }
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePendingQueue(queue: PendingQueueItem[]): void {
  if (!isServerOnline()) return;
  try {
    localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore storage errors
  }
}

export function queueOfflineAction(type: PendingQueueItem['type'], key: string, payload: unknown): void {
  if (!isServerOnline()) return;
  const queue = getPendingQueue();
  queue.push({
    id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    key,
    payload,
    timestamp: Date.now(),
  });
  savePendingQueue(queue);
}

// Flush pending queue when network is restored
export async function flushPendingQueue(): Promise<number> {
  const queue = getPendingQueue();
  if (queue.length === 0 || !isServerOnline()) return 0;

  const remaining: PendingQueueItem[] = [];
  let flushedCount = 0;

  for (const item of queue) {
    try {
      if (item.type === 'submit_vehicle') {
        await submitVehicleToServer(item.key, item.payload as SubmitVehiclePayload, false);
        flushedCount++;
      } else if (item.type === 'save_manifest') {
        await saveManifestToServer(item.payload as Manifest, false);
        flushedCount++;
      } else if (item.type === 'reopen_vehicle') {
        await reopenVehicleOnServer(item.key, item.payload as ReopenVehiclePayload, false);
        flushedCount++;
      }
    } catch {
      remaining.push(item);
    }
  }

  savePendingQueue(remaining);
  return flushedCount;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (getPendingQueue().length > 0) {
      flushPendingQueue().catch(() => {});
    }
  });
  // Periodic background check for queued items — only when items exist and tab is visible!
  setInterval(() => {
    if (
      navigator.onLine &&
      isServerOnline() &&
      (typeof document === 'undefined' || !document.hidden) &&
      getPendingQueue().length > 0
    ) {
      flushPendingQueue().catch(() => {});
    }
  }, 60000);
}

export async function fetchManifestFromServer(key: string): Promise<Manifest | null> {
  if (!isServerOnline()) return null;
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}`);
    if (!res.ok || !isJsonResponse(res)) return null;
    markServerOnline();
    const data = await res.json();
    const manifest = (data && data.manifest ? data.manifest : data) as Manifest;
    return manifest && typeof manifest === 'object' && Array.isArray(manifest.vehicles) ? manifest : null;
  } catch (err) {
    console.warn('[ServerAPI] fetchManifest error:', err);
    return null;
  }
}

export async function saveManifestToServer(manifest: Manifest, allowQueue = true): Promise<Manifest> {
  if (!isServerOnline()) {
    if (allowQueue) queueOfflineAction('save_manifest', manifest.date, manifest);
    return manifest;
  }
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(manifest.date)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    if (!res.ok || !isJsonResponse(res)) throw new Error(`HTTP ${res.status}`);
    markServerOnline();
    const data = await res.json();
    return data.manifest as Manifest;
  } catch (err) {
    if (allowQueue) {
      queueOfflineAction('save_manifest', manifest.date, manifest);
    }
    throw err;
  }
}

export async function submitVehicleToServer(
  key: string,
  payload: SubmitVehiclePayload,
  allowQueue = true
): Promise<{ success: boolean; manifest: Manifest; submittedAt: string }> {
  if (!isServerOnline()) {
    if (allowQueue) queueOfflineAction('submit_vehicle', key, payload);
    return { success: true, manifest: { date: key, signups: [], vehicles: [] }, submittedAt: new Date().toISOString() };
  }
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}/submit-vehicle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !isJsonResponse(res)) throw new Error(`HTTP ${res.status}`);
    markServerOnline();
    const data = await res.json();
    return data;
  } catch (err) {
    if (allowQueue) {
      queueOfflineAction('submit_vehicle', key, payload);
    }
    throw err;
  }
}

export async function reopenVehicleOnServer(
  key: string,
  payload: ReopenVehiclePayload,
  allowQueue = true
): Promise<{ success: boolean; manifest: Manifest }> {
  if (!isServerOnline()) {
    if (allowQueue) queueOfflineAction('reopen_vehicle', key, payload);
    return { success: true, manifest: { date: key, signups: [], vehicles: [] } };
  }
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}/reopen-vehicle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !isJsonResponse(res)) throw new Error(`HTTP ${res.status}`);
    markServerOnline();
    const data = await res.json();
    return data;
  } catch (err) {
    if (allowQueue) {
      queueOfflineAction('reopen_vehicle', key, payload);
    }
    throw err;
  }
}

export async function updateVehicleDraftOnServer(
  key: string,
  vehicleId: string,
  draftState: Partial<VehicleDraftState>,
  repName?: string,
  licensePlate?: string,
  fullVehicle?: Vehicle,
  manifest?: Manifest
): Promise<void> {
  if (!isServerOnline()) return;
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId, draftState, repName, licensePlate, fullVehicle, manifest }),
    });
    if (res.ok && isJsonResponse(res)) {
      markServerOnline();
    }
  } catch (err) {
    console.debug('[ServerAPI] updateVehicleDraft note:', err);
  }
}

export async function listManifestsFromServer(): Promise<ManifestSummary[]> {
  if (!isServerOnline()) return [];
  try {
    const res = await fetch('/api/manifests');
    if (!res.ok || !isJsonResponse(res)) return [];
    markServerOnline();
    return await res.json();
  } catch {
    return [];
  }
}

export async function listLedgerFromServer(): Promise<LedgerEntry[]> {
  if (!isServerOnline()) return [];
  try {
    const res = await fetch('/api/ledger');
    if (!res.ok || !isJsonResponse(res)) return [];
    markServerOnline();
    return await res.json();
  } catch {
    return [];
  }
}

export async function settleLedgerOnServer(ids: string[]): Promise<number> {
  if (!isServerOnline()) return 0;
  try {
    const res = await fetch('/api/ledger/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok || !isJsonResponse(res)) return 0;
    markServerOnline();
    const data = await res.json();
    return data.count || 0;
  } catch {
    return 0;
  }
}

export async function addManualLedgerOnServer(entry: Partial<LedgerEntry>): Promise<LedgerEntry | null> {
  if (!isServerOnline()) return null;
  try {
    const res = await fetch('/api/ledger/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok || !isJsonResponse(res)) return null;
    markServerOnline();
    const data = await res.json();
    return data.entry;
  } catch {
    return null;
  }
}

export async function deleteLedgerOnServer(id: string): Promise<boolean> {
  if (!isServerOnline()) return false;
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok && isJsonResponse(res)) {
      markServerOnline();
    }
    return res.ok;
  } catch {
    return false;
  }
}

export async function updateLedgerOnServer(id: string, updates: Record<string, unknown>): Promise<boolean> {
  if (!isServerOnline()) return false;
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok && isJsonResponse(res)) {
      markServerOnline();
    }
    return res.ok;
  } catch {
    return false;
  }
}

export async function updateDebtorOnServer(payload: {
  existingEntryIds: string[];
  updates: {
    name: string;
    structure: string;
    isSponsored?: boolean;
    notes?: string;
    instances: Array<{ id?: string; date: string; service: string; amount: number }>;
  };
}): Promise<boolean> {
  if (!isServerOnline()) return false;
  try {
    const res = await fetch('/api/ledger/update-debtor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok && isJsonResponse(res)) {
      markServerOnline();
    }
    return res.ok;
  } catch {
    return false;
  }
}

// Fetch reported sponsorships from server
export async function listReportedSponsorshipsFromServer(): Promise<ReportedSponsorship[]> {
  if (!isServerOnline()) return [];
  try {
    const res = await fetch('/api/ledger/sponsorships');
    if (!res.ok || !isJsonResponse(res)) return [];
    markServerOnline();
    return (await res.json()) as ReportedSponsorship[];
  } catch (err) {
    console.warn('[ServerAPI] listReportedSponsorships error:', err);
    return [];
  }
}

// Verify or update a reported sponsorship status
export async function verifySponsorshipOnServer(
  sponsorshipId: string,
  status: SponsorshipStatus
): Promise<{ success: boolean; sponsorship?: ReportedSponsorship; ledgerUpdated?: boolean }> {
  if (!isServerOnline()) return { success: false };
  try {
    const res = await fetch('/api/ledger/verify-sponsorship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sponsorshipId, status }),
    });
    if (!res.ok || !isJsonResponse(res)) {
      return { success: false };
    }
    markServerOnline();
    return (await res.json()) as { success: boolean; sponsorship?: ReportedSponsorship; ledgerUpdated?: boolean };
  } catch (err) {
    console.warn('[ServerAPI] verifySponsorship error:', err);
    return { success: false };
  }
}

// Batch verify or update reported sponsorships
export async function verifyBatchSponsorshipsOnServer(
  items: Array<{ sponsorshipId: string; status: SponsorshipStatus }>
): Promise<{ success: boolean; updatedCount: number; ledgerUpdated?: boolean }> {
  if (!isServerOnline()) return { success: false, updatedCount: 0 };
  try {
    const res = await fetch('/api/ledger/verify-sponsorships-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok || !isJsonResponse(res)) {
      return { success: false, updatedCount: 0 };
    }
    markServerOnline();
    return (await res.json()) as { success: boolean; updatedCount: number; ledgerUpdated?: boolean };
  } catch (err) {
    console.warn('[ServerAPI] verifyBatchSponsorships error:', err);
    return { success: false, updatedCount: 0 };
  }
}

// Record reported sponsorships to central server
export async function recordReportedSponsorshipsOnServer(
  sponsorships: ReportedSponsorship[]
): Promise<void> {
  if (!isServerOnline()) return;
  try {
    const res = await fetch('/api/ledger/sponsorships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sponsorships }),
    });
    if (res.ok && isJsonResponse(res)) {
      markServerOnline();
    }
  } catch (err) {
    console.debug('[ServerAPI] recordReportedSponsorships error:', err);
  }
}

// Broadcast lightweight live action to central server for instant cross-device delivery (localhost dev only)
export async function broadcastLiveActionToServer(action: LiveSyncAction): Promise<void> {
  if (!isServerOnline()) return;
  try {
    const res = await fetch('/api/sync/live-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!res.ok || !isJsonResponse(res)) {
      markServerOffline();
    }
  } catch {
    markServerOffline();
  }
}

// Server-Sent Events (SSE) live connection with local event sync
export function connectSyncEvents(
  onManifestUpdate?: (data: { key: string; manifest?: Manifest }) => void,
  onLedgerUpdate?: () => void,
  onDraftDelta?: (data: { key: string; vehicleId: string; draftState: VehicleDraftState; repName?: string; licensePlate?: string }) => void,
  onSponsorshipsUpdate?: () => void,
  onLiveAction?: (action: LiveSyncAction) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  // Local window and cross-tab storage listeners for instant updates
  const handleSponsorshipsEvent = () => onSponsorshipsUpdate?.();
  const handleLedgerEvent = () => onLedgerUpdate?.();
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === 'crc_sponsorship_audits') {
      onSponsorshipsUpdate?.();
    } else if (e.key?.includes('cancellation_ledger')) {
      onLedgerUpdate?.();
    }
  };

  window.addEventListener('crc_sponsorships_updated', handleSponsorshipsEvent);
  window.addEventListener('crc_ledger_updated', handleLedgerEvent);
  window.addEventListener('storage', handleStorageEvent);

  // If running on Vercel / production or server is offline, Supabase Realtime channels and BroadcastChannel handle all synchronization.
  // Return early to prevent any EventSource connection attempts to /api/sync/events.
  if (!isServerOnline()) {
    return () => {
      window.removeEventListener('crc_sponsorships_updated', handleSponsorshipsEvent);
      window.removeEventListener('crc_ledger_updated', handleLedgerEvent);
      window.removeEventListener('storage', handleStorageEvent);
    };
  }

  let es: EventSource | null = null;
  let isClosed = false;

  const handleVisibility = () => {
    if (typeof document !== 'undefined' && !document.hidden && !isClosed) {
      if (!es && isServerOnline()) {
        connect();
      }
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  function connect() {
    if (isClosed || !window.EventSource || !isServerOnline()) return;

    try {
      es = new EventSource('/api/sync/events');

      es.onopen = () => {
        markServerOnline();
      };

      es.addEventListener('manifest_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          onManifestUpdate?.(data);
        } catch {
          /* ignore parse error */
        }
      });

      es.addEventListener('ledger_updated', () => {
        onLedgerUpdate?.();
      });

      es.addEventListener('sponsorships_updated', () => {
        onSponsorshipsUpdate?.();
      });

      es.addEventListener('vehicle_draft_delta', (e) => {
        try {
          const data = JSON.parse(e.data);
          onDraftDelta?.(data);
        } catch {
          /* ignore parse error */
        }
      });

      es.addEventListener('live_action', (e) => {
        try {
          const action = JSON.parse(e.data);
          onLiveAction?.(action as LiveSyncAction);
        } catch {
          /* ignore parse error */
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        markServerOffline();
      };
    } catch {
      markServerOffline();
    }
  }

  connect();

  return () => {
    isClosed = true;
    es?.close();
    es = null;
    window.removeEventListener('crc_sponsorships_updated', handleSponsorshipsEvent);
    window.removeEventListener('crc_ledger_updated', handleLedgerEvent);
    window.removeEventListener('storage', handleStorageEvent);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
  };
}
