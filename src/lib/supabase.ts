import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

export const MANIFESTS_TABLE = 'transport_manifests';
export const LEDGER_TABLE = 'cancellation_ledger';

const isConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseUrl.startsWith('http') &&
  !supabaseUrl.includes('placeholder')
);

type TableRow = Record<string, unknown>;

interface StoragePayload {
  eventType: string;
  new?: TableRow;
  old?: TableRow;
}

// Local in-memory / localStorage storage engine for offline/fallback mode
class MockSupabaseStorage {
  private memoryStore: Record<string, TableRow[]> = {
    [MANIFESTS_TABLE]: [],
    [LEDGER_TABLE]: [],
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

  private loadFromLocalStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const manifests = localStorage.getItem(`crc_transport_${MANIFESTS_TABLE}`);
      if (manifests) this.memoryStore[MANIFESTS_TABLE] = JSON.parse(manifests);
      const ledger = localStorage.getItem(`crc_transport_${LEDGER_TABLE}`);
      if (ledger) this.memoryStore[LEDGER_TABLE] = JSON.parse(ledger);
    } catch {
      // Ignore local storage parse errors
    }
  }

  private saveToLocalStorage(table: string) {
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

  notify(table: string, event: string, row: TableRow) {
    this.listeners.forEach((fn) => fn(table, { eventType: event, new: row, old: row }));
  }

  addListener(fn: (table: string, payload: StoragePayload) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const mockStorage = new MockSupabaseStorage();

interface FilterCondition {
  (row: TableRow): boolean;
}

interface ChannelFilter {
  table?: string;
  filter?: string;
  schema?: string;
  event?: string;
}

function createMockClient() {
  return {
    from(tableName: string) {
      const filters: FilterCondition[] = [];
      let sortCol: string | null = null;
      let sortAsc = true;
      let limitCount: number | null = null;

      const builder = {
        select(_cols?: string) {
          void _cols;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((row: TableRow) => row[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const valSet = new Set(vals);
          filters.push((row: TableRow) => valSet.has(row[col]));
          return builder;
        },
        order(col: string, { ascending = true }: { ascending?: boolean } = {}) {
          sortCol = col;
          sortAsc = ascending;
          return builder;
        },
        limit(count: number) {
          limitCount = count;
          return builder;
        },
        async maybeSingle(): Promise<{ data: TableRow | null; error: null }> {
          const { data } = await builder;
          return { data: Array.isArray(data) && data.length > 0 ? data[0] : null, error: null };
        },
        async insert(rows: TableRow | TableRow[]): Promise<{ data: TableRow[]; error: null }> {
          const rowsToInsert = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
            ...r,
            id: r.id || `mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            created_at: r.created_at || new Date().toISOString(),
            updated_at: r.updated_at || new Date().toISOString(),
            submitted_at: r.submitted_at || new Date().toISOString(),
          }));
          const current = mockStorage.getTable(tableName);
          mockStorage.setTable(tableName, [...current, ...rowsToInsert]);
          rowsToInsert.forEach((r) => mockStorage.notify(tableName, 'INSERT', r));
          return { data: rowsToInsert, error: null };
        },
        upsert(rowOrRows: TableRow | TableRow[], { onConflict }: { onConflict?: string } = {}) {
          // Mirrors supabase-js: upsert() returns a chainable/thenable
          // builder, so callers can either await it directly or chain
          // .select(...).maybeSingle() / .single() off it before awaiting.
          const items = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          const resultRows: TableRow[] = [];

          const apply = () => {
            if (resultRows.length > 0) return resultRows;
            const current = [...mockStorage.getTable(tableName)];
            const keyField = onConflict || 'id';

            for (const item of items) {
              const now = new Date().toISOString();
              const fullItem = {
                ...item,
                updated_at: now,
                created_at: item.created_at || now,
              };
              const idx = current.findIndex((r) => r[keyField] === fullItem[keyField]);
              if (idx !== -1) {
                current[idx] = { ...current[idx], ...fullItem };
                mockStorage.notify(tableName, 'UPDATE', current[idx]);
                resultRows.push(current[idx]);
              } else {
                current.push(fullItem);
                mockStorage.notify(tableName, 'INSERT', fullItem);
                resultRows.push(fullItem);
              }
            }
            mockStorage.setTable(tableName, current);
            return resultRows;
          };

          const upsertBuilder = {
            select(_cols?: string) {
              void _cols;
              return upsertBuilder;
            },
            async maybeSingle(): Promise<{ data: TableRow | null; error: null }> {
              const rows = apply();
              return { data: rows.length > 0 ? rows[0] : null, error: null };
            },
            async single(): Promise<{ data: TableRow | null; error: null }> {
              const rows = apply();
              return { data: rows.length > 0 ? rows[0] : null, error: null };
            },
            then(resolve: (res: { data: TableRow[]; error: null }) => void) {
              const rows = apply();
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
          };

          return upsertBuilder;
        },
        async delete(): Promise<{ data: TableRow[]; error: null }> {
          const current = mockStorage.getTable(tableName);
          const remaining: TableRow[] = [];
          const deleted: TableRow[] = [];
          for (const row of current) {
            const matches = filters.every((fn) => fn(row));
            if (matches) {
              deleted.push(row);
            } else {
              remaining.push(row);
            }
          }
          mockStorage.setTable(tableName, remaining);
          deleted.forEach((r) => mockStorage.notify(tableName, 'DELETE', r));
          return { data: deleted, error: null };
        },
        async update(updates: Record<string, unknown>): Promise<{ data: TableRow[]; error: null }> {
          const current = mockStorage.getTable(tableName);
          const updatedList: TableRow[] = [];
          const updatedRows = current.map((row) => {
            const matches = filters.every((fn) => fn(row));
            if (matches) {
              const updated = { ...row, ...updates, updated_at: new Date().toISOString() };
              updatedList.push(updated);
              return updated;
            }
            return row;
          });
          mockStorage.setTable(tableName, updatedRows);
          updatedList.forEach((r) => mockStorage.notify(tableName, 'UPDATE', r));
          return { data: updatedList, error: null };
        },
        then(resolve: (res: { data: TableRow[]; error: null }) => void) {
          let rows = [...mockStorage.getTable(tableName)];
          for (const fn of filters) {
            rows = rows.filter(fn);
          }
          if (sortCol) {
            const col = sortCol;
            const asc = sortAsc;
            rows.sort((a, b) => {
              const valA = String(a[col] ?? '');
              const valB = String(b[col] ?? '');
              if (valA < valB) return asc ? -1 : 1;
              if (valA > valB) return asc ? 1 : -1;
              return 0;
            });
          }
          if (limitCount !== null) {
            rows = rows.slice(0, limitCount);
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };

      return builder;
    },
    channel(channelName: string) {
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
      };
      return ch;
    },
    removeChannel(channel: { unsubscribe?: () => void } | null) {
      if (channel?.unsubscribe) channel.unsubscribe();
    },
  };
}

export const supabase = isConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : (createMockClient() as unknown as ReturnType<typeof createClient>);
