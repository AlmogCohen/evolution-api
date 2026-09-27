// A live-check tape stores Baileys events as JSON lines, and a replay must hand
// Evolution the same values the socket did. JSON alone loses exactly the
// shapes Evolution branches on: a Buffer and a Uint8Array both become base64
// (or an index object), a Long becomes {low, high, unsigned}, an undefined
// field disappears (Object.assign in the event buffer overwrites with it), and
// a protobuf instance becomes a plain object (the webhook serializer calls
// toJSON on instances only).
import { Boom } from '@hapi/boom';
import { proto } from 'baileys';
import Long from 'long';
import { describe, expect, it } from 'vitest';

import { decode, encode } from '@utils/live-record/codec';

/** Through a file and back: encode, JSON text, parse, decode. */
const roundTrip = (value: any) => decode(JSON.parse(JSON.stringify(encode(value))));

describe('live-record codec', () => {
  it('keeps a Buffer a Buffer and a Uint8Array a Uint8Array, byte for byte', () => {
    const back = roundTrip({ buf: Buffer.from([1, 2, 3]), u8: new Uint8Array([250, 0, 7]) });
    expect(Buffer.isBuffer(back.buf)).toBe(true);
    expect([...back.buf]).toEqual([1, 2, 3]);
    expect(back.u8).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(back.u8)).toBe(false);
    expect([...back.u8]).toEqual([250, 0, 7]);
  });

  it('keeps a Long a Long, with its value and signedness', () => {
    const back = roundTrip({ ts: Long.fromString('1758873600', true), big: Long.fromString('-9007199254740993') });
    expect(Long.isLong(back.ts)).toBe(true);
    expect(back.ts.toString()).toBe('1758873600');
    expect(back.ts.unsigned).toBe(true);
    expect(Long.isLong(back.big)).toBe(true);
    expect(back.big.toString()).toBe('-9007199254740993');
    expect(back.big.unsigned).toBe(false);
  });

  it('keeps an explicit undefined field, in objects and arrays', () => {
    const back = roundTrip({ a: 1, gone: undefined, list: [undefined, 2] });
    expect(Object.keys(back)).toEqual(['a', 'gone', 'list']);
    expect(back.gone).toBeUndefined();
    expect(back.list).toEqual([undefined, 2]);
    expect(back.list.length).toBe(2);
  });

  it('rebuilds protobuf classes, nested ones included, with their fields as they were', () => {
    const message = proto.Message.fromObject({
      imageMessage: { mimetype: 'image/jpeg', mediaKey: new Uint8Array([9, 8, 7]), fileLength: Long.fromNumber(48213, true) },
    });
    const info = proto.WebMessageInfo.fromObject({
      key: { remoteJid: '972500000001@s.whatsapp.net', fromMe: false, id: '3EB0000000000000000001' },
      messageTimestamp: Long.fromNumber(1758873600, true),
      status: proto.WebMessageInfo.Status.SERVER_ACK,
    });
    info.message = message;

    const back = roundTrip({ info });
    expect(back.info).toBeInstanceOf(proto.WebMessageInfo);
    expect(back.info.key).toBeInstanceOf(proto.MessageKey);
    expect(back.info.message).toBeInstanceOf(proto.Message);
    expect(back.info.message.imageMessage).toBeInstanceOf(proto.Message.ImageMessage);
    expect(back.info.status).toBe(proto.WebMessageInfo.Status.SERVER_ACK);
    expect(Long.isLong(back.info.messageTimestamp)).toBe(true);
    expect(back.info.messageTimestamp.toString()).toBe('1758873600');
    expect(back.info.message.imageMessage.mediaKey).toBeInstanceOf(Uint8Array);
    expect([...back.info.message.imageMessage.mediaKey]).toEqual([9, 8, 7]);
    expect(back.info.message.imageMessage.fileLength.toString()).toBe('48213');
    // What the webhook serializer sees is the same JSON as the original's.
    expect(JSON.stringify(back.info)).toBe(JSON.stringify(info));
  });

  it('keeps a disconnect error a Boom with its status code', () => {
    const back = roundTrip({ lastDisconnect: { error: new Boom('Connection Failure', { statusCode: 401 }), date: new Date(0) } });
    expect(back.lastDisconnect.error).toBeInstanceOf(Boom);
    expect(back.lastDisconnect.error.output.statusCode).toBe(401);
    expect(back.lastDisconnect.error.message).toBe('Connection Failure');
    expect(back.lastDisconnect.date).toBeInstanceOf(Date);
    expect(back.lastDisconnect.date.getTime()).toBe(0);
  });
});
