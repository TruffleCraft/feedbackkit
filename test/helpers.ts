// Minimal D1 fake for unit tests: prepare().bind().first()/run()/all().
export function fakeD1(handler: (sql: string, params: unknown[]) => unknown): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          params = a;
          return stmt;
        },
        first: async () => handler(sql, params) as never,
        // run() also forwards to the handler so tests can capture writes and
        // simulate constraint errors (throw); its return value is ignored.
        run: async () => {
          handler(sql, params);
          return { success: true } as never;
        },
        // all() forwards too: an array return becomes the result rows, anything
        // else (null, a first()-style object) reads as no rows.
        all: async () => {
          const rows = handler(sql, params);
          return { results: Array.isArray(rows) ? rows : [] } as never;
        },
        raw: async () => [] as never,
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

export type MemoryKV = KVNamespace & { data: Map<string, { value: string; metadata?: unknown }> };

// In-memory KV for the OAuth provider tests: get (text/json), put (with
// metadata), delete, list by prefix. Expiry is ignored; tests are short.
export function memoryKV(): MemoryKV {
  const data = new Map<string, { value: string; metadata?: unknown }>();
  const kv = {
    data,
    async get(key: string, opts?: unknown) {
      const e = data.get(key);
      if (!e) return null;
      const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
      return type === "json" ? JSON.parse(e.value) : e.value;
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      data.set(key, { value: String(value), metadata: opts?.metadata });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(opts: { prefix?: string } = {}) {
      const keys = [...data.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? ""))
        .sort()
        .map((name) => ({ name, metadata: data.get(name)?.metadata }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
  return kv as unknown as MemoryKV;
}
