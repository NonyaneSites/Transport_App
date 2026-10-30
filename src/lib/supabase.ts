import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : (process.env as unknown as Record<string, string>);
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined)?.trim();
const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

export const MANIFESTS_TABLE = 'transport_manifests';
export const LEDGER_TABLE = 'cancellation_ledger';
export const VEHICLES_TABLE = 'transport_vehicles';
export const SPONSORSHIPS_TABLE = 'sponsorship_audits';
export const PROFILES_TABLE = 'profiles';
export const AUDITS_TABLE = 'cancellation_ledger_audits';
export const VEHICLE_AUTH_TABLE = 'vehicle_authorizations';
export const CLAIM_LIMITS_TABLE = 'vehicle_claim_rate_limits';

export function simpleHashCred(salt: string, cred: string): string {
  let hash = 0;
  const str = salt + cred;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export const isConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseUrl.startsWith('http') &&
  !supabaseUrl.includes('placeholder')
);
export const isSupabaseConfigured = isConfigured;

type TableRow = Record<string, unknown>;

interface StoragePayload {
  eventType: string;
  new?: TableRow;
  old?: TableRow;
}

// Local in-memory / localStorage storage engine for offline/fallback mode
export class MockSupabaseStorage {
  private memoryStore: Record<string, TableRow[]> = {
    [MANIFESTS_TABLE]: [],
    [LEDGER_TABLE]: [],
    [VEHICLES_TABLE]: [],
    [SPONSORSHIPS_TABLE]: [],
    [PROFILES_TABLE]: [],
    [AUDITS_TABLE]: [],
    [VEHICLE_AUTH_TABLE]: [],
    [CLAIM_LIMITS_TABLE]: [],
  };
  private listeners: Set<(table: string, payload: StoragePayload) => void> = new Set();

  constructor() {
    this.loadFromLocalStorage();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key?.startsWith('crc_transport_')) {
          this.loadFromLocalStorage();
        }
      });
    }
  }

  loadFromLocalStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const manifests = localStorage.getItem(`crc_transport_${MANIFESTS_TABLE}`);
      if (manifests) {
        const parsed = JSON.parse(manifests);
        if (Array.isArray(parsed)) this.memoryStore[MANIFESTS_TABLE] = parsed;
      }
      const ledger = localStorage.getItem(`crc_transport_${LEDGER_TABLE}`);
      if (ledger) {
        const parsed = JSON.parse(ledger);
        if (Array.isArray(parsed)) this.memoryStore[LEDGER_TABLE] = parsed;
      }
      const vehicles = localStorage.getItem(`crc_transport_${VEHICLES_TABLE}`);
      if (vehicles) {
        const parsed = JSON.parse(vehicles);
        if (Array.isArray(parsed)) this.memoryStore[VEHICLES_TABLE] = parsed;
      }
      const sponsorships = localStorage.getItem(`crc_transport_${SPONSORSHIPS_TABLE}`);
      if (sponsorships) {
        const parsed = JSON.parse(sponsorships);
        if (Array.isArray(parsed)) this.memoryStore[SPONSORSHIPS_TABLE] = parsed;
      }
      const profiles = localStorage.getItem(`crc_transport_${PROFILES_TABLE}`);
      if (profiles) {
        const parsed = JSON.parse(profiles);
        if (Array.isArray(parsed)) this.memoryStore[PROFILES_TABLE] = parsed;
      }
    } catch {
      // Ignore local storage parse errors
    }
  }

  saveToLocalStorage(table: string) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(`crc_transport_${table}`, JSON.stringify(this.memoryStore[table] ?? []));
    } catch {
      // Ignore storage quota errors
    }
  }

  getTable(table: string): TableRow[] {
    return this.memoryStore[table] ?? [];
  }

  setTable(table: string, rows: TableRow[]) {
    this.memoryStore[table] = rows;
    this.saveToLocalStorage(table);
  }

  upsert(table: string, row: TableRow, keyCol?: string) {
    const col = keyCol || (table === MANIFESTS_TABLE ? 'date' : 'id');
    const existing = this.getTable(table);
    const keyVal = row[col];
    const filtered = existing.filter((r) => String(r[col] ?? '') !== String(keyVal ?? ''));
    filtered.push(row);
    this.setTable(table, filtered);
    this.notify(table, 'UPSERT', row);
  }

  notify(table: string, event: string, row: TableRow) {
    this.listeners.forEach((fn) => {
      try {
        fn(table, { eventType: event, new: row, old: row });
      } catch {
        // Ignore callback error
      }
    });
  }

  addListener(fn: (table: string, payload: StoragePayload) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const mockStorage = new MockSupabaseStorage();

interface FilterCondition {
  (row: TableRow): boolean;
}

interface ChannelFilter {
  table?: string;
  filter?: string;
  schema?: string;
  event?: string;
}

export class MockQueryBuilder {
  private tableName: string;
  private mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private filters: FilterCondition[] = [];
  private sortCol: string | null = null;
  private sortAsc = true;
  private limitCount: number | null = null;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private rowsToInsertOrUpsert: TableRow[] = [];
  private onConflictKey: string = 'id';
  private updatesToApply: Record<string, unknown> = {};

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  select(_cols?: string) {
    void _cols;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row: TableRow) => String(row[col] ?? '') === String(val ?? ''));
    return this;
  }

  in(col: string, vals: unknown[]) {
    const valSet = new Set((vals || []).map((v) => String(v ?? '')));
    this.filters.push((row: TableRow) => valSet.has(String(row[col] ?? '')));
    return this;
  }

  ilike(col: string, val: unknown) {
    const pattern = String(val ?? '').toLowerCase();
    this.filters.push((row: TableRow) => {
      const rowVal = String(row[col] ?? '').toLowerCase();
      if (pattern.includes('%')) {
        const regexStr = '^' + pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        return new RegExp(regexStr, 'i').test(rowVal);
      }
      return rowVal === pattern;
    });
    return this;
  }

  like(col: string, val: unknown) {
    const pattern = String(val ?? '');
    this.filters.push((row: TableRow) => {
      const rowVal = String(row[col] ?? '');
      if (pattern.includes('%')) {
        const regexStr = '^' + pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        return new RegExp(regexStr).test(rowVal);
      }
      return rowVal === pattern;
    });
    return this;
  }

  neq(col: string, val: unknown) {
    this.filters.push((row: TableRow) => String(row[col] ?? '') !== String(val ?? ''));
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push((row: TableRow) => (val === null ? row[col] == null : row[col] === val));
    return this;
  }

  order(col: string, { ascending = true }: { ascending?: boolean } = {}) {
    this.sortCol = col;
    this.sortAsc = ascending;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number) {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  insert(rows: TableRow | TableRow[]) {
    this.mode = 'insert';
    this.rowsToInsertOrUpsert = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rowOrRows: TableRow | TableRow[], opts: { onConflict?: string } = {}) {
    this.mode = 'upsert';
    this.rowsToInsertOrUpsert = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    if (opts.onConflict) this.onConflictKey = opts.onConflict;
    return this;
  }

  update(updates: Record<string, unknown>) {
    this.mode = 'update';
    this.updatesToApply = updates;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  private execute(): { data: unknown; error: null } {
    const now = new Date().toISOString();
    const generateUUID = (): string => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };

    if (this.mode === 'insert') {
      const rowsToInsert = this.rowsToInsertOrUpsert.map((r) => ({
        ...r,
        id: r.id || generateUUID(),
        created_at: r.created_at || now,
        updated_at: r.updated_at || now,
        submitted_at: r.submitted_at || now,
      }));
      const current = mockStorage.getTable(this.tableName);
      mockStorage.setTable(this.tableName, [...current, ...rowsToInsert]);
      rowsToInsert.forEach((r) => mockStorage.notify(this.tableName, 'INSERT', r));
      return { data: rowsToInsert, error: null };
    }

    if (this.mode === 'upsert') {
      const current = [...mockStorage.getTable(this.tableName)];
      const resultRows: TableRow[] = [];
      const keyField = this.onConflictKey;

      for (const item of this.rowsToInsertOrUpsert) {
        const fullItem = {
          ...item,
          id: item.id || generateUUID(),
          updated_at: now,
          created_at: item.created_at || now,
        };
        const idx = current.findIndex((r) => String((r as Record<string, unknown>)[keyField] ?? '') === String((fullItem as Record<string, unknown>)[keyField] ?? ''));
        if (idx !== -1) {
          current[idx] = { ...current[idx], ...fullItem };
          mockStorage.notify(this.tableName, 'UPDATE', current[idx]);
          resultRows.push(current[idx]);
        } else {
          current.push(fullItem);
          mockStorage.notify(this.tableName, 'INSERT', fullItem);
          resultRows.push(fullItem);
        }
      }
      mockStorage.setTable(this.tableName, current);
      return { data: resultRows, error: null };
    }

    if (this.mode === 'update') {
      const current = mockStorage.getTable(this.tableName);
      const updatedList: TableRow[] = [];
      const updatedRows = current.map((row) => {
        const matches = this.filters.length === 0 || this.filters.every((fn) => fn(row));
        if (matches) {
          const updated = { ...row, ...this.updatesToApply, updated_at: now };
          updatedList.push(updated);
          mockStorage.notify(this.tableName, 'UPDATE', updated);
          return updated;
        }
        return row;
      });
      mockStorage.setTable(this.tableName, updatedRows);
      return { data: updatedList, error: null };
    }

    if (this.mode === 'delete') {
      const current = mockStorage.getTable(this.tableName);
      const remaining: TableRow[] = [];
      const deleted: TableRow[] = [];
      for (const row of current) {
        const matches = this.filters.length === 0 || this.filters.every((fn) => fn(row));
        if (matches) {
          deleted.push(row);
        } else {
          remaining.push(row);
        }
      }
      mockStorage.setTable(this.tableName, remaining);
      deleted.forEach((r) => mockStorage.notify(this.tableName, 'DELETE', r));
      return { data: deleted, error: null };
    }

    // Default: 'select'
    let rows = [...mockStorage.getTable(this.tableName)];
    for (const fn of this.filters) {
      rows = rows.filter(fn);
    }
    if (this.sortCol) {
      const col = this.sortCol;
      const asc = this.sortAsc;
      rows.sort((a, b) => {
        const valA = String(a[col] ?? '');
        const valB = String(b[col] ?? '');
        if (valA < valB) return asc ? -1 : 1;
        if (valA > valB) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this.rangeStart !== null && this.rangeEnd !== null) {
      rows = rows.slice(this.rangeStart, this.rangeEnd + 1);
    } else if (this.limitCount !== null) {
      rows = rows.slice(0, this.limitCount);
    }
    return { data: rows, error: null };
  }

  async maybeSingle(): Promise<{ data: TableRow | null; error: null }> {
    const res = this.execute();
    const rows = Array.isArray(res.data) ? res.data : [];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: TableRow | null; error: null }> {
    return this.maybeSingle();
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    const result = this.execute();
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

export function createMockClient() {
  let mockUser: { id: string; email: string } | null = null;
  try {
    const stored = localStorage.getItem('crc_mock_auth_user');
    if (stored) mockUser = JSON.parse(stored);
  } catch {
    // ignore
  }

  return {
    auth: {
      getSession: async () => ({ data: { session: mockUser ? { user: mockUser } : null }, error: null }),
      onAuthStateChange: (cb: (event: string, session: { user: { id: string; email: string } } | null) => void) => {
        if (mockUser) cb('SIGNED_IN', { user: mockUser });
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async ({ email }: { email: string; password?: string }) => {
        mockUser = { id: `mock_${btoa(email).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'user'}`, email };
        try {
          localStorage.setItem('crc_mock_auth_user', JSON.stringify(mockUser));
        } catch {
          // ignore localStorage write errors
        }
        return { data: { user: mockUser }, error: null };
      },
      signUp: async ({ email }: { email: string; password?: string }) => {
        mockUser = { id: `mock_${btoa(email).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'user'}`, email };
        try {
          localStorage.setItem('crc_mock_auth_user', JSON.stringify(mockUser));
        } catch {
          // ignore localStorage write errors
        }
        return { data: { user: mockUser }, error: null };
      },
      signOut: async () => {
        mockUser = null;
        try {
          localStorage.removeItem('crc_mock_auth_user');
        } catch {
          // ignore localStorage remove errors
        }
        return { error: null };
      },
    },
    from(tableName: string) {
      return new MockQueryBuilder(tableName);
    },
    rpc: async (fnName: string, args: Record<string, unknown> = {}) => {
      const now = new Date().toISOString();
      if (fnName === 'settle_cancellation_debts') {
        const ids = (args.p_ids as string[]) || [];
        const current = mockStorage.getTable(LEDGER_TABLE);
        const idSet = new Set(ids.map(String));
        let count = 0;
        const updated = current.map((row) => {
          if (idSet.has(String(row.id))) {
            count++;
            const prevStatus = (row.status as string) || 'Unpaid';
            const prevDebt = Number(row.structure_debt) || 40;
            const updatedRow = {
              ...row,
              status: 'Settled',
              structure_debt: 0,
              settled_at: now,
              settled_by: (args.p_settled_by as string) || 'Admin',
              settlement_notes: (args.p_notes as string) || '',
              updated_at: now,
            };
            mockStorage.upsert(AUDITS_TABLE, {
              id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              ledger_id: row.id,
              action: 'SETTLE',
              previous_status: prevStatus,
              new_status: 'Settled',
              previous_debt: prevDebt,
              new_debt: 0,
              actor_name: (args.p_settled_by as string) || 'Admin',
              notes: (args.p_notes as string) || 'Settled in full',
              created_at: now,
            });
            mockStorage.notify(LEDGER_TABLE, 'UPDATE', updatedRow);
            return updatedRow;
          }
          return row;
        });
        mockStorage.setTable(LEDGER_TABLE, updated);
        return { data: { success: true, count, settled_at: now }, error: null };
      }
      if (fnName === 'remove_cancellation_debts') {
        const ids = (args.p_ids as string[]) || [];
        const current = mockStorage.getTable(LEDGER_TABLE);
        const idSet = new Set(ids.map(String));
        let count = 0;
        const updated = current.map((row) => {
          if (idSet.has(String(row.id))) {
            count++;
            const prevStatus = (row.status as string) || 'Unpaid';
            const prevDebt = Number(row.structure_debt) || 40;
            const updatedRow = {
              ...row,
              status: 'Removed',
              structure_debt: 0,
              removed_at: now,
              removed_by: (args.p_removed_by as string) || 'Admin',
              removal_reason: (args.p_reason as string) || '',
              updated_at: now,
            };
            mockStorage.upsert(AUDITS_TABLE, {
              id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              ledger_id: row.id,
              action: 'REMOVE',
              previous_status: prevStatus,
              new_status: 'Removed',
              previous_debt: prevDebt,
              new_debt: 0,
              actor_name: (args.p_removed_by as string) || 'Admin',
              notes: (args.p_reason as string) || 'Removed by admin',
              created_at: now,
            });
            mockStorage.notify(LEDGER_TABLE, 'UPDATE', updatedRow);
            return updatedRow;
          }
          return row;
        });
        mockStorage.setTable(LEDGER_TABLE, updated);
        return { data: { success: true, count, removed_at: now }, error: null };
      }
      if (fnName === 'record_cancellation_payment') {
        const id = String(args.p_id || '');
        const amount = Number(args.p_amount) || 0;
        const current = mockStorage.getTable(LEDGER_TABLE);
        const row = current.find((r) => String(r.id) === id);
        if (!row) return { data: null, error: { message: `Ledger entry ${id} not found` } };
        const prevDebt = Number(row.structure_debt) || 40;
        const newBalance = Math.max(0, prevDebt - amount);
        const newStatus = newBalance === 0 ? 'Settled' : 'Partially Paid';
        const updated = current.map((r) => {
          if (String(r.id) === id) {
            const updatedRow = {
              ...r,
              status: newStatus,
              structure_debt: newBalance,
              settled_at: newBalance === 0 ? now : r.settled_at,
              settled_by: newBalance === 0 ? ((args.p_actor_name as string) || 'Admin') : r.settled_by,
              updated_at: now,
            };
            mockStorage.notify(LEDGER_TABLE, 'UPDATE', updatedRow);
            return updatedRow;
          }
          return r;
        });
        mockStorage.setTable(LEDGER_TABLE, updated);
        return { data: { success: true, id, previous_debt: prevDebt, new_debt: newBalance, new_status: newStatus, updated_at: now }, error: null };
      }
      if (fnName === 'admin_issue_vehicle_credential') {
        const manifestKey = String(args.p_manifest_key || '');
        const vehicleId = String(args.p_vehicle_id || '');
        if (!manifestKey || !vehicleId) {
          return { data: null, error: { message: 'Manifest key and vehicle ID are required' } };
        }
        const manifests = mockStorage.getTable(MANIFESTS_TABLE);
        const m = manifests.find((row) => String(row.date) === manifestKey);
        const vehicles = Array.isArray(m?.vehicles) ? (m.vehicles as Array<Record<string, unknown>>) : [];
        const targetVehicle = vehicles.find((v) => String(v.id) === vehicleId);
        if (!m || !targetVehicle) {
          return { data: null, error: { message: 'Vehicle not found in manifest' } };
        }
        const token = `token_${manifestKey}_${vehicleId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        const salt = Math.random().toString(36).slice(2, 10);
        const codeHash = simpleHashCred(salt, code);
        const tokenHash = simpleHashCred(salt, token);
        const expiresAt = new Date(Date.now() + 86400000).toISOString();
        
        mockStorage.upsert(VEHICLE_AUTH_TABLE, {
          manifest_key: manifestKey,
          vehicle_id: vehicleId,
          auth_token: token,
          auth_token_hash: tokenHash,
          access_code: null, // Zero plaintext access codes in DB!
          access_code_hash: codeHash,
          salt,
          created_at: now,
          expires_at: expiresAt,
          revoked: false,
          failed_attempts: 0,
          last_updated_at: null,
        }, 'vehicle_id');

        // Clear failed attempts for this vehicle on re-issue
        const attempts = mockStorage.getTable(CLAIM_LIMITS_TABLE);
        mockStorage.setTable(
          CLAIM_LIMITS_TABLE,
          attempts.filter((a) => !(String(a.manifest_key) === manifestKey && String(a.vehicle_id) === vehicleId))
        );

        return {
          data: {
            success: true,
            manifest_key: manifestKey,
            vehicle_id: vehicleId,
            auth_token: token,
            access_code: code,
            expires_at: expiresAt,
          },
          error: null,
        };
      }
      if (fnName === 'admin_revoke_vehicle_credential') {
        const manifestKey = String(args.p_manifest_key || '');
        const vehicleId = String(args.p_vehicle_id || '');
        const auths = mockStorage.getTable(VEHICLE_AUTH_TABLE);
        const matchAuth = auths.find(
          (a) => String(a.manifest_key) === manifestKey && String(a.vehicle_id) === vehicleId
        );
        if (matchAuth) {
          matchAuth.revoked = true;
          matchAuth.auth_token = null;
          matchAuth.access_code_hash = null;
          matchAuth.auth_token_hash = null;
          matchAuth.last_updated_at = now;
          mockStorage.setTable(VEHICLE_AUTH_TABLE, auths);
        }
        return { data: { success: true, revoked: true }, error: null };
      }
      if (fnName === 'rep_claim_vehicle_session') {
        const manifestKey = String(args.p_manifest_key || '');
        const vehicleId = String(args.p_vehicle_id || '');
        const cred = typeof args.p_credential === 'string' ? args.p_credential.trim() : '';
        if (!manifestKey || !vehicleId || !cred) {
          return { data: { success: false, error: 'Invalid or expired vehicle credential' }, error: null };
        }

        // Server-enforced rate limiting: check recent failed attempts
        const attempts = mockStorage.getTable(CLAIM_LIMITS_TABLE);
        const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
        const recentFails = attempts.filter((a) =>
          String(a.manifest_key) === manifestKey &&
          String(a.vehicle_id) === vehicleId &&
          !a.success &&
          new Date(String(a.attempt_time)).getTime() > fifteenMinutesAgo
        );

        if (recentFails.length >= 5) {
          return {
            data: {
              success: false,
              rate_limited: true,
              error: 'Too many failed claim attempts. Please wait 15 minutes or ask Dispatch for a new direct link.',
            },
            error: null,
          };
        }

        const auths = mockStorage.getTable(VEHICLE_AUTH_TABLE);
        const matchAuth = auths.find(
          (a) => String(a.manifest_key) === manifestKey && String(a.vehicle_id) === vehicleId
        );

        // Generic error anti-enumeration: don't reveal if vehicle or auth exists
        if (!matchAuth || matchAuth.revoked || (matchAuth.expires_at && new Date(String(matchAuth.expires_at)).getTime() < Date.now()) || !matchAuth.auth_token) {
          attempts.push({
            id: `attempt_${Date.now()}_${Math.random()}`,
            manifest_key: manifestKey,
            vehicle_id: vehicleId,
            attempt_time: now,
            success: false,
          });
          mockStorage.setTable(CLAIM_LIMITS_TABLE, attempts);
          return { data: { success: false, error: 'Invalid or expired vehicle credential' }, error: null };
        }

        const salt = String(matchAuth.salt || '');
        const codeHash = simpleHashCred(salt, cred.toUpperCase());
        const tokenHash = simpleHashCred(salt, cred);

        const isMatch =
          (matchAuth.access_code_hash && matchAuth.access_code_hash === codeHash) ||
          (matchAuth.auth_token_hash && matchAuth.auth_token_hash === tokenHash) ||
          (matchAuth.auth_token && matchAuth.auth_token === cred);

        if (!isMatch) {
          attempts.push({
            id: `attempt_${Date.now()}_${Math.random()}`,
            manifest_key: manifestKey,
            vehicle_id: vehicleId,
            attempt_time: now,
            success: false,
          });
          mockStorage.setTable(CLAIM_LIMITS_TABLE, attempts);
          return { data: { success: false, error: 'Invalid or expired vehicle credential' }, error: null };
        }

        // Record success
        attempts.push({
          id: `attempt_${Date.now()}_${Math.random()}`,
          manifest_key: manifestKey,
          vehicle_id: vehicleId,
          attempt_time: now,
          success: true,
        });
        mockStorage.setTable(CLAIM_LIMITS_TABLE, attempts);

        return {
          data: {
            success: true,
            auth_token: matchAuth.auth_token,
            expires_at: matchAuth.expires_at,
          },
          error: null,
        };
      }
      if (fnName === 'admin_save_manifest_atomic') {
        const manifestKey = String(args.p_manifest_key || '');
        const pSignups = Array.isArray(args.p_signups) ? args.p_signups : [];
        const pVehicles = Array.isArray(args.p_vehicles) ? args.p_vehicles : [];
        const pExpectedUpdatedAt = typeof args.p_expected_updated_at === 'string' ? args.p_expected_updated_at : null;
        const pForce = Boolean(args.p_force);

        if (!manifestKey) {
          return { data: null, error: { message: 'Manifest key is required' } };
        }

        const manifests = mockStorage.getTable(MANIFESTS_TABLE);
        const currentManifest = manifests.find((m) => String(m.date) === manifestKey);

        if (currentManifest && pExpectedUpdatedAt && !pForce) {
          const currentTs = new Date(String(currentManifest.updated_at || 0)).getTime();
          const expectedTs = new Date(pExpectedUpdatedAt).getTime();
          if (currentTs > expectedTs) {
            return {
              data: {
                success: false,
                conflict: true,
                server_updated_at: currentManifest.updated_at,
                error: 'Conflict: Manifest was modified by another user since last loaded. Please reload to resolve.',
              },
              error: null,
            };
          }
        }

        const updated = {
          date: manifestKey,
          signups: pSignups,
          vehicles: pVehicles,
          updated_at: now,
        };
        mockStorage.upsert(MANIFESTS_TABLE, updated, 'date');

        return {
          data: {
            success: true,
            date: manifestKey,
            updated_at: now,
          },
          error: null,
        };
      }
      if (fnName === 'rep_get_or_create_vehicle_session') {
        // Disarmed for anonymous callers: credentials must be issued by Dispatch
        return {
          data: {
            success: false,
            error: 'Unauthorized: Vehicle credentials must be issued by a Dispatch Administrator.',
          },
          error: { message: 'Unauthorized: Vehicle credentials must be issued by a Dispatch Administrator.' },
        };
      }
      if (fnName === 'rep_update_vehicle_draft') {
        const manifestKey = String(args.p_manifest_key || '');
        const vehicleId = String(args.p_vehicle_id || '');
        const authToken = typeof args.p_auth_token === 'string' ? args.p_auth_token.trim() : '';
        const draftState = (args.p_draft_state as Record<string, unknown>) || {};
        const repName = (args.p_rep_name as string) || '';
        const licensePlate = (args.p_license_plate as string) || '';
        const clientTimestamp = (args.p_client_timestamp as string) || (draftState.updatedAt as string) || now;

        if (!manifestKey || !vehicleId) {
          return { data: null, error: { message: 'Manifest key and vehicle ID are required' } };
        }

        // Authorization check: token must match vehicle and must not be revoked
        const auths = mockStorage.getTable(VEHICLE_AUTH_TABLE);
        const matchAuth = auths.find(
          (a) => String(a.manifest_key) === manifestKey && String(a.vehicle_id) === vehicleId
        );
        if (!matchAuth || matchAuth.auth_token !== authToken || !authToken) {
          return { data: null, error: { message: 'Unauthorized: Invalid vehicle authorization token' } };
        }
        if (matchAuth.revoked) {
          return { data: null, error: { message: 'Unauthorized: Vehicle authorization token has been revoked by Dispatch' } };
        }
        if (matchAuth.expires_at && new Date(String(matchAuth.expires_at)).getTime() < Date.now()) {
          return { data: null, error: { message: 'Unauthorized: Vehicle authorization token has expired' } };
        }

        const lastTs = matchAuth.last_updated_at ? new Date(String(matchAuth.last_updated_at)).getTime() : 0;
        const currentTs = new Date(clientTimestamp).getTime();

        // Anti-replay check: client timestamp cannot be older than last_updated_at
        if (lastTs > 0 && currentTs < lastTs) {
          return { data: { success: false, error: 'Conflict: Stale or replayed update rejected' }, error: null };
        }

        const manifests = mockStorage.getTable(MANIFESTS_TABLE);
        const currentManifest = manifests.find((m) => String(m.date) === manifestKey);
        if (!currentManifest) {
          return { data: null, error: { message: 'Manifest session not found' } };
        }

        const vehicles = Array.isArray(currentManifest.vehicles)
          ? (currentManifest.vehicles as Array<Record<string, unknown>>)
          : [];
        let found = false;
        const updatedVehicles = vehicles.map((v) => {
          if (String(v.id) === vehicleId) {
            found = true;
            if (v.submitted && !draftState.submitted) {
              throw new Error('Vehicle is submitted and locked');
            }
            return {
              ...v,
              repName: repName?.trim() || v.repName,
              licensePlate: licensePlate?.trim() || v.licensePlate,
              submitted: Boolean(draftState.submitted || v.submitted),
              draftState: {
                ...((v.draftState as Record<string, unknown>) || {}),
                ...draftState,
              },
            };
          }
          return v;
        });

        if (!found) {
          return { data: null, error: { message: 'Vehicle not found in manifest' } };
        }

        const updatedManifest = {
          ...currentManifest,
          vehicles: updatedVehicles,
          updated_at: now,
        };
        mockStorage.upsert(MANIFESTS_TABLE, updatedManifest, 'date');
        matchAuth.last_updated_at = new Date(Math.max(Date.now(), currentTs)).toISOString();
        mockStorage.setTable(VEHICLE_AUTH_TABLE, auths);

        return {
          data: { success: true, date: manifestKey, vehicle_id: vehicleId, updated_at: now },
          error: null,
        };
      }
      if (fnName === 'rep_add_walk_in') {
        const manifestKey = String(args.p_manifest_key || '');
        const vehicleId = String(args.p_vehicle_id || '');
        const authToken = typeof args.p_auth_token === 'string' ? args.p_auth_token.trim() : '';
        const pPassenger = (args.p_passenger as Record<string, unknown>) || {};
        const pDraftUpdate = (args.p_draft_update as Record<string, unknown>) || {};
        const pConfirmTransfer = Boolean(args.p_confirm_transfer);

        if (!manifestKey || !vehicleId || !pPassenger.id) {
          return { data: null, error: { message: 'Manifest key, vehicle ID, and passenger are required' } };
        }

        const auths = mockStorage.getTable(VEHICLE_AUTH_TABLE);
        const matchAuth = auths.find(
          (a) => String(a.manifest_key) === manifestKey && String(a.vehicle_id) === vehicleId
        );
        if (!matchAuth || matchAuth.auth_token !== authToken || !authToken) {
          return { data: null, error: { message: 'Unauthorized: Invalid vehicle authorization token' } };
        }
        if (matchAuth.revoked) {
          return { data: null, error: { message: 'Unauthorized: Vehicle authorization token has been revoked by Dispatch' } };
        }
        if (matchAuth.expires_at && new Date(String(matchAuth.expires_at)).getTime() < Date.now()) {
          return { data: null, error: { message: 'Unauthorized: Vehicle authorization token has expired' } };
        }

        const manifests = mockStorage.getTable(MANIFESTS_TABLE);
        const currentManifest = manifests.find((m) => String(m.date) === manifestKey);
        if (!currentManifest) {
          return { data: null, error: { message: 'Manifest session not found' } };
        }

        const signups = Array.isArray(currentManifest.signups)
          ? (currentManifest.signups as Array<Record<string, unknown>>)
          : [];
        const vehicles = Array.isArray(currentManifest.vehicles)
          ? (currentManifest.vehicles as Array<Record<string, unknown>>)
          : [];
        const passengerId = String(pPassenger.id);

        // Check if passenger already assigned to another vehicle (in signups or in another vehicle's riders)
        const existingSignup = signups.find((p) => String(p.id) === passengerId);
        let existingAssignedVeh = existingSignup?.assignedTo ? String(existingSignup.assignedTo) : '';
        if (!existingAssignedVeh) {
          const otherVeh = vehicles.find((v) => Array.isArray(v.riders) && (v.riders as string[]).includes(passengerId));
          if (otherVeh) {
            existingAssignedVeh = String(otherVeh.id);
          }
        }

        if (existingAssignedVeh && existingAssignedVeh !== vehicleId) {
          if (!pConfirmTransfer) {
            return {
              data: {
                success: false,
                requires_confirmation: true,
                existing_vehicle_id: existingAssignedVeh,
                error: `Passenger is already assigned to ${existingAssignedVeh}. Explicit transfer confirmation required.`,
              },
              error: null,
            };
          }
        }

        const targetSignup = { ...pPassenger, assignedTo: vehicleId, present: true, walkIn: true };
        const signupIdx = signups.findIndex((p) => String(p.id) === passengerId);
        const updatedSignups = [...signups];
        if (signupIdx >= 0) {
          updatedSignups[signupIdx] = { ...signups[signupIdx], ...targetSignup };
        } else {
          updatedSignups.push(targetSignup);
        }

        let foundVehicle = false;
        const updatedVehicles = vehicles.map((v) => {
          if (String(v.id) === vehicleId) {
            foundVehicle = true;
            const curRiders = Array.isArray(v.riders) ? (v.riders as string[]) : [];
            const newRiders = curRiders.includes(passengerId) ? curRiders : [...curRiders, passengerId];
            const curDraft = ((v.draftState as Record<string, unknown>) || {}) as {
              presentIds?: string[];
              absentIds?: string[];
              repName?: string;
              licensePlate?: string;
            };
            const curPres = new Set(curDraft.presentIds || []);
            curPres.add(passengerId);
            const curAbs = (curDraft.absentIds || []).filter((id) => String(id) !== passengerId);

            return {
              ...v,
              riders: newRiders,
              repName: (pDraftUpdate.repName as string) || v.repName,
              licensePlate: (pDraftUpdate.licensePlate as string) || v.licensePlate,
              draftState: {
                ...curDraft,
                presentIds: Array.from(curPres),
                absentIds: curAbs,
                repName: (pDraftUpdate.repName as string) || curDraft.repName || v.repName,
                licensePlate: (pDraftUpdate.licensePlate as string) || curDraft.licensePlate || v.licensePlate,
                updatedAt: now,
              },
            };
          } else {
            const curRiders = Array.isArray(v.riders) ? (v.riders as string[]) : [];
            return {
              ...v,
              riders: curRiders.filter((id) => String(id) !== passengerId),
            };
          }
        });

        if (!foundVehicle) {
          return { data: null, error: { message: 'Vehicle not found in manifest' } };
        }

        const updatedManifest = {
          ...currentManifest,
          signups: updatedSignups,
          vehicles: updatedVehicles,
          updated_at: now,
        };
        mockStorage.upsert(MANIFESTS_TABLE, updatedManifest, 'date');
        matchAuth.last_updated_at = now;
        mockStorage.setTable(VEHICLE_AUTH_TABLE, auths);

        return {
          data: {
            success: true,
            date: manifestKey,
            vehicle_id: vehicleId,
            passenger_id: passengerId,
            transferred: Boolean(existingSignup && existingSignup.assignedTo && String(existingSignup.assignedTo) !== vehicleId),
            updated_at: now,
          },
          error: null,
        };
      }
      return { data: { success: true }, error: null };
    },
    channel(channelName: string) {
      // ✅ Clean single declaration:
      const callbacks: ((payload: StoragePayload & { table: string }) => void)[] = [];
      let unsub: (() => void) | null = null;

      const ch = {
        name: channelName,
        on(_event: string, filter: ChannelFilter, callback: (payload: StoragePayload & { table: string }) => void) {
          callbacks.push((eventPayload: StoragePayload & { table: string }) => {
            if (filter?.table && filter.table !== eventPayload.table) return;
            if (filter?.filter) {
              const match = filter.filter.match(/(\w+)=eq\.(.+)/);
              if (match) {
                const [, col, val] = match;
                if (eventPayload.new?.[col] !== val && eventPayload.old?.[col] !== val) return;
              }
            }
            callback(eventPayload);
          });
          return ch;
        },
        subscribe(statusCallback?: (status: string) => void) {
          unsub = mockStorage.addListener((table, payload) => {
            callbacks.forEach((cb) => cb({ table, ...payload }));
          });
          if (statusCallback) {
            setTimeout(() => statusCallback('SUBSCRIBED'), 10);
          }
          return ch;
        },
        unsubscribe() {
          if (unsub) unsub();
        },
        send(_payload: unknown) {
          void _payload;
          return Promise.resolve('ok');
        },
        httpSend(_event: string, _payload?: unknown) {
          void _event;
          void _payload;
          return Promise.resolve({ success: true as const });
        },
        track(_state: unknown) {
          void _state;
          return Promise.resolve('ok');
        },
        untrack() {
          return Promise.resolve('ok');
        },
      };
      return ch;
    },
    removeChannel(channel: { unsubscribe?: () => void } | null) {
      if (channel?.unsubscribe) channel.unsubscribe();
    },
  };
}

export const isTestEnvironment = Boolean(
  typeof process !== 'undefined' && (
    process.env.NODE_ENV === 'test' ||
    process.env.TEST === 'true' ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.argv?.some((arg) => typeof arg === 'string' && (arg.includes('--test') || arg.includes('.test.')))
  )
);

function createResilientSupabaseClient() {
  if (!isConfigured || isTestEnvironment) {
    return createMockClient() as unknown as ReturnType<typeof createClient>;
  }

  const realClient = createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: { persistSession: true }, 
    realtime: { params: { eventsPerSecond: 10 } },
  });

  const mockClient = createMockClient();

  return {
    ...realClient,
    auth: realClient.auth,
    from(tableName: string) {
      const realBuilder = realClient.from(tableName);
      if (import.meta?.env?.PROD) {
        return realBuilder;
      }
      const fallbackBuilder = mockClient.from(tableName);

      // Wrap with a proxy that executes on real Supabase, but seamlessly
      // falls back to mockStorage on network fetch failures (DEV only).
      const proxy = new Proxy(realBuilder, {
        get(target, prop, receiver) {
          const original = Reflect.get(target, prop, receiver);

          if (prop === 'then') {
            return (
              onfulfilled?: ((val: unknown) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null
            ) => {
              return (target as unknown as Promise<{ data?: unknown; error?: { message?: string } | null }>)
                .then((res: { data?: unknown; error?: { message?: string } | null }) => {
                  if (res?.error && isNetworkFetchError(res.error)) {
                    console.warn(`[Transport Storage] Remote sync unavailable (${res.error.message}), using local storage.`);
                    return fallbackBuilder.then(onfulfilled, onrejected);
                  }
                  // On successful remote select/read, upsert rows to local storage for offline resilience without wiping others
                  if (res?.data && Array.isArray(res.data)) {
                    try {
                      for (const row of res.data) {
                        mockStorage.upsert(tableName, row as TableRow);
                      }
                    } catch {
                      // ignore
                    }
                  }
                  return onfulfilled ? onfulfilled(res) : res;
                })
                .catch((err: unknown) => {
                  if (isNetworkFetchError(err)) {
                    console.warn('[Transport Storage] Remote fetch failed, falling back to local storage.');
                    return fallbackBuilder.then(onfulfilled, onrejected);
                  }
                  if (onrejected) return onrejected(err);
                  throw err;
                });
            };
          }

          if (prop === 'maybeSingle' || prop === 'single') {
            return async () => {
              try {
                const res = await (target as unknown as Record<string, () => Promise<{ data?: unknown; error?: { message?: string } | null }>>)[prop]?.();
                if (res?.error && isNetworkFetchError(res.error)) {
                  return fallbackBuilder[prop as 'maybeSingle' | 'single']();
                }
                return res;
              } catch (err) {
                if (isNetworkFetchError(err)) {
                  return fallbackBuilder[prop as 'maybeSingle' | 'single']();
                }
                throw err;
              }
            };
          }

          if (typeof original === 'function') {
            return (...args: unknown[]) => {
              const result = original.apply(target, args);
              // If the returned object is another query builder, keep chaining
              if (result && typeof result === 'object') {
                if (typeof (fallbackBuilder as unknown as Record<string, unknown>)[prop as string] === 'function') {
                  ((fallbackBuilder as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string])(...args);
                }
              }
              return result;
            };
          }

          return original;
        },
      });

      return proxy;
    },
    channel(channelName: string) {
      try {
        const realChannel = realClient.channel(channelName);
        return realChannel;
      } catch {
        return mockClient.channel(channelName);
      }
    },
    removeChannel(channel: { unsubscribe?: () => void } | null) {
      try {
        realClient.removeChannel(channel as Parameters<typeof realClient.removeChannel>[0]);
      } catch {
        mockClient.removeChannel(channel);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc(fnName: string, args: Record<string, unknown> = {}): any {
      if (typeof realClient.rpc === 'function') {
        return Promise.resolve(realClient.rpc(fnName, args) as unknown)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((res: any) => {
            if (res?.error && (isNetworkFetchError(res.error) || isFunctionNotFoundError(res.error, res.status))) {
              return mockClient.rpc(fnName, args);
            }
            if (
              res?.data &&
              typeof res.data === 'object' &&
              (res.data as { success?: boolean; error?: string }).error === 'Manifest session not found'
            ) {
              const manifestKey = String(args.p_manifest_key || '');
              if (manifestKey && mockStorage.getTable(MANIFESTS_TABLE).some((m) => String(m.date) === manifestKey)) {
                return mockClient.rpc(fnName, args);
              }
            }
            return res;
          })
          .catch((err: unknown) => {
            if (isNetworkFetchError(err) || isFunctionNotFoundError(err)) {
              return mockClient.rpc(fnName, args);
            }
            throw err;
          });
      }
      return mockClient.rpc(fnName, args);
    },
  } as unknown as ReturnType<typeof createClient>;
}

function isNetworkFetchError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === 'object' && err !== null && 'message' in err
    ? String((err as { message: unknown }).message)
    : String(err);
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('connection refused') ||
    msg.includes('abort')
  );
}

function isFunctionNotFoundError(err: unknown, status?: number): boolean {
  if (!err && !status) return false;
  if (status === 404) return true;
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = typeof err === 'object' && err !== null && 'message' in err
    ? String((err as { message: unknown }).message)
    : String(err);
  return (
    code === 'PGRST202' ||
    code === 'PGRST204' ||
    code === '42883' ||
    msg.includes('Could not find the function') ||
    msg.includes('does not exist') ||
    msg.includes('not found')
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase: SupabaseClient<any, string, any> = createResilientSupabaseClient() as unknown as SupabaseClient<any, string, any>;

