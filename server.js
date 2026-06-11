import http from 'node:http';
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '..');

loadDotEnv(resolve(process.env.MARKETPLACE_ENV_FILE ?? join(__dirname, '.env')));

const minecraftTextures = buildMinecraftTextureIndex();

const config = {
  port: numberEnv('PORT', 20120),
  publicBaseUrl: stringEnv('PUBLIC_BASE_URL', 'http://localhost:20120').replace(/\/$/, ''),
  deliveryApiBaseUrl: stringEnv('STORAGE_DELIVERY_API_BASE_URL', 'http://localhost:20010').replace(/\/$/, ''),
  marketplaceName: stringEnv('MARKETPLACE_NAME', 'KaroMall'),
  orderRateLimitPerMinute: numberEnv('MARKETPLACE_ORDER_RATE_LIMIT_PER_MINUTE', 20),
  catalogCacheMs: numberEnv('MARKETPLACE_CATALOG_CACHE_SECONDS', 10) * 1000,
  publicDir: join(__dirname, 'public'),
  sites: parseMarketplaceSites()
};

const siteById = new Map(config.sites.map(site => [site.siteId, site]));
const rateBuckets = new Map();
const catalogCache = {
  expiresAt: 0,
  data: null
};

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[delivery-marketplace] request failed:', error);
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.expose ? error.message : 'INTERNAL_ERROR'
    });
  });
});

server.listen(config.port, () => {
  console.log(`[delivery-marketplace] listening on ${config.port}`);
  console.log(`[delivery-marketplace] public base: ${config.publicBaseUrl}`);
  console.log(`[delivery-marketplace] configured sites: ${config.sites.length}`);
});

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', config.publicBaseUrl);
  const path = stripTrailingSlash(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      ok: true,
      configuredSites: config.sites.length,
      time: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      marketplaceName: config.marketplaceName,
      configured: config.sites.length > 0,
      siteCount: config.sites.length
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/catalog') {
    await handleCatalog(res);
    return;
  }

  if (req.method === 'POST' && path === '/api/orders') {
    await handleCreateOrders(req, res);
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/orders/')) {
    await handleOrderStatus(req, res, path);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path.startsWith('/assets/minecraft-textures/')) {
      if (serveMinecraftTexture(req, res, path)) return;
    }
    if (serveStatic(req, res, url.pathname)) return;
  }

  sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
}

async function handleCatalog(res) {
  const now = Date.now();
  if (catalogCache.data && catalogCache.expiresAt > now) {
    sendJson(res, 200, catalogCache.data);
    return;
  }

  if (config.sites.length === 0) {
    const empty = {
      ok: true,
      configured: false,
      marketplaceName: config.marketplaceName,
      sites: [],
      products: [],
      errors: []
    };
    catalogCache.data = empty;
    catalogCache.expiresAt = now + 1000;
    sendJson(res, 200, empty);
    return;
  }

  const results = await Promise.allSettled(config.sites.map(loadSiteCatalog));
  const sites = [];
  const products = [];
  const errors = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      sites.push(result.value.site);
      products.push(...result.value.products);
    } else {
      errors.push(result.reason?.message || 'CATALOG_LOAD_FAILED');
    }
  }

  const data = {
    ok: true,
    configured: true,
    marketplaceName: config.marketplaceName,
    sites,
    products: products.sort((a, b) => a.title.localeCompare(b.title, 'ja')),
    errors
  };
  catalogCache.data = data;
  catalogCache.expiresAt = now + config.catalogCacheMs;
  sendJson(res, 200, data);
}

async function loadSiteCatalog(siteConfig) {
  const siteId = siteConfig.siteId;
  const [meta, items] = await Promise.all([
    deliveryPublicRequest(`/api/sites/${encodeURIComponent(siteId)}/meta`),
    deliveryPublicRequest(`/api/sites/${encodeURIComponent(siteId)}/items`)
  ]);

  const site = {
    id: meta.site.id,
    serverId: meta.site.serverId,
    ownerName: meta.site.ownerName,
    storeName: siteConfig.label || meta.site.storeName,
    status: meta.site.status,
    rates: meta.rates || []
  };

  return {
    site,
    products: (items.items || []).map(item => ({
      id: `${site.id}:${item.id}`,
      siteId: site.id,
      itemId: item.id,
      storageItemId: item.storageItemId,
      sellerName: site.storeName,
      sellerOwnerName: site.ownerName,
      serverId: site.serverId,
      title: item.title || item.itemName || item.itemTypeId || 'Storage Item',
      description: item.description || '',
      iconPath: item.iconPath || '',
      iconUrl: resolveProductIconUrl(item),
      itemTypeId: item.itemTypeId || '',
      itemName: item.itemName || '',
      itemProperties: sanitizeItemProperties(item.itemProperties),
      unitPrice: Number(item.unitPrice || 0),
      availableQuantity: Number(item.availableQuantity || 0),
      maxQuantity: Number(item.maxQuantity || 1),
      rates: site.rates
    }))
  };
}

async function handleCreateOrders(req, res) {
  rateLimit(req, 'orders', config.orderRateLimitPerMinute);

  if (config.sites.length === 0) {
    throw httpError(503, 'MARKETPLACE_NOT_CONFIGURED');
  }

  const body = await readJson(req);
  const recipientName = sanitizePlayerName(body.recipientName || body.playerName);
  const recipientStoreName = sanitizeText(body.recipientStoreName || body.storeName, 80) || null;
  const lines = normalizeOrderLines(body);

  if (!recipientName) throw httpError(400, 'INVALID_RECIPIENT');
  if (lines.length === 0 || lines.length > 10) throw httpError(400, 'INVALID_CART');

  const orderGroupId = `dmo_${Date.now()}_${randomBytes(8).toString('base64url')}`;
  const successUrl = `${config.publicBaseUrl}/?checkout=success&group=${encodeURIComponent(orderGroupId)}`;
  const cancelUrl = `${config.publicBaseUrl}/?checkout=cancel&group=${encodeURIComponent(orderGroupId)}`;

  const prepared = [];
  for (const [index, line] of lines.entries()) {
    const siteConfig = siteById.get(line.siteId);
    if (!siteConfig) throw httpError(400, 'INVALID_SITE');

    const catalog = await loadSiteCatalog(siteConfig);
    const product = catalog.products.find(item => item.itemId === line.itemId);
    if (!product) throw httpError(400, 'INVALID_ITEM');

    const rate = product.rates.find(entry => entry.id === line.rateId && entry.status === 'active');
    if (!rate) throw httpError(400, 'INVALID_RATE');

    const quantity = parsePositiveInteger(line.quantity, Math.min(product.maxQuantity, product.availableQuantity, 64));
    if (!quantity) throw httpError(400, 'INVALID_QUANTITY');
    if (quantity < Number(rate.minQuantity || 1)) throw httpError(400, 'INVALID_RATE');
    if (rate.maxQuantity !== null && rate.maxQuantity !== undefined && quantity > Number(rate.maxQuantity)) {
      throw httpError(400, 'INVALID_RATE');
    }

    prepared.push({
      siteConfig,
      product,
      rate,
      quantity,
      clientReferenceId: `${orderGroupId}_${index}`
    });
  }

  const orders = [];
  for (const entry of prepared) {
    const draft = {
      itemId: entry.product.itemId,
      rateId: entry.rate.id,
      recipientName,
      recipientStoreName,
      quantity: entry.quantity,
      successUrl,
      cancelUrl,
      clientReferenceId: entry.clientReferenceId
    };

    const signature = await deliveryAdminRequest(
      entry.siteConfig,
      `/api/admin/sites/${encodeURIComponent(entry.siteConfig.siteId)}/order-signatures`,
      {
        method: 'POST',
        body: draft
      }
    );

    const created = await deliveryPublicRequest(`/api/sites/${encodeURIComponent(entry.siteConfig.siteId)}/orders`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': entry.clientReferenceId,
        'X-Storage-Delivery-Timestamp': String(signature.timestamp),
        'X-Storage-Delivery-Signature': signature.signature
      },
      body: draft
    });

    orders.push({
      ...created.order,
      checkoutUrl: created.checkoutUrl || created.order?.checkoutUrl || null,
      product: {
        title: entry.product.title,
        sellerName: entry.product.sellerName
      }
    });
  }

  sendJson(res, 201, {
    ok: true,
    orderGroupId,
    orders,
    checkoutUrls: orders.map(order => order.checkoutUrl).filter(Boolean)
  });
}

async function handleOrderStatus(_req, res, path) {
  const parts = path.split('/').filter(Boolean);
  const siteId = parts[2] || '';
  const orderId = parts[3] || '';
  const siteConfig = siteById.get(siteId);

  if (!siteConfig || !safeToken(siteId) || !safeToken(orderId)) {
    throw httpError(404, 'ORDER_NOT_FOUND');
  }

  const data = await deliveryPublicRequest(
    `/api/sites/${encodeURIComponent(siteId)}/orders/${encodeURIComponent(orderId)}`
  );
  sendJson(res, 200, data);
}

async function deliveryPublicRequest(path, options = {}) {
  return deliveryRequest(path, {
    ...options,
    publicRequest: true
  });
}

async function deliveryAdminRequest(siteConfig, path, options = {}) {
  if (!siteConfig.adminToken) throw httpError(503, 'SITE_ADMIN_TOKEN_MISSING');
  return deliveryRequest(path, {
    ...options,
    token: siteConfig.adminToken
  });
}

async function deliveryRequest(path, options = {}) {
  const response = await fetch(`${config.deliveryApiBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.publicRequest ? { Origin: publicOrigin() } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw httpError(response.status || 502, data?.error || 'DELIVERY_API_FAILED');
  }
  return data;
}

function normalizeOrderLines(body) {
  const rawLines = Array.isArray(body.lines)
    ? body.lines
    : [{
        siteId: body.siteId,
        itemId: body.itemId,
        rateId: body.rateId,
        quantity: body.quantity
      }];

  return rawLines.map(line => ({
    siteId: sanitizeToken(line?.siteId, 120),
    itemId: sanitizeToken(line?.itemId || line?.siteItemId, 120),
    rateId: sanitizeToken(line?.rateId, 120),
    quantity: line?.quantity
  })).filter(line => line.siteId && line.itemId && line.rateId);
}

function parseMarketplaceSites() {
  const sites = [];
  const raw = String(process.env.MARKETPLACE_SITES || '').trim();

  if (raw) {
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        for (const entry of parsed) {
          pushSite(sites, entry?.siteId, entry?.adminToken, entry?.label || entry?.storeName);
        }
      } catch (error) {
        console.warn('[delivery-marketplace] MARKETPLACE_SITES JSON could not be parsed:', error);
      }
    } else {
      for (const entry of raw.split(/[;\n]+/)) {
        const [siteId, adminToken, label] = entry.split('|').map(value => value?.trim());
        pushSite(sites, siteId, adminToken, label);
      }
    }
  }

  pushSite(
    sites,
    process.env.STORAGE_DELIVERY_SITE_ID,
    process.env.STORAGE_DELIVERY_SITE_ADMIN_TOKEN,
    process.env.STORAGE_DELIVERY_SITE_LABEL
  );

  const unique = new Map();
  for (const site of sites) {
    if (!unique.has(site.siteId)) unique.set(site.siteId, site);
  }
  return [...unique.values()];
}

function pushSite(sites, siteId, adminToken, label) {
  const normalizedSiteId = sanitizeToken(siteId, 120);
  const normalizedAdminToken = sanitizeToken(adminToken, 200);
  if (!normalizedSiteId || !normalizedAdminToken) return;

  sites.push({
    siteId: normalizedSiteId,
    adminToken: normalizedAdminToken,
    label: sanitizeText(label, 80)
  });
}

function resolveProductIconUrl(item) {
  const directUrl = normalizeIconUrl(item.iconPath);
  if (directUrl) return directUrl;

  const textureKey = resolveMinecraftTextureKey(item.iconPath, item.itemTypeId);
  return textureKey ? `/assets/minecraft-textures/${encodeURIComponent(textureKey)}` : null;
}

function normalizeIconUrl(iconPath) {
  const value = String(iconPath || '').trim();
  if (!value) return null;

  try {
    return new URL(value).toString();
  } catch {
    if (value.startsWith('/')) return `${config.deliveryApiBaseUrl}${value}`;
    return null;
  }
}

function buildMinecraftTextureIndex() {
  const files = new Map();
  const aliases = new Map();

  for (const root of minecraftTextureRoots()) {
    if (!existsSync(root)) continue;
    scanMinecraftTextureRoot(root, root, files);
    loadMinecraftTextureAliases(root, aliases);
  }

  console.log(`[delivery-marketplace] indexed minecraft textures: ${files.size} files, ${aliases.size} aliases`);
  return { files, aliases };
}

function minecraftTextureRoots() {
  const configured = String(process.env.MARKETPLACE_RESOURCE_PACK_DIRS || '').trim();
  const roots = configured
    ? configured.split(/[,\n;]/).map(entry => resolve(entry.trim())).filter(Boolean)
    : [
      join(__dirname, 'resource-packs', 'karoearth'),
      join(__dirname, 'resource-packs', 'MakeCountryResourcePack'),
      join(__dirname, 'resource-packs', 'vanilla'),
      join(workspaceRoot, 'bedrock_server', 'development_resource_packs', 'karoearth'),
      join(workspaceRoot, 'bedrock_server', 'development_resource_packs', 'MakeCountryResourcePack'),
      join(workspaceRoot, 'Map', 'vanilla_textures')
    ];

  return [...new Set(roots.map(root => normalize(root)))];
}

function scanMinecraftTextureRoot(root, current, files) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      scanMinecraftTextureRoot(root, fullPath, files);
      continue;
    }

    if (!entry.isFile() || !isWebImage(fullPath)) continue;
    const relPath = toPosixPath(relative(root, fullPath));
    indexTextureFile(files, relPath, fullPath);
  }
}

function indexTextureFile(files, relPath, fullPath) {
  const withoutExtension = relPath.replace(/\.(png|jpe?g|webp)$/i, '');
  const keys = new Set([
    relPath,
    withoutExtension
  ]);

  if (!withoutExtension.startsWith('textures/')) {
    keys.add(`textures/${withoutExtension}`);
  }

  if (withoutExtension.startsWith('textures/')) {
    keys.add(withoutExtension.replace(/^textures\//, ''));
  }

  for (const key of keys) {
    const normalized = normalizeTextureKey(key);
    if (normalized && !files.has(normalized)) files.set(normalized, fullPath);
  }
}

function loadMinecraftTextureAliases(root, aliases) {
  for (const filePath of [
    join(root, 'textures', 'item_texture.json'),
    join(root, 'item_texture.json')
  ]) {
    if (!existsSync(filePath)) continue;

    let data;
    try {
      data = JSON.parse(stripJsonComments(readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.warn(`[delivery-marketplace] item_texture.json could not be parsed: ${filePath}`, error);
      continue;
    }

    const textureData = data?.texture_data && typeof data.texture_data === 'object'
      ? data.texture_data
      : {};
    for (const [itemKey, entry] of Object.entries(textureData)) {
      const texture = firstTexturePath(entry);
      const textureKey = normalizeTextureKey(texture);
      if (!textureKey) continue;
      for (const alias of textureAliasesFor(itemKey)) {
        if (!aliases.has(alias)) aliases.set(alias, textureKey);
      }
    }
  }
}

function stripJsonComments(value) {
  return String(value)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function firstTexturePath(entry) {
  const value = entry?.textures;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find(item => typeof item === 'string');
    return first || '';
  }
  if (value && typeof value === 'object') {
    const first = Object.values(value).find(item => typeof item === 'string');
    return first || '';
  }
  return '';
}

function textureAliasesFor(itemKey) {
  const raw = String(itemKey || '').trim();
  const short = raw.includes(':') ? raw.split(':').pop() : raw;
  return [raw, short].map(normalizeTextureKey).filter(Boolean);
}

function resolveMinecraftTextureKey(...values) {
  const candidates = [];
  for (const value of values) {
    const normalized = normalizeTextureKey(value);
    if (!normalized) continue;

    candidates.push(normalized);
    const alias = minecraftTextures.aliases.get(normalized);
    if (alias) candidates.push(alias);

    const short = normalized.includes(':') ? normalized.split(':').pop() : normalized.split('/').pop();
    if (short) {
      candidates.push(short);
      candidates.push(`items/${short}`);
      candidates.push(`textures/items/${short}`);
      const shortAlias = minecraftTextures.aliases.get(short);
      if (shortAlias) candidates.push(shortAlias);
    }
  }

  for (const candidate of candidates) {
    const key = normalizeTextureKey(candidate);
    if (key && minecraftTextures.files.has(key)) return key;
  }
  return null;
}

function normalizeTextureKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
  text = text.replace(/\.(png|jpe?g|webp)$/i, '');
  return text.replace(/\/+/g, '/');
}

function serveMinecraftTexture(req, res, requestPath) {
  const encoded = requestPath.slice('/assets/minecraft-textures/'.length);
  let textureKey;
  try {
    textureKey = decodeURIComponent(encoded);
  } catch {
    return false;
  }

  const normalized = normalizeTextureKey(textureKey);
  const filePath = normalized ? minecraftTextures.files.get(normalized) : null;
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return false;

  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'public, max-age=86400'
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

function sanitizeItemProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const json = JSON.stringify(properties);
  if (json.length > 12000) return {};
  return JSON.parse(json);
}

function isWebImage(filePath) {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(filePath).toLowerCase());
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function rateLimit(req, action, limit) {
  const key = `${clientIp(req)}:${action}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }

  if (bucket.count >= limit) throw httpError(429, 'RATE_LIMITED');
  bucket.count++;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

async function readJson(req) {
  const raw = await readBody(req, 128 * 1024);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'INVALID_JSON');
  }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function serveStatic(req, res, requestPath) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  const decoded = safeDecodePath(pathname);
  if (!decoded) return false;

  const fullPath = normalize(join(config.publicDir, decoded));
  if (!fullPath.startsWith(config.publicDir + sep)) return false;
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return false;

  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentTypeFor(fullPath),
    'Cache-Control': fullPath.endsWith('index.html') ? 'no-store' : 'public, max-age=300'
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(fullPath).pipe(res);
  return true;
}

function safeDecodePath(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return '';
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: http: https:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  };
}

function contentTypeFor(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function publicOrigin() {
  try {
    return new URL(config.publicBaseUrl).origin;
  } catch {
    return config.publicBaseUrl;
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function sanitizeText(value, maxLength = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizePlayerName(value) {
  const text = sanitizeText(value, 32);
  return text || '';
}

function sanitizeToken(value, maxLength = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) return '';
  return safeToken(text) ? text : '';
}

function safeToken(value) {
  return /^[A-Za-z0-9._:-]+$/.test(String(value || ''));
}

function parsePositiveInteger(value, max) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > max) return undefined;
  return amount;
}

function stripTrailingSlash(path) {
  if (path === '/') return '';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function stringEnv(name, fallback) {
  return process.env[name] && process.env[name].trim() !== ''
    ? process.env[name].trim()
    : fallback;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
