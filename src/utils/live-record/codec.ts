// The tagged JSON a live-check tape is written in. It walks the value itself and
// never lets JSON.stringify see a payload, because JSON loses what Evolution
// branches on: Buffer vs Uint8Array, Long, an explicit undefined, protobuf
// classes (the webhook serializer calls toJSON on instances only), Boom errors.
//
//   {"$bytes":"<base64>","as":"Buffer"|"Uint8Array"}   {"$long":"<decimal>","u":true}
//   {"$u":1} undefined    {"$big":"<decimal>"}    {"$date":"<iso>"}
//   {"$err":{"message","statusCode","data"}}     {"$fn":"<name>"} (decodes to undefined)
//   {"$proto":"proto.Message.ImageMessage", ...fields}
import { Boom } from '@hapi/boom';
import { proto } from 'baileys';
import Long from 'long';

const protoName = (value: any): string | undefined => {
  const typeUrl = value?.constructor?.getTypeUrl;
  if (typeof typeUrl !== 'function') return undefined;
  return String(typeUrl.call(value.constructor)).split('/').pop();
};

export function encode(value: any): any {
  if (value === undefined) return { $u: 1 };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return { $big: value.toString() };
  if (typeof value === 'function') return { $fn: value.name || 'fn' };
  if (Long.isLong(value)) return { $long: value.toString(), u: !!value.unsigned };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64'), as: 'Buffer' };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64'), as: 'Uint8Array' };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Error) {
    const statusCode = (value as Boom).output?.statusCode;
    return { $err: { message: value.message, statusCode, data: encode((value as Boom).data) } };
  }
  if (Array.isArray(value)) return value.map(encode);
  const out: Record<string, any> = {};
  const name = protoName(value);
  if (name) out.$proto = name;
  for (const key of Object.keys(value)) out[key] = encode(value[key]);
  return out;
}

const protoClass = (name: string) => {
  const Ctor = name.split('.').slice(1).reduce((node: any, part) => node?.[part], proto);
  if (typeof Ctor !== 'function') throw new Error(`live-record: unknown protobuf class ${name}`);
  return Ctor;
};

export function decode(value: any): any {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  if ('$u' in value) return undefined;
  if ('$fn' in value) return undefined;
  if ('$bytes' in value) {
    const bytes = Buffer.from(value.$bytes, 'base64');
    return value.as === 'Buffer' ? bytes : new Uint8Array(bytes);
  }
  if ('$long' in value) return Long.fromString(value.$long, !!value.u);
  if ('$big' in value) return BigInt(value.$big);
  if ('$date' in value) return new Date(value.$date);
  if ('$err' in value) {
    const { message, statusCode, data } = value.$err;
    return statusCode ? new Boom(message, { statusCode, data: decode(data) }) : new Error(message);
  }
  const out: Record<string, any> = value.$proto ? new (protoClass(value.$proto))() : {};
  for (const key of Object.keys(value)) {
    if (key !== '$proto') out[key] = decode(value[key]);
  }
  return out;
}
