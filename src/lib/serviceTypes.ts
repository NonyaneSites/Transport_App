import { useState, useEffect, useCallback } from 'react';
import type { ServiceTypeConfig } from './types';

export const DEFAULT_SERVICE_TYPES: ServiceTypeConfig[] = [
  { value: 'AM_Serving', label: 'AM Service — Serving Only', acronym: 'AM', period: 'AM', mode: 'Serving', isSystem: true },
  { value: 'AM_Ushers', label: 'AM Service — Ushers (Early)', acronym: 'AM', period: 'AM', mode: 'Ushers', isSystem: true },
  { value: 'AM_Normal', label: 'AM Service — Normal Only', acronym: 'AM', period: 'AM', mode: 'Normal', isSystem: true },
  { value: 'PM_Serving', label: 'PM Service — Serving Only', acronym: 'PM', period: 'PM', mode: 'Serving', isSystem: true },
  { value: 'PM_Normal', label: 'PM Service — Normal Only', acronym: 'PM', period: 'PM', mode: 'Normal', isSystem: true },
];

const CUSTOM_STORAGE_KEY = 'crc_custom_services_v2';
const LEGACY_STORAGE_KEY = 'crc_service_types_v1';

// In-memory reactive state
let memoryServiceTypes: ServiceTypeConfig[] = loadInitialServiceTypes();
const listeners = new Set<(types: ServiceTypeConfig[]) => void>();

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener(memoryServiceTypes);
    } catch (err) {
      console.warn('[ServiceTypes] Listener error:', err);
    }
  }
}

function loadInitialServiceTypes(): ServiceTypeConfig[] {
  // Purge legacy storage key if present to remove any obsolete default injections
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }

  const customTypes: ServiceTypeConfig[] = [];
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          // Never re-add Funeral_Service as a default if stale
          if (item && item.value && item.label && !item.isSystem) {
            customTypes.push({
              value: item.value,
              label: item.label,
              acronym: (item.acronym || item.value.slice(0, 3)).trim().toUpperCase(),
              period: item.period || 'AM',
              mode: item.mode || 'Special',
              description: item.description || '',
              isCustom: true,
              isSystem: false,
              createdAt: item.createdAt,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[ServiceTypes] Failed to load custom service types:', err);
  }

  return [...DEFAULT_SERVICE_TYPES, ...customTypes];
}

function saveCustomToStorage(types: ServiceTypeConfig[]) {
  try {
    const customOnly = types.filter((s) => s.isCustom && !s.isSystem);
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customOnly));
  } catch {
    // localStorage full or disabled
  }
}

/**
 * Returns current snapshot of service types
 */
export function getActiveServiceTypes(): ServiceTypeConfig[] {
  return [...memoryServiceTypes];
}

/**
 * Finds a service config by value, label, or acronym
 */
export function getServiceConfig(
  identifier?: string | null,
  customList?: ServiceTypeConfig[]
): ServiceTypeConfig | undefined {
  if (!identifier) return undefined;
  const list = customList && customList.length > 0 ? customList : memoryServiceTypes;
  const clean = identifier.trim().toLowerCase();

  // 1. Exact value match
  const byVal = list.find((s) => s.value.toLowerCase() === clean);
  if (byVal) return byVal;

  // 2. Exact acronym match
  const byAcr = list.find((s) => s.acronym.toLowerCase() === clean);
  if (byAcr) return byAcr;

  // 3. Exact label match
  const byLbl = list.find((s) => s.label.toLowerCase() === clean);
  if (byLbl) return byLbl;

  // 4. Partial label or acronym match
  return list.find(
    (s) =>
      clean.includes(s.label.toLowerCase()) ||
      s.label.toLowerCase().includes(clean) ||
      clean.includes(s.value.toLowerCase())
  );
}

/**
 * Returns the normalized cancellation acronym for any service string.
 * e.g. "Funeral Service" -> "FS", "Funeral_Service" -> "FS", "PM_Normal" -> "PM", "AM" -> "AM"
 */
export function getServiceAcronym(
  serviceStr?: string | null,
  customList?: ServiceTypeConfig[]
): string {
  if (!serviceStr) return 'PM';
  const clean = serviceStr.trim();
  const cfg = getServiceConfig(clean, customList);
  if (cfg && cfg.acronym) {
    return cfg.acronym.trim().toUpperCase();
  }

  // Check known historical church codes
  const upper = clean.toUpperCase();
  if (upper.includes('FUNERAL') || upper === 'FS') return 'FS';
  if (upper.includes('DREAMWEEK') || upper.includes('DREAM WEEK')) {
    if (upper.includes('AM') || upper.includes('MORNING')) return 'DWM';
    if (upper.includes('PM') || upper.includes('EVENING')) return 'DWE';
    return 'DW';
  }
  if (upper.startsWith('AM')) return 'AM';
  if (upper.startsWith('PM')) return 'PM';
  if (upper === 'LM' || upper.includes('LEADER')) return 'LM';
  if (upper === 'WMP' || (upper.includes('WORSHIP') && upper.includes('PRAYER'))) return 'WMP';
  if (upper === 'EF' || upper.includes('EASTER')) return 'EF';
  if (upper === 'AD' || upper.includes('ASCENSION')) return 'AD';
  if (upper === 'FW' || upper.includes('FAST')) return 'FW';

  // Fallback: first word or clean uppercase code (max 6 chars)
  const token = clean.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return token || 'PM';
}

/**
 * Returns the user-friendly label for a service type value
 */
export function getServiceLabel(
  serviceStr?: string | null,
  customList?: ServiceTypeConfig[]
): string {
  if (!serviceStr) return 'Service';
  const cfg = getServiceConfig(serviceStr, customList);
  return cfg ? cfg.label : serviceStr;
}

/**
 * Fetch all service types from the server
 */
export async function fetchServiceTypesFromServer(): Promise<ServiceTypeConfig[]> {
  try {
    const res = await fetch('/api/service-types');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Filter out any obsolete system Funeral_Service if an old server state is returned
        const clean = data.filter((s) => s.value !== 'Funeral_Service' || s.isCustom);
        memoryServiceTypes = clean;
        saveCustomToStorage(clean);
        notifyListeners();
        return clean;
      }
    }
  } catch (err) {
    console.debug('[ServiceTypes] Server fetch skipped, using local cache:', err);
  }
  return memoryServiceTypes;
}

/**
 * Add or update a service type (saves to server and local state)
 */
export async function addServiceTypeToServer(
  payload: {
    label: string;
    acronym: string;
    period?: 'AM' | 'PM' | 'OTHER';
    mode?: 'Serving' | 'Normal' | 'Ushers' | 'Special';
    description?: string;
    value?: string;
  }
): Promise<ServiceTypeConfig> {
  const cleanLabel = payload.label.trim();
  const cleanAcronym = (payload.acronym || cleanLabel.slice(0, 3)).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanVal = (payload.value || cleanLabel.replace(/[^a-zA-Z0-9]+/g, '_')).trim();

  const newConfig: ServiceTypeConfig = {
    value: cleanVal,
    label: cleanLabel,
    acronym: cleanAcronym || 'SP',
    period: payload.period || 'AM',
    mode: payload.mode || 'Special',
    description: payload.description?.trim() || '',
    isCustom: true,
    isSystem: false,
    createdAt: new Date().toISOString(),
  };

  // Optimistic update
  const map = new Map<string, ServiceTypeConfig>();
  for (const item of memoryServiceTypes) {
    map.set(item.value, item);
  }
  map.set(newConfig.value, newConfig);
  memoryServiceTypes = Array.from(map.values());
  saveCustomToStorage(memoryServiceTypes);
  notifyListeners();

  try {
    const res = await fetch('/api/service-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    });
    if (res.ok) {
      const serverTypes = await res.json();
      if (Array.isArray(serverTypes)) {
        memoryServiceTypes = serverTypes;
        saveCustomToStorage(serverTypes);
        notifyListeners();
      }
    }
  } catch (err) {
    console.warn('[ServiceTypes] Failed to sync new service type to server:', err);
  }

  return newConfig;
}

/**
 * Delete a custom service type
 */
export async function deleteServiceTypeFromServer(value: string): Promise<boolean> {
  // Prevent deleting system types
  const target = memoryServiceTypes.find((s) => s.value === value);
  if (target?.isSystem) {
    throw new Error('System service types cannot be removed.');
  }

  // Remove from memory immediately
  memoryServiceTypes = memoryServiceTypes.filter((s) => s.value !== value);
  // Persist updated custom types immediately
  saveCustomToStorage(memoryServiceTypes);
  notifyListeners();

  try {
    const res = await fetch(`/api/service-types/${encodeURIComponent(value)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const serverTypes = await res.json();
      if (Array.isArray(serverTypes)) {
        const cleaned = serverTypes.filter((s) => s.value !== value);
        memoryServiceTypes = cleaned;
        saveCustomToStorage(cleaned);
        notifyListeners();
      }
      return true;
    }
  } catch (err) {
    console.warn('[ServiceTypes] Failed to delete on server:', err);
  }
  return true;
}

/**
 * React hook to access and subscribe to available service types
 */
export function useServiceTypes() {
  const [types, setTypes] = useState<ServiceTypeConfig[]>(memoryServiceTypes);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const listener = (next: ServiceTypeConfig[]) => {
      setTypes([...next]);
    };
    listeners.add(listener);

    // Initial server fetch
    setLoading(true);
    fetchServiceTypesFromServer().finally(() => {
      setLoading(false);
    });

    return () => {
      listeners.delete(listener);
    };
  }, []);

  const addService = useCallback(async (payload: {
    label: string;
    acronym: string;
    period?: 'AM' | 'PM' | 'OTHER';
    mode?: 'Serving' | 'Normal' | 'Ushers' | 'Special';
    description?: string;
    value?: string;
  }) => {
    return await addServiceTypeToServer(payload);
  }, []);

  const deleteService = useCallback(async (value: string) => {
    return await deleteServiceTypeFromServer(value);
  }, []);

  return {
    serviceTypes: types,
    loading,
    addServiceType: addService,
    deleteServiceType: deleteService,
    refresh: fetchServiceTypesFromServer,
  };
}
