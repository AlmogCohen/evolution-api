// POST /chat/fetchVerifiedName asks WhatsApp for the name it certifies for a
// WhatsApp Business account: a USync query with the `business` protocol asking
// for `verified_name`, the way WhatsApp's own clients learn the name they show
// for a business that is not in the address book.
//
// Why: a business that sends no push name is named only by verifiedBizName on
// a LIVE message (fd192f45). A history page the phone sends again (ON_DEMAND)
// carried neither for ESHUV on 2026-10-18: 52 notices came back with their text
// and the sender's bare number. The name has to be asked for.
import { vi } from 'vitest';

const h = vi.hoisted(() => ({ waMonitor: undefined as any, chatController: undefined as any }));

vi.mock('@api/server.module', async () => {
  const fake = await import('../helpers/fake-server-module');
  return {
    ...fake,
    get waMonitor() {
      return h.waMonitor;
    },
    get chatController() {
      return h.chatController;
    },
  };
});

import { proto } from 'baileys';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeService } from '../helpers/baileys-service';
import { prismaRepository as prisma } from '../helpers/fake-server-module';
import { startChatApp } from '../helpers/http-app';

const TOKEN = 'instance-token';
const BUSINESS = '972500000077@s.whatsapp.net';
const PERSON = '972500000078@s.whatsapp.net';

/** The certificate WhatsApp's servers answer with, as bytes. */
function certificate(verifiedName: string) {
  const details = proto.VerifiedNameCertificate.Details.encode({ serial: 1234, issuer: 'smb:wa', verifiedName }).finish();
  return proto.VerifiedNameCertificate.encode({ details, signature: new Uint8Array(64) }).finish();
}

/** WhatsApp's usync answer for one user, with whatever that user's `business` element holds. */
function usyncResult(jid: string, business: any[] | null) {
  return {
    tag: 'iq',
    attrs: { type: 'result' },
    content: [
      {
        tag: 'usync',
        attrs: {},
        content: [{ tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid }, content: business ? [{ tag: 'business', attrs: {}, content: business }] : [] }] }],
      },
    ],
  };
}

let app: Awaited<ReturnType<typeof startChatApp>>;
let queries: any[];
let answers: Record<string, any[] | null>;

beforeAll(async () => {
  await prisma.instance.create({ data: { id: 'inst-1', name: 'test', connectionStatus: 'open', token: TOKEN, integration: 'WHATSAPP-BAILEYS' } });
  const { service } = await makeService({ prisma });
  // What Baileys' executeUSyncQuery does around the network: build the query from the
  // protocols, then hand WhatsApp's answer to the query's own parser.
  service.client.executeUSyncQuery = async (query: any) => {
    queries.push({
      protocols: query.protocols.map((p: any) => p.getQueryElement()),
      users: query.users.map((u: any) => u.id),
      userElements: query.users.flatMap((u: any) => query.protocols.map((p: any) => p.getUserElement(u)).filter(Boolean)),
    });
    const jid = query.users[0].id;
    return query.parseUSyncQueryResult(usyncResult(jid, answers[jid] ?? null));
  };
  h.waMonitor = { waInstances: { test: service } };
  const { ChatController } = await import('@api/controllers/chat.controller');
  h.chatController = new ChatController(h.waMonitor);
  app = await startChatApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  queries = [];
  answers = {};
});

async function post(body: Record<string, any>) {
  const res = await fetch(`${app.base}/chat/fetchVerifiedName/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /chat/fetchVerifiedName answers the name WhatsApp certifies for a business', () => {
  it('asks usync for business/verified_name for that user and answers the certificate name', async () => {
    answers[BUSINESS] = [{ tag: 'verified_name', attrs: { v: '1', serial: '1234' }, content: certificate('The Committee') }];
    const res = await post({ number: '972500000077' });
    expect(res).toEqual({ status: 200, body: { jid: BUSINESS, verifiedName: 'The Committee' } });
    expect(queries).toEqual([
      { protocols: [{ tag: 'business', attrs: {}, content: [{ tag: 'verified_name', attrs: {} }] }], users: [BUSINESS], userElements: [] },
    ]);
  });

  it('takes a JID as well as a number', async () => {
    answers[BUSINESS] = [{ tag: 'verified_name', attrs: {}, content: certificate('The Committee') }];
    expect((await post({ number: BUSINESS })).body).toEqual({ jid: BUSINESS, verifiedName: 'The Committee' });
  });

  it('answers null for an account WhatsApp certifies no name for (a person)', async () => {
    expect(await post({ number: PERSON })).toEqual({ status: 200, body: { jid: PERSON, verifiedName: null } });
  });

  it('answers null for a business element with no verified name in it', async () => {
    answers[BUSINESS] = [];
    expect((await post({ number: BUSINESS })).body).toEqual({ jid: BUSINESS, verifiedName: null });
  });

  it('refuses a request with no number with a 400 and asks WhatsApp nothing', async () => {
    expect((await post({})).status).toBe(400);
    expect(queries).toEqual([]);
  });
});
