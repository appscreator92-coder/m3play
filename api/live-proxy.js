/* A stream proxy that runs in Mumbai, and borrows an Indian address when
 * Mumbai is not enough.
 *
 *   GET /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=][&via=host:port]
 */
import { ProxyAgent } from 'undici';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];
const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

let pool = { list: [], at: 0 };
let known = new Map();

async function proxyList() {
  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  try {
    const r = await fetch(PROXY_LIST, { cache: 'no-store' });
    const txt = await r.text();
    const list = txt.split('\n').map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
    if (list.length) pool = { list, at: Date.now() };
  } catch { /* keep whatever we had */ }
  return pool.list;
}

function get(url, headers, proxy, ms) {
  const opts = { headers, signal: AbortSignal.timeout(ms) };
  if (proxy) opts.dispatcher = new ProxyAgent({ uri: `http://${proxy}`, connectTimeout: ms });
  return fetch(url, opts);
}

async function findProxy(url, headers, hostname, skip = '') {
  const list = await proxyList();
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const rest = list.filter(p => p !== remembered && p !== skip);
  const ordered = remembered && remembered !== skip ? [remembered, ...rest] : rest;

  for (let i = 0; i < Math.min(ordered.length, 48); i += 8) {
    const batch = ordered.slice(i, i + 8);
    const hit = await Promise.any(batch.map(async (p) => {
      const r = await get(url, headers, p, 7000);
      if (!r.ok) throw new Error(String(r.status));
      return { proxy: p, res: r };
    })).catch(() => null);
    if (hit) { known.set(hostname, hit.proxy); return hit; }
  }
  return null;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url: target, cookie = '', ref = '', ua = '', via = '' } = req.query;
  if (!target) return res.status(400).send('Missing ?url=');

  let targetUrl;
  try { targetUrl = new URL(target); } catch { return res.status(400).send('Invalid url'); }
  if (!allowed(targetUrl.hostname)) return res.status(403).send('Host not allowed');

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep target's */ } }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  let upstream, usedProxy = '';
  try {
    if (via) {
      const pinned = known.get(targetUrl.hostname) || via;
      usedProxy = pinned;
      try { upstream = await get(targetUrl.toString(), headers, pinned, 8000); }
      catch { upstream = null; }
      if (!upstream || !upstream.ok) {
        if (known.get(targetUrl.hostname) === pinned) known.delete(targetUrl.hostname);
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, pinned);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
        else if (!upstream) { upstream = await get(targetUrl.toString(), headers, null, 15000); usedProxy = ''; }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
      if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      else upstream = await get(targetUrl.toString(), headers, null, 15000);
    } else {
      upstream = await get(targetUrl.toString(), headers, null, 15000);
    }
  } catch (e) {
    return res.status(502).send('Upstream failed: ' + e.message);
  }

  if (usedProxy) res.setHeader('X-Proxy-Via', usedProxy);

  if (!upstream.ok) {
    const body = await upstream.text();
    res.setHeader('X-Proxy-Upstream', String(upstream.status));
    return res.status(upstream.status).send(body.slice(0, 2000));
  }

  const ct = upstream.headers.get('content-type') || '';
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lower.endsWith('.mpd') || ct.includes('dash+xml');

  if (isDash) {
    let xml = await upstream.text();
    const base = `https://${req.headers.host}/api/live-proxy`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    const parentUrl = targetUrl.toString();
    const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1);

    xml = xml.replace(/<SegmentTemplate\b([^>]*?)>/g, (match, attrs) => {
      let updated = attrs.replace(/\b(media|initialization)="([^"]+)"/g, (m, attr, val) => {
        let abs;
        try {
          abs = new URL(val, dir).toString();
        } catch {
          abs = val;
        }
        return `${attr}="${base + '?url=' + encodeURIComponent(abs) + extras}"`;
      });
      return `<SegmentTemplate ${updated}>`;
    });

    res.setHeader('Content-Type', 'application/dash+xml');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(xml);
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const base = `https://${req.headers.host}/api/live-proxy`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, targetUrl);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + '?url=' + encodeURIComponent(abs) + extras;

    const body = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(body);
  }

  res.setHeader('Content-Type', ct || 'application/octet-stream');
  res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  return res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
}
