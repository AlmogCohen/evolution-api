// T3: Evolution's real router and real Prisma against a throwaway Postgres.
// main.ts builds the app inside bootstrap() and does not export it, so this
// mirrors the parts a route needs: JSON body parsing, the router, and the
// error handler's status mapping (main.ts, "app.use((err, req, res, next) ...").
import type { AddressInfo } from 'node:net';

export async function startApp() {
  const express = (await import('express')).default;
  const { router } = await import('@api/routes/index.router');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', router);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.status || 500).json({ status: err?.status || 500, error: err?.error, response: { message: err?.message } }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
