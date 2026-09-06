import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  onSnapshot,
  runTransaction,
  getDocFromServer,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import type { Manifest, Passenger, VehicleDraftState, Vehicle } from './types';
import { hubDisplayName } from './types';

// Load Firebase configuration
const firebaseConfig = {
  projectId: "gen-lang-client-0297349205",
  appId: "1:504215512188:web:6e1d8d4db5a9b0445615f9",
  apiKey: "AIzaSyBA6k7qsRwPN56Mb1yhdTfqszmBJFHTMwM",
  authDomain: "gen-lang-client-0297349205.firebaseapp.com",
  storageBucket: "gen-lang-client-0297349205.firebasestorage.app",
  messagingSenderId: "504215512188",
};

export const FIRESTORE_DB_ID = "ai-studio-transportapp-b74aac46-a732-4583-b1c3-03a02fbd62a2";

export const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const db: Firestore = getFirestore(app, FIRESTORE_DB_ID);

export const MANIFESTS_COLLECTION = 'transport_manifests';

const QUOTA_STORAGE_KEY = 'crc_firestore_quota_exhausted';

// In-memory flag initialized from sessionStorage if previously exhausted
let isQuotaExhausted = false;
try {
  const stored = typeof window !== 'undefined' ? sessionStorage.getItem(QUOTA_STORAGE_KEY) : null;
  if (stored) {
    const parsed = JSON.parse(stored);
    // Mark exhausted for 6 hours
    if (Date.now() - (parsed.timestamp || 0) < 6 * 3600 * 1000) {
      isQuotaExhausted = true;
    }
  }
} catch {
  // ignore storage errors
}

export function isFirestoreQuotaExceeded(): boolean {
  return isQuotaExhausted;
}

export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '';
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  return (
    code === 'resource-exhausted' ||
    msg.includes('resource-exhausted') ||
    msg.includes('Quota limit exceeded') ||
    msg.includes('Free daily write units') ||
    msg.includes('quota metric') ||
    msg.includes('quota limits are reset')
  );
}

export function markFirestoreQuotaExhausted(err?: unknown): void {
  if (!isQuotaExhausted) {
    isQuotaExhausted = true;
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify({ timestamp: Date.now() }));
      }
    } catch {
      // ignore
    }
    console.info(
      '[Firebase] Free daily Firestore write quota reached. Firestore cloud writes suspended; application seamlessly operating via local storage, Supabase, and real-time tab sync.',
      err ? (err as Error).message || err : ''
    );
  }
}

// Soft connection check to test if cloud Firestore is reachable
let isFirestoreAvailable = false;
export function isFirestoreOnline(): boolean {
  return isFirestoreAvailable && !isQuotaExhausted;
}

async function testConnection() {
  if (isQuotaExhausted) return;
  try {
    await getDocFromServer(doc(db, MANIFESTS_COLLECTION, '_connection_check'));
    isFirestoreAvailable = true;
    console.info('[Firebase] Connected to Cloud Firestore database:', FIRESTORE_DB_ID);
  } catch (error) {
    isFirestoreAvailable = false;
    if (isQuotaError(error)) {
      markFirestoreQuotaExhausted(error);
    } else if (error instanceof Error && error.message.includes('the client is offline')) {
      console.info('[Firebase] Firestore is in offline mode (local storage fallback active).');
    } else {
      console.warn('[Firebase] Connection check:', error);
    }
  }
}
testConnection().catch(() => {});

/**
 * Subscribes to realtime updates for a manifest document in Firestore.
 * Automatically receives changes (walk-ins, attendance, sponsored, etc.)
 * across all connected users without requiring a page refresh.
 */
export function subscribeToManifestFirestore(
  key: string,
  onUpdate: (manifest: Manifest | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const manifestDocRef = doc(db, MANIFESTS_COLLECTION, key);

  return onSnapshot(
    manifestDocRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onUpdate(null);
        return;
      }
      const data = snapshot.data();
      if (!data) {
        onUpdate(null);
        return;
      }

      const normalized: Manifest = {
        date: data.date || key,
        signups: Array.isArray(data.signups) ? data.signups : [],
        vehicles: Array.isArray(data.vehicles)
          ? data.vehicles.map((v: Vehicle) => ({
              ...v,
              riders: Array.isArray(v.riders) ? v.riders : [],
              orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
            }))
          : [],
        created_at: data.created_at || data.createdAt,
        updated_at: data.updated_at || data.updatedAt,
      };
      onUpdate(normalized);
    },
    (err) => {
      if (err instanceof Error && err.message.includes('the client is offline')) {
        // Normal offline fallback
        return;
      }
      if (isQuotaError(err)) {
        markFirestoreQuotaExhausted(err);
        return;
      }
      console.debug('[Firebase] Firestore onSnapshot error:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Loads a manifest document once from Firestore.
 */
export async function getManifestFirestore(key: string): Promise<Manifest | null> {
  if (isFirestoreQuotaExceeded()) return null;
  try {
    const docRef = doc(db, MANIFESTS_COLLECTION, key);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      date: data.date || key,
      signups: Array.isArray(data.signups) ? data.signups : [],
      vehicles: Array.isArray(data.vehicles)
        ? data.vehicles.map((v: Vehicle) => ({
            ...v,
            riders: Array.isArray(v.riders) ? v.riders : [],
            orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
          }))
        : [],
      created_at: data.created_at || data.createdAt,
      updated_at: data.updated_at || data.updatedAt,
    };
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return null;
    }
    if (err instanceof Error && err.message.includes('the client is offline')) {
      // Normal when Firestore is not yet provisioned in the cloud project
      return null;
    }
    console.debug('[Firebase] getManifestFirestore error:', err);
    return null;
  }
}

/**
 * Lists all manifests stored in Cloud Firestore.
 */
export async function listManifestsFirestore(): Promise<Manifest[]> {
  if (isFirestoreQuotaExceeded()) return [];
  try {
    const colRef = collection(db, MANIFESTS_COLLECTION);
    const snap = await getDocs(colRef);
    const results: Manifest[] = [];
    snap.forEach((d) => {
      // Ignore internal system documents
      if (d.id.startsWith('_')) return;
      const data = d.data();
      results.push({
        date: data.date || d.id,
        signups: Array.isArray(data.signups) ? data.signups : [],
        vehicles: Array.isArray(data.vehicles)
          ? data.vehicles.map((v: Vehicle) => ({
              ...v,
              riders: Array.isArray(v.riders) ? v.riders : [],
              orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
            }))
          : [],
        created_at: data.created_at || data.createdAt,
        updated_at: data.updated_at || data.updatedAt,
      });
    });
    return results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return [];
    }
    if (err instanceof Error && err.message.includes('the client is offline')) {
      return [];
    }
    console.debug('[Firebase] listManifestsFirestore error:', err);
    return [];
  }
}

/**
 * Recursively strips any undefined values from an object or array so that
 * Firestore setDoc/updateDoc never throws "Unsupported field value: undefined".
 */
export function deepCleanForFirestore<T>(data: T): T {
  if (data === null || data === undefined) return null as unknown as T;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    return data.map((item) => deepCleanForFirestore(item)) as unknown as T;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value !== undefined) {
      clean[key] = deepCleanForFirestore(value);
    }
  }
  return clean as T;
}

/**
 * Saves or updates a manifest document in Firestore.
 */
export async function saveManifestFirestore(manifest: Manifest): Promise<void> {
  if (isFirestoreQuotaExceeded()) {
    // Quota exhausted: skip writing to Firestore to avoid backoff delays and quota errors
    return;
  }
  try {
    const docRef = doc(db, MANIFESTS_COLLECTION, manifest.date);
    const payload = deepCleanForFirestore({
      date: manifest.date,
      signups: manifest.signups || [],
      vehicles: manifest.vehicles || [],
      updatedAt: new Date().toISOString(),
    });
    await setDoc(docRef, payload, { merge: true });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return;
    }
    console.warn('[Firebase] saveManifestFirestore error:', err);
    throw err;
  }
}

/**
 * Pure function to apply a walk-in passenger to a manifest without database dependencies.
 */
export function applyWalkInToManifest(
  currentManifest: Manifest,
  vehicleId: string,
  walkInPassenger: Passenger,
  extraDraftUpdate?: Partial<VehicleDraftState>
): Manifest {
  const existingIndex = currentManifest.signups.findIndex((p) => p.id === walkInPassenger.id);
  let nextSignups: Passenger[];
  if (existingIndex >= 0) {
    nextSignups = [...currentManifest.signups];
    nextSignups[existingIndex] = { ...currentManifest.signups[existingIndex], ...walkInPassenger };
  } else {
    nextSignups = [...currentManifest.signups, walkInPassenger];
  }

  const poolKey = hubDisplayName(
    currentManifest.vehicles.find((v) => v.id === vehicleId)?.type,
    walkInPassenger.stop || 'Walk-In'
  );

  const nextVehicles = currentManifest.vehicles.map((v) => {
    if (v.id !== vehicleId) return v;

    const riders = Array.isArray(v.riders) ? v.riders : [];
    const nextRiders = riders.includes(walkInPassenger.id) ? riders : [...riders, walkInPassenger.id];

    const orderedStops = Array.isArray(v.orderedStops) ? v.orderedStops : [];
    const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];

    const currentDraft = v.draftState || {};
    const presentIds = currentDraft.presentIds || [];
    const nextPresentIds = presentIds.includes(walkInPassenger.id)
      ? presentIds
      : [...presentIds, walkInPassenger.id];

    const absentIds = (currentDraft.absentIds || []).filter((id) => id !== walkInPassenger.id);

    const nextDraftState: VehicleDraftState = {
      ...currentDraft,
      repName: extraDraftUpdate?.repName?.trim() || currentDraft.repName || v.repName || '',
      licensePlate: extraDraftUpdate?.licensePlate?.trim() || currentDraft.licensePlate || v.licensePlate || '',
      generalNotes: extraDraftUpdate?.generalNotes !== undefined ? extraDraftUpdate.generalNotes : (currentDraft.generalNotes || ''),
      notes: { ...(currentDraft.notes || {}), ...(extraDraftUpdate?.notes || {}) },
      presentIds: nextPresentIds,
      absentIds,
      sponsoredIds: currentDraft.sponsoredIds || [],
      unpaidIds: currentDraft.unpaidIds || [],
      updatedAt: new Date().toISOString(),
      updatedBy: extraDraftUpdate?.updatedBy || currentDraft.updatedBy,
    };

    return {
      ...v,
      riders: nextRiders,
      orderedStops: nextOrderedStops,
      draftState: nextDraftState,
    };
  });

  return {
    ...currentManifest,
    signups: nextSignups,
    vehicles: nextVehicles,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Appends a Walk-in passenger to the manifest using a Firestore transaction when available,
 * or gracefully returns the updated manifest when cloud quota is exhausted.
 */
export async function appendWalkInTransaction(
  key: string,
  vehicleId: string,
  walkInPassenger: Passenger,
  extraDraftUpdate?: Partial<VehicleDraftState>
): Promise<Manifest> {
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

  if (isFirestoreQuotaExceeded()) {
    const existing = (await getManifestFirestore(key)) || { date: key, signups: [], vehicles: [] };
    return applyWalkInToManifest(existing, vehicleId, walkInPassenger, extraDraftUpdate);
  }

  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      let currentManifest: Manifest;

      if (!snap.exists()) {
        currentManifest = {
          date: key,
          signups: [],
          vehicles: [],
        };
      } else {
        const data = snap.data();
        currentManifest = {
          date: data.date || key,
          signups: Array.isArray(data.signups) ? data.signups : [],
          vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
        };
      }

      const updatedManifest = applyWalkInToManifest(currentManifest, vehicleId, walkInPassenger, extraDraftUpdate);

      tx.set(
        docRef,
        {
          date: key,
          signups: updatedManifest.signups,
          vehicles: updatedManifest.vehicles,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      return updatedManifest;
    });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      const existing = (await getManifestFirestore(key)) || { date: key, signups: [], vehicles: [] };
      return applyWalkInToManifest(existing, vehicleId, walkInPassenger, extraDraftUpdate);
    }
    console.warn('[Firebase] appendWalkInTransaction error:', err);
    throw err;
  }
}

/**
 * Atomically updates a vehicle's draft in Firestore.
 */
export async function updateVehicleDraftInFirestore(
  key: string,
  vehicleId: string,
  draftState: Partial<VehicleDraftState>,
  repName?: string,
  licensePlate?: string
): Promise<void> {
  if (isFirestoreQuotaExceeded()) return;

  const docRef = doc(db, MANIFESTS_COLLECTION, key);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

      const updatedVehicles = vehicles.map((v: Vehicle) => {
        if (v.id !== vehicleId) return v;

        const curDraft = v.draftState || {};
        const nextDraft: VehicleDraftState = {
          ...curDraft,
          ...draftState,
          updatedAt: new Date().toISOString(),
        };

        return {
          ...v,
          repName: repName !== undefined ? repName : (v.repName || ''),
          licensePlate: licensePlate !== undefined ? licensePlate : (v.licensePlate || ''),
          draftState: nextDraft,
        };
      });

      tx.update(docRef, {
        vehicles: updatedVehicles,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return;
    }
    console.warn('[Firebase] updateVehicleDraftInFirestore error:', err);
  }
}

/**
 * Atomically toggles a rider's Sponsored status in Firestore.
 */
export async function toggleRiderSponsoredInFirestore(
  key: string,
  vehicleId: string,
  riderId: string,
  sponsored: boolean,
  updaterClientId: string
): Promise<void> {
  if (isFirestoreQuotaExceeded()) return;

  const docRef = doc(db, MANIFESTS_COLLECTION, key);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

      const updatedVehicles = vehicles.map((v: Vehicle) => {
        if (v.id !== vehicleId) return v;

        const curDraft = v.draftState || {};
        const curSponsored = new Set(curDraft.sponsoredIds || []);
        if (sponsored) {
          curSponsored.add(riderId);
        } else {
          curSponsored.delete(riderId);
        }

        return {
          ...v,
          draftState: {
            ...curDraft,
            sponsoredIds: Array.from(curSponsored),
            updatedAt: new Date().toISOString(),
            updatedBy: updaterClientId,
          },
        };
      });

      tx.update(docRef, {
        vehicles: updatedVehicles,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return;
    }
    console.warn('[Firebase] toggleRiderSponsoredInFirestore error:', err);
  }
}

/**
 * Atomically toggles a rider's Did Not Pay (unpaid) status in Firestore.
 */
export async function toggleRiderUnpaidInFirestore(
  key: string,
  vehicleId: string,
  riderId: string,
  unpaid: boolean,
  updaterClientId: string
): Promise<void> {
  if (isFirestoreQuotaExceeded()) return;

  const docRef = doc(db, MANIFESTS_COLLECTION, key);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

      const updatedVehicles = vehicles.map((v: Vehicle) => {
        if (v.id !== vehicleId) return v;

        const curDraft = v.draftState || {};
        const curUnpaid = new Set(curDraft.unpaidIds || []);
        if (unpaid) {
          curUnpaid.add(riderId);
        } else {
          curUnpaid.delete(riderId);
        }

        return {
          ...v,
          draftState: {
            ...curDraft,
            unpaidIds: Array.from(curUnpaid),
            updatedAt: new Date().toISOString(),
            updatedBy: updaterClientId,
          },
        };
      });

      tx.update(docRef, {
        vehicles: updatedVehicles,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return;
    }
    console.warn('[Firebase] toggleRiderUnpaidInFirestore error:', err);
  }
}

/**
 * Atomically updates a rider's attendance status in Firestore.
 */
export async function setRiderAttendanceInFirestore(
  key: string,
  vehicleId: string,
  riderId: string,
  status: 'present' | 'absent' | 'unticked',
  updaterClientId: string
): Promise<void> {
  if (isFirestoreQuotaExceeded()) return;

  const docRef = doc(db, MANIFESTS_COLLECTION, key);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];

      const updatedVehicles = vehicles.map((v: Vehicle) => {
        if (v.id !== vehicleId) return v;

        const curDraft = v.draftState || {};
        const curPresent = new Set(curDraft.presentIds || []);
        const curAbsent = new Set(curDraft.absentIds || []);

        if (status === 'present') {
          curPresent.add(riderId);
          curAbsent.delete(riderId);
        } else if (status === 'absent') {
          curAbsent.add(riderId);
          curPresent.delete(riderId);
        } else {
          curPresent.delete(riderId);
          curAbsent.delete(riderId);
        }

        return {
          ...v,
          draftState: {
            ...curDraft,
            presentIds: Array.from(curPresent),
            absentIds: Array.from(curAbsent),
            updatedAt: new Date().toISOString(),
            updatedBy: updaterClientId,
          },
        };
      });

      tx.update(docRef, {
        vehicles: updatedVehicles,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    if (isQuotaError(err)) {
      markFirestoreQuotaExhausted(err);
      return;
    }
    console.warn('[Firebase] setRiderAttendanceInFirestore error:', err);
  }
}
