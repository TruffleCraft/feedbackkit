// Minimal D1 fake for unit tests: prepare().bind().first().
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
        all: async () => ({ results: [] }) as never,
        raw: async () => [] as never,
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}
