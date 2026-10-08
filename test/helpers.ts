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
