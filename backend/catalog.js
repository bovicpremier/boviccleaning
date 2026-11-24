// Single source of truth for Bovic Premier pricing, supporting live Admin overrides.
// Prices are in cents. `null` = custom quote.

const db = require('./db');

const HOME_SIZES = {
  cozy: 'Cozy · Studio–2 bed',
  family: 'Family · 3 bed / 2 bath',
  estate: 'Estate · 4+ bed',
};

const BASE_SERVICES = {
  standard: {
    label: 'Standard Home Cleaning',
    short: 'Standard Home',
    desc: 'Regular upkeep',
    sizes: HOME_SIZES,
    prices: {
      biweekly: { cozy: 15000, family: 19000, estate: 24000 },
      weekly: { cozy: 13000, family: 16000, estate: 20500 },
    },
  },
  deep: {
    label: 'Deep Cleaning',
    short: 'Deep Cleaning',
    desc: 'Top-to-bottom reset',
    sizes: HOME_SIZES,
    prices: { onetime: { cozy: 28000, family: 38000, estate: 48000 } },
  },
  move: {
    label: 'Move-In / Move-Out',
    short: 'Move-In / Out',
    desc: 'Empty-home detailing',
    sizes: HOME_SIZES,
    prices: { onetime: { cozy: 35000, family: 46000, estate: 58000 } },
  },
  airbnb: {
    label: 'Airbnb Turnover',
    short: 'Airbnb Turnover',
    desc: 'Fast guest reset',
    sizes: HOME_SIZES,
    prices: { onetime: { cozy: 9500, family: 14000, estate: null } },
  },
  office: {
    label: 'Office & Commercial',
    short: 'Office & Commercial',
    desc: 'Free estimate',
    quoteOnly: true,
    sizes: {
      cozy: 'Small office / studio',
      family: 'Medium office',
      estate: 'Large office / retail',
    },
    prices: { onetime: { cozy: null, family: null, estate: null } },
  },
  post_construction: {
    label: 'Post-Construction',
    short: 'Post-Construction',
    desc: 'Free estimate',
    quoteOnly: true,
    sizes: HOME_SIZES,
    prices: { onetime: { cozy: null, family: null, estate: null } },
  },
  painting: {
    label: 'Interior & Exterior Painting',
    short: 'Painting',
    desc: 'Free estimate',
    quoteOnly: true,
    sizes: {
      cozy: '1–2 rooms / trim & doors',
      family: 'Whole interior / main floor',
      estate: 'Exterior / full property',
    },
    prices: { onetime: { cozy: null, family: null, estate: null } },
  },
};

const FREQ_LABELS = {
  biweekly: 'Every 2 weeks',
  weekly: 'Weekly (save ~15%)',
  onetime: 'One-time',
};

let cachedOverrides = {};

async function init() {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'pricing_overrides'");
    cachedOverrides = row ? JSON.parse(row.value) : {};
  } catch {
    cachedOverrides = {};
  }
  return cachedOverrides;
}

function setOverridesCache(overrides) {
  cachedOverrides = overrides && typeof overrides === 'object' ? { ...overrides } : {};
}

function getOverrides() {
  return { ...cachedOverrides };
}

function getServices() {
  const overrides = getOverrides();
  const out = JSON.parse(JSON.stringify(BASE_SERVICES));
  for (const [key, cents] of Object.entries(overrides)) {
    const n = Number(cents);
    if (!Number.isFinite(n) || n <= 0) continue;
    // key format: service_freq_size (note post_construction has underscore, so parse against known services)
    for (const sKey of Object.keys(out)) {
      if (!key.startsWith(sKey + '_')) continue;
      const rest = key.slice(sKey.length + 1);
      const parts = rest.split('_');
      if (parts.length === 2) {
        const [fKey, zKey] = parts;
        if (out[sKey].prices[fKey] && zKey in out[sKey].prices[fKey] && out[sKey].prices[fKey][zKey] !== null) {
          out[sKey].prices[fKey][zKey] = Math.round(n);
        }
      }
    }
  }
  return out;
}

function priceFor(serviceKey, freqKey, sizeKey) {
  const services = getServices();
  const svc = services[serviceKey];
  if (!svc) return undefined;
  const freqMap = svc.prices[freqKey];
  if (!freqMap || !(sizeKey in freqMap)) return undefined;
  return freqMap[sizeKey];
}

function itemKey(serviceKey, freqKey, sizeKey) {
  return `${serviceKey}_${freqKey}_${sizeKey}`;
}

function labelsFor(serviceKey, freqKey, sizeKey) {
  const services = getServices();
  const svc = services[serviceKey];
  return {
    service: svc ? svc.label : serviceKey,
    size: svc && svc.sizes[sizeKey] ? svc.sizes[sizeKey] : sizeKey,
    freq: FREQ_LABELS[freqKey] || freqKey,
  };
}

function pricedItems() {
  const services = getServices();
  const items = [];
  for (const [sKey, svc] of Object.entries(services)) {
    for (const [fKey, sizes] of Object.entries(svc.prices)) {
      for (const [zKey, cents] of Object.entries(sizes)) {
        if (cents == null) continue;
        items.push({
          key: itemKey(sKey, fKey, zKey),
          service: svc.label,
          size: svc.sizes[zKey],
          freq: FREQ_LABELS[fKey],
          price_cents: cents,
        });
      }
    }
  }
  return items;
}

function publicCatalog() {
  return { services: getServices(), freqLabels: FREQ_LABELS };
}

module.exports = {
  get SERVICES() { return getServices(); },
  BASE_SERVICES,
  FREQ_LABELS,
  priceFor,
  itemKey,
  labelsFor,
  pricedItems,
  publicCatalog,
  getOverrides,
  setOverridesCache,
  init,
};
