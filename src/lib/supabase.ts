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
export class MockSupabaseStorage {
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

  order(col: string, { ascending = true }: { ascending?: boolean } = {}) {
    this.sortCol = col;
    this.sortAsc = ascending;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
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

    if (this.mode === 'insert') {
      const rowsToInsert = this.rowsToInsertOrUpsert.map((r) => ({
        ...r,
        id: r.id || `mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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
          updated_at: now,
          created_at: item.created_at || now,
        };
        const idx = current.findIndex((r) => String(r[keyField] ?? '') === String(fullItem[keyField] ?? ''));
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
    if (this.limitCount !== null) {
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
  return {
    from(tableName: string) {
      return new MockQueryBuilder(tableName);
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
        send(_payload: unknown) {
          void _payload;
          return Promise.resolve('ok');
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

/**
 * Creates a resilient Supabase client wrapper that automatically falls back
 * to the local mock storage engine whenever Supabase network requests fail
 * (e.g. TypeError: Failed to fetch, paused project, CORS, offline mode).
 */
function createResilientSupabaseClient() {
  if (!isConfigured) {
    return createMockClient() as unknown as ReturnType<typeof createClient>;
  }

  const realClient = createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  const mockClient = createMockClient();

  return {
    ...realClient,
    from(tableName: string) {
      const realBuilder = realClient.from(tableName);
      const fallbackBuilder = mockClient.from(tableName);

      // Wrap with a proxy that executes on real Supabase, but seamlessly
      // falls back to mockStorage on network fetch failures.
      const proxy = new Proxy(realBuilder, {
        get(target, prop, receiver) {
          const original = Reflect.get(target, prop, receiver);

          if (prop === 'then') {
            return (
              onfulfilled?: ((val: unknown) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null
            ) => {
              return target
                .then((res: { data?: unknown; error?: { message?: string } | null }) => {
                  if (res?.error && isNetworkFetchError(res.error)) {
                    console.warn(`[Transport Storage] Remote sync unavailable (${res.error.message}), using local storage.`);
                    return fallbackBuilder.then(onfulfilled, onrejected);
                  }
                  // On successful remote select/read, sync data to local storage for offline resilience
                  if (res?.data && Array.isArray(res.data)) {
                    try {
                      mockStorage.setTable(tableName, res.data as TableRow[]);
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
                const res = await (target as unknown as { maybeSingle: () => Promise<{ data?: unknown; error?: { message?: string } | null }> })[prop as 'maybeSingle' | 'single']();
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

export const supabase = createResilientSupabaseClient();

