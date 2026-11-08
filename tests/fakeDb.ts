/** Small in-memory stand-in for the Supabase query builder: enough to test server logic that talks to the database. */
type Row = Record<string, unknown>;

export function makeFakeDb(seed: Record<string, Row[]> = {}, opts: { unique?: Record<string, string[]> } = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  let seq = 0;

  function from(name: string) {
    const rows = (tables[name] ??= []);
    let op: "select" | "insert" | "update" | "delete" = "select";
    let patch: Row = {};
    const filters: ((r: Row) => boolean)[] = [];
    let wantRows = false;
    let countMode = false;
    let head = false;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let single: "none" | "maybe" | "one" = "none";

    const exec = () => {
      const match = () => rows.filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const row: Row = { ...patch };
        const uniq = opts.unique?.[name];
        if (uniq && rows.some((r) => uniq.every((c) => r[c] === row[c]))) return { data: null, error: { message: "duplicate key" }, count: null };
        row.id ??= crypto.randomUUID();
        row.created_at ??= new Date().toISOString();
        if (name === "messages") {
          row.seq = ++seq;
          row.is_error ??= false;
        }
        if (name === "pending_actions") {
          row.status ??= "pending";
          row.expires_at ??= new Date(Date.now() + 15 * 60_000).toISOString();
        }
        rows.push(row);
        return finish(wantRows ? [row] : null, rows.length);
      }
      if (op === "update") {
        const hit = match();
        for (const r of hit) Object.assign(r, patch);
        return finish(wantRows ? hit : null, hit.length);
      }
      if (op === "delete") {
        const hit = match();
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return finish(null, hit.length);
      }
      let hit = match();
      if (order) hit = [...hit].sort((a, b) => ((a[order!.col] as number | string) > (b[order!.col] as number | string) ? 1 : -1) * (order!.asc ? 1 : -1));
      const total = hit.length;
      if (limitN !== null) hit = hit.slice(0, limitN);
      return { data: head ? null : hit.map((r) => ({ ...r })), error: null, count: countMode ? total : null };
    };
    const finish = (data: Row[] | null, count: number) => ({ data: data?.map((r) => ({ ...r })) ?? null, error: null, count: countMode ? count : null });

    const resolve = () => {
      const res = exec();
      if (single === "none" || !Array.isArray(res.data)) return res;
      const first = res.data[0] ?? null;
      if (single === "one" && !first) return { data: null, error: { message: "no rows" }, count: null };
      return { data: first, error: null, count: null };
    };

    const b = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        wantRows = true;
        if (o?.count) countMode = true;
        if (o?.head) head = true;
        return b;
      },
      insert(row: Row) {
        op = "insert";
        patch = row;
        return b;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return b;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return b;
      },
      order(col: string, o?: { ascending?: boolean }) {
        order = { col, asc: o?.ascending !== false };
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      maybeSingle() {
        single = "maybe";
        return b;
      },
      single() {
        single = "one";
        return b;
      },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
        return Promise.resolve().then(resolve).then(ok, bad);
      },
    };
    return b;
  }
  return { from, tables };
}
