// Replaces @api/server.module, which builds the whole application at import
// (Prisma client, monitor, every controller). Handlers reach three things
// through it: eventManager (webhooks and other transports), chatbotController
// and waMonitor. Tests read what was emitted from `emitted`.
import { vi } from 'vitest';

import { fakePrisma } from './fake-prisma';

export const emitted: { event: string; data: any; extra?: any }[] = [];
export const eventManager = { emit: vi.fn(async (e: any) => void emitted.push({ event: e.event, data: e.data, extra: e.extra })) };
export const chatbotController = { emit: vi.fn(async () => undefined) };
export const waMonitor = { waInstances: {} };
export const prismaRepository = fakePrisma();
export const cache = undefined;
