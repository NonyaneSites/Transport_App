import type { Manifest, VehicleDraftState } from '@/lib/types';
import type { LedgerEntry, AbsenteeInput } from '@/lib/ledger';

export interface SubmitVehiclePayload {
  vehicleId: string;
  repName: string;
  licensePlate: string;
  coReps?: string[];
  generalNotes?: string;
  draftState: VehicleDraftState;
  absentees: AbsenteeInput[];
  allRiderNames: string[];
  serviceLabel: string;
  parsedDate: string;
  updatedSignups?: Manifest['signups'];
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

interface PendingQueueItem {
  id: string;
  type: 'submit_vehicle' | 'save_manifest' | 'reopen_vehicle';
  key: string;
  payload: unknown;
  timestamp: number;
}

function getPendingQueue(): PendingQueueItem[] {
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePendingQueue(queue: PendingQueueItem[]): void {
  try {
    localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore storage errors
  }
}

export function queueOfflineAction(type: PendingQueueItem['type'], key: string, payload: unknown): void {
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
  if (queue.length === 0) return 0;

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
    flushPendingQueue().catch(() => {});
  });
  // Periodic background check for queued items
  setInterval(() => {
    if (navigator.onLine) {
      flushPendingQueue().catch(() => {});
    }
  }, 10000);
}

export async function fetchManifestFromServer(key: string): Promise<Manifest | null> {
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data as Manifest;
  } catch (err) {
    console.warn('[ServerAPI] fetchManifest error:', err);
    return null;
  }
}

export async function saveManifestToServer(manifest: Manifest, allowQueue = true): Promise<Manifest> {
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(manifest.date)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}/submit-vehicle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  try {
    const res = await fetch(`/api/manifests/${encodeURIComponent(key)}/reopen-vehicle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  licensePlate?: string
): Promise<void> {
  try {
    await fetch(`/api/manifests/${encodeURIComponent(key)}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId, draftState, repName, licensePlate }),
    });
  } catch (err) {
    console.debug('[ServerAPI] updateVehicleDraft note:', err);
  }
}

export async function listManifestsFromServer(): Promise<ManifestSummary[]> {
  try {
    const res = await fetch('/api/manifests');
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function listLedgerFromServer(): Promise<LedgerEntry[]> {
  try {
    const res = await fetch('/api/ledger');
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function settleLedgerOnServer(ids: string[]): Promise<number> {
  try {
    const res = await fetch('/api/ledger/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.count || 0;
  } catch {
    return 0;
  }
}

export async function addManualLedgerOnServer(entry: Partial<LedgerEntry>): Promise<LedgerEntry | null> {
  try {
    const res = await fetch('/api/ledger/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.entry;
  } catch {
    return null;
  }
}

export async function deleteLedgerOnServer(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/ledger/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// Server-Sent Events (SSE) live connection
export function connectSyncEvents(
  onManifestUpdate: (data: { key: string; manifest?: Manifest }) => void,
  onLedgerUpdate?: () => void,
  onDraftDelta?: (data: { key: string; vehicleId: string; draftState: VehicleDraftState }) => void
): () => void {
  if (typeof window === 'undefined' || !window.EventSource) {
    return () => {};
  }

  let es: EventSource | null = null;
  let isClosed = false;

  function connect() {
    if (isClosed) return;
    try {
      es = new EventSource('/api/sync/events');

      es.addEventListener('manifest_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          onManifestUpdate(data);
        } catch {
          /* ignore parse error */
        }
      });

      es.addEventListener('ledger_updated', () => {
        onLedgerUpdate?.();
      });

      es.addEventListener('vehicle_draft_delta', (e) => {
        try {
          const data = JSON.parse(e.data);
          onDraftDelta?.(data);
        } catch {
          /* ignore parse error */
        }
      });

      es.onerror = () => {
        es?.close();
        if (!isClosed) {
          setTimeout(connect, 3000);
        }
      };
    } catch {
      if (!isClosed) {
        setTimeout(connect, 3000);
      }
    }
  }

  connect();

  return () => {
    isClosed = true;
    es?.close();
  };
}
