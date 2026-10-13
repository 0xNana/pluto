import { hexToBytes, toHex } from 'viem';

// Only public protocol values cross this boundary. Secret recovery files use a
// separate download path and are never sent to this encoder by network callers.
export function encodeWire(value: unknown) {
  return JSON.stringify(value, (_key, field: unknown) => typeof field === 'bigint' ? { $bigint: String(field) }
    : field instanceof Uint8Array ? { $bytes: toHex(field) } : field);
}
export function decodeWire(json: string): unknown {
  if (json.length > 2_300_000) throw new Error('Public response too large');
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1) {
      const field = value as Record<string, unknown>;
      if (typeof field.$bigint === 'string') {
        if (!/^(0|[1-9][0-9]{0,77})$/.test(field.$bigint) || BigInt(field.$bigint) >= 1n << 256n) throw new Error('Invalid protocol integer');
        return BigInt(field.$bigint);
      }
      if (typeof field.$bytes === 'string') {
        if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(field.$bytes) || field.$bytes.length > 100_000) throw new Error('Invalid public bytes');
        return hexToBytes(field.$bytes as `0x${string}`);
      }
    }
    return value;
  });
}
