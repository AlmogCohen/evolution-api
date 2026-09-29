// What the auth store gets for @api/server.module in the child process: the session table
// only, in memory (creds live there; keys are files). The real module builds the whole
// application at import.
const rows = new Map();
exports.prismaRepository = {
  session: {
    findUnique: async ({ where }) => rows.get(where.sessionId) ?? null,
    create: async ({ data }) => (rows.set(data.sessionId, { ...data }), rows.get(data.sessionId)),
    update: async ({ where, data }) => (rows.set(where.sessionId, { ...rows.get(where.sessionId), ...data }), rows.get(where.sessionId)),
    delete: async ({ where }) => rows.delete(where.sessionId),
  },
};
