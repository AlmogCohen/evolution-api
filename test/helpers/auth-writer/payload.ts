// A key value that is large and says which write it is: `fill` is `tag`, in base 36,
// repeated to `size` characters. A file that parses to a value whose fill is the one its
// tag and size give holds one complete write; anything else is torn.
export const payload = (tag: number, size: number) => {
  const unit = `${tag.toString(36)}:`;
  return { tag, size, fill: unit.repeat(Math.ceil(size / unit.length)).slice(0, size) };
};

/** What a key file holds: one complete payload (its tag), or why not. */
export function complete(raw: string | undefined): { tag: number } | 'missing' | 'empty' | 'torn' {
  if (raw === undefined) return 'missing';
  if (raw === '') return 'empty';
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'torn';
  }
  const whole = Number.isSafeInteger(value?.tag) && Number.isSafeInteger(value?.size) && value.fill === payload(value.tag, value.size).fill;
  return whole ? { tag: value.tag } : 'torn';
}
