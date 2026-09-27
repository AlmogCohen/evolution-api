// T3: Evolution's real router and real Prisma against a throwaway Postgres.
// main.ts builds the app inside bootstrap() and does not export it, so this
// mirrors the parts a route needs: JSON body parsing, the router, and the
// error handler's status mapping (main.ts, "app.use((err, req, res, next) ...").
import type { AddressInfo } from 'node:net';

async function serve(mount: string, router: any) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(mount, router);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.status || 500).json({ status: err?.status || 500, error: err?.error, response: { message: err?.message } }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

export async function startApp() {
  const { router } = await import('@api/routes/index.router');
  return serve('/', router);
}

/**
 * Only /instance, behind the guards index.router puts in front of it
 * (instanceExistsGuard, instanceLoggedGuard, the apikey guard), for a test that
 * fakes the server module and hands the router its own instanceController.
 */
export async function startInstanceApp() {
  // index.router is where the import cycle through @exceptions (which takes HttpStatus
  // from it) has to start, as it does in main.ts; entered from a router, RouterBroker
  // is still undefined when the channel routers extend it.
  await import('@api/routes/index.router');
  const { InstanceRouter } = await import('@api/routes/instance.router');
  const { authGuard } = await import('@api/guards/auth.guard');
  const { instanceExistsGuard, instanceLoggedGuard } = await import('@api/guards/instance.guard');
  const { configService } = await import('@config/env.config');
  const guards = [instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']];
  return serve('/instance', new InstanceRouter(configService, ...guards).router);
}

/**
 * Only /chat, behind the same guards, for a test that fakes the server module and
 * hands the router its own chatController (whose monitor holds the service).
 */
export async function startChatApp() {
  await import('@api/routes/index.router');
  const { ChatRouter } = await import('@api/routes/chat.router');
  const { authGuard } = await import('@api/guards/auth.guard');
  const { instanceExistsGuard, instanceLoggedGuard } = await import('@api/guards/instance.guard');
  return serve('/chat', new ChatRouter(instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']).router);
}
