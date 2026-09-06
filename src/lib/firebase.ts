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

// Soft connection check to test if cloud Firestore is reachable
let isFirestoreAvailable = false;
export function isFirestoreOnline(): boolean {
  return isFirestoreAvailable;
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, MANIFESTS_COLLECTION, '_connection_check'));
    isFirestoreAvailable = true;
    console.info('[Firebase] Connected to Cloud Firestore database:', FIRESTORE_DB_ID);
  } catch (error) {
    isFirestoreAvailable = false;
    if (error instanceof Error && error.message.includes('the client is offline')) {
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
      console.debug('[Firebase] Firestore onSnapshot error:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Loads a manifest document once from Firestore.
 */
export async function getManifestFirestore(key: string): Promise<Manifest | null> {
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
    if (err instanceof Error && err.message.includes('the client is offline')) {
      return [];
    }
    console.debug('[Firebase] listManifestsFirestore error:', err);
    return [];
  }
}

/**
 * Saves or updates a manifest document in Firestore.
 */
export async function saveManifestFirestore(manifest: Manifest): Promise<void> {
  try {
    const docRef = doc(db, MANIFESTS_COLLECTION, manifest.date);
    await setDoc(
      docRef,
      {
        date: manifest.date,
        signups: manifest.signups || [],
        vehicles: manifest.vehicles || [],
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error('[Firebase] saveManifestFirestore error:', err);
    throw err;
  }
}

/**
 * Appends a Walk-in passenger to the manifest using a Firestore transaction.
 * Allows multiple users to append walk-ins simultaneously without race conditions,
 * and updates Firestore in real time so all peers receive the new passenger immediately.
 */
export async function appendWalkInTransaction(
  key: string,
  vehicleId: string,
  walkInPassenger: Passenger,
  extraDraftUpdate?: Partial<VehicleDraftState>
): Promise<Manifest> {
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

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

    // Deduplicate passenger if already added
    const existingIndex = currentManifest.signups.findIndex((p) => p.id === walkInPassenger.id);
    let nextSignups: Passenger[];
    if (existingIndex >= 0) {
      nextSignups = [...currentManifest.signups];
      nextSignups[existingIndex] = { ...currentManifest.signups[existingIndex], ...walkInPassenger };
    } else {
      nextSignups = [...currentManifest.signups, walkInPassenger];
    }

    // Update target vehicle
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

      // Concurrency-safe draft state: preserves existing remote draft arrays (sponsored, unpaid, present)
      // while safely merging any caller metadata (repName, licensePlate)
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

    const updatedManifest: Manifest = {
      ...currentManifest,
      signups: nextSignups,
      vehicles: nextVehicles,
      updated_at: new Date().toISOString(),
    };

    tx.set(
      docRef,
      {
        date: key,
        signups: nextSignups,
        vehicles: nextVehicles,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    return updatedManifest;
  });
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
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

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
}

/**
 * Atomically toggles a rider's Sponsored status in Firestore.
 * This guarantees that turning off sponsorship updates immediately across all devices.
 */
export async function toggleRiderSponsoredInFirestore(
  key: string,
  vehicleId: string,
  riderId: string,
  sponsored: boolean,
  updaterClientId: string
): Promise<void> {
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

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
}

/**
 * Atomically toggles a rider's Did Not Pay (unpaid) status in Firestore.
 * This guarantees that turning off didNotPay updates immediately across all devices.
 */
export async function toggleRiderUnpaidInFirestore(
  key: string,
  vehicleId: string,
  riderId: string,
  unpaid: boolean,
  updaterClientId: string
): Promise<void> {
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

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
  const docRef = doc(db, MANIFESTS_COLLECTION, key);

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
}
