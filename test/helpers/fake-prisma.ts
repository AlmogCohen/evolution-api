// An in-memory stand-in for the parts of PrismaRepository the Baileys handlers use.
// Rows live in plain arrays so a test can assert on what Evolution stored.
type Row = Record<string, any>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'remoteJid_instanceId') return row.remoteJid === v.remoteJid && row.instanceId === v.instanceId;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v) return (v.in as any[]).includes(row[k]);
      if ('path' in v) return true; // JSON path filters: not modelled, treated as match
      return matches(row[k] ?? {}, v);
    }
    return row[k] === v;
  });

function table(name: string, uniqueKey: (r: Row) => string | undefined) {
  const rows: Row[] = [];
  const find = (where?: Row) => rows.filter((r) => matches(r, where));
  const t = {
    rows,
    findMany: async (args: Row = {}) => find(args.where),
    findFirst: async (args: Row = {}) => find(args.where)[0] ?? null,
    findUnique: async (args: Row = {}) => find(args.where)[0] ?? null,
    count: async (args: Row = {}) => find(args.where).length,
    create: async ({ data }: Row) => (rows.push({ id: `${name}-${rows.length + 1}`, ...data }), rows[rows.length - 1]),
    createMany: async ({ data, skipDuplicates }: Row) => {
      let count = 0;
      for (const d of [].concat(data)) {
        const key = uniqueKey(d);
        if (skipDuplicates && key && rows.some((r) => uniqueKey(r) === key)) continue;
        rows.push({ id: `${name}-${rows.length + 1}`, ...d });
        count++;
      }
      return { count };
    },
    update: async ({ where, data }: Row) => {
      const r = find(where)[0];
      if (r) Object.assign(r, strip(data));
      return r;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = find(where);
      hit.forEach((r) => Object.assign(r, strip(data)));
      return { count: hit.length };
    },
    upsert: async ({ where, create, update }: Row) => {
      const r = find(where)[0];
      if (r) return Object.assign(r, strip(update));
      return t.create({ data: create });
    },
    delete: async ({ where }: Row) => {
      const i = rows.findIndex((r) => matches(r, where));
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
    deleteMany: async ({ where }: Row = {}) => {
      const hit = find(where);
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: hit.length };
    },
  };
  return t;
}

// Prisma ignores undefined fields in an update; so do we.
const strip = (data: Row) => Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined));

export function fakePrisma() {
  const byJid = (r: Row) => (r.remoteJid ? `${r.remoteJid}|${r.instanceId}` : undefined);
  const db: any = {
    contact: table('contact', byJid),
    chat: table('chat', byJid),
    message: table('message', (r) => r.key?.id && `${r.key.id}|${r.instanceId}`),
    messageUpdate: table('messageUpdate', () => undefined),
    setting: table('setting', (r) => r.instanceId),
    session: table('session', (r) => r.sessionId),
    label: table('label', () => undefined),
    isOnWhatsapp: table('isOnWhatsapp', (r) => r.remoteJid),
    instance: table('instance', (r) => r.id),
  };
  db.$transaction = async (ops: any) => (typeof ops === 'function' ? ops(db) : Promise.all(ops));
  db.$queryRaw = async () => [];
  db.$executeRaw = async () => 0;
  db.$queryRawUnsafe = async () => [];
  return db;
}
