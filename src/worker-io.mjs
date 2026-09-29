export class InputError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export class BoundedCache {
  constructor() { this.entries = new Map(); this.bytes = 0; }
  get(key) {
    const item = this.entries.get(key);
    if (item?.value?.expiresAt && item.value.expiresAt <= Date.now()) { this.delete(key); return undefined; }
    return item?.value;
  }
  delete(key) {
    const item = this.entries.get(key);
    if (!item) return false;
    this.bytes -= item.bytes;
    return this.entries.delete(key);
  }
  set(key, value) {
    this.delete(key);
    const bytes = (String(key).length + JSON.stringify(value).length) * 2;
    if (bytes > 4 * 1024 * 1024) return this;
    while (this.entries.size >= 128 || this.bytes + bytes > 4 * 1024 * 1024) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    return this;
  }
}

export async function readBytes(message, limit) {
  if (Number(message.headers.get('content-length')) > limit) {
    await message.body?.cancel();
    throw new InputError(413, 'input_too_large');
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new InputError(413, 'input_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function fetchRemote(url, limit, accept = '*/*') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || isBlockedFetchHost(current.hostname)) throw new InputError(400, 'blocked_source_url');
      const response = await fetch(current.href, { redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'AnywhereModuleConverter/0.1', accept, 'accept-encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new InputError(502, 'source_fetch_failed');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new InputError(502, 'source_fetch_failed'); }
      return { bytes: await readBytes(response, limit), finalUrl: current.href };
    }
  } finally {
    clearTimeout(timer);
  }
}

export function isBlockedFetchHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1, 3).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (host.includes(':')) return host === '::' || host === '::1' || host.startsWith('::ffff:') || /^(fc|fd|fe[89ab]|ff)/.test(host);
  return false;
}
