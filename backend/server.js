require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const Stripe = require('stripe');

const db = require('./db');
const catalog = require('./catalog');
const mailer = require('./mailer');

// Ensure seasonal promo columns exist cleanly
try { db.exec("ALTER TABLE bookings ADD COLUMN promo_code TEXT DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE bookings ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0'); } catch {}

const app = express();
app.disable('x-powered-by');
// Only trust X-Forwarded-For when explicitly running behind a reverse proxy (nginx, Cloudflare, cPanel Node proxy).
// Trusting it by default lets anyone spoof their IP and bypass rate limits.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim();
if (TRUST_PROXY && TRUST_PROXY !== '0' && TRUST_PROXY.toLowerCase() !== 'false') {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? 1 : TRUST_PROXY);
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_HTTPS = BASE_URL.startsWith('https://');

// Demo checkout (fake "paid" bookings) is only allowed on a local dev server, or when explicitly enabled.
const IS_LOCAL_BASE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(BASE_URL);
const DEMO_CHECKOUT_ALLOWED = String(process.env.ALLOW_DEMO_CHECKOUT || '').toLowerCase() === 'true'
  || (IS_LOCAL_BASE && process.env.NODE_ENV !== 'production');

// ============================================================
// BUSINESS TIME ZONE HELPERS (all dates/times are North Atlanta local time)
// ============================================================
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/New_York';

function tzParts(ms, tz = BUSINESS_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

// Today's date (YYYY-MM-DD) in the business time zone
function businessToday(now = Date.now()) {
  const p = tzParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Current month (1-12) in the business time zone
function businessMonth(now = Date.now()) {
  return tzParts(now).month;
}

// Convert a business-local wall-clock time into a UTC epoch (DST-safe)
function zonedToEpoch(dateStr, hr, min) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, hr, min, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(guess);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wallAsUtc - shownAsUtc;
  }
  return guess;
}

// Strong JWT signing secret (never a hardcoded literal)
function loadJwtSecret() {
  const envSec = (process.env.JWT_SECRET || '').trim();
  if (envSec.length >= 32 && !envSec.includes('change_in_production') && !envSec.includes('dev_secret')) {
    return envSec;
  }
  const secPath = path.join(__dirname, 'data', '.jwt-secret');
  if (fs.existsSync(secPath)) return fs.readFileSync(secPath, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secPath, generated, { mode: 0o600 });
  return generated;
}
const JWT_SECRET = loadJwtSecret();

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripeApiConfigured =
  (stripeKey.startsWith('sk_test_') || stripeKey.startsWith('sk_live_')) && !stripeKey.includes('your_stripe');
const stripe = stripeApiConfigured ? Stripe(stripeKey) : null;

const TIME_SLOTS = ['08:00 AM', '10:30 AM', '01:00 PM', '03:30 PM'];
const MAX_BOOKINGS_PER_SLOT = 2;
const STAFF_ROLES = ['super_admin', 'admin'];
const SESSION_COOKIE = 'bovic_session';
const CSRF_COOKIE = 'bovic_csrf';

// ============================================================
// HELPERS: COOKIES, IP, RATE LIMITER, AUDIT LOG, PASSWORDS
// ============================================================
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function setSessionCookies(res, req, token, csrfToken) {
  const secureFlag = IS_HTTPS || req.secure ? '; Secure' : '';
  const maxAge = 8 * 60 * 60; // 8 hours
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureFlag}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secureFlag}`,
  ]);
}

function clearSessionCookies(res, req) {
  const secureFlag = IS_HTTPS || req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secureFlag}`,
  ]);
}

function clientIp(req) {
  return String(req.ip || req.socket.remoteAddress || '').slice(0, 64);
}

function auditLog(req, actor, action, target = '', details = '') {
  try {
    db.prepare(`
      INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target, ip, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      actor ? actor.id : null,
      actor ? actor.email : '',
      actor ? actor.role : '',
      action,
      String(target || '').slice(0, 120),
      clientIp(req),
      String(details || '').slice(0, 300)
    );
  } catch {}
}

function validatePasswordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Password must be at least 10 characters long';
  if (s.length > 128) return 'Password is too long';
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9!@#$%^&*()_\-+=\[\]{};:'",.<>?/\\|`~]/.test(s)) {
    return 'Password must include uppercase, lowercase, and a number or symbol';
  }
  const weak = ['BovicSuper@2026', 'BovicAdmin@2026', 'BovicWorker@2026', 'Password123!', 'Admin12345!'];
  if (weak.includes(s)) return 'Please choose a unique private password (not a template password)';
  return null;
}

// Simple sliding-window in-memory rate limiter
const rateBuckets = new Map();
const RATE_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
function checkRate(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}
function rateCount(key, windowMs) {
  const now = Date.now();
  return (rateBuckets.get(key) || []).filter(t => now - t < windowMs).length;
}
const LOGIN_PAIR_LIMIT = 5;
const LOGIN_PAIR_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_LOCK_THRESHOLD = 25;

// Prune stale buckets so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of rateBuckets) {
    const fresh = arr.filter(t => now - t < RATE_MAX_WINDOW_MS);
    if (fresh.length) rateBuckets.set(key, fresh);
    else rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

// Dummy hash so unknown-email logins take the same time as real ones (prevents account enumeration)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// ============================================================
// SECURITY HEADERS & STATIC PATH PROTECTION
// ============================================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_HTTPS || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const pageName = req.path.split('/').pop() || '';
  if (DEMO_PAGE_RE.test(pageName) || NOINDEX_PAGES.includes(pageName.toLowerCase())) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  if (req.path.startsWith('/api/') || req.path === '/admin.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  if (req.path === '/admin.html') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
  if (req.path === '/book.html') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://connect.facebook.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com https://googleads.g.doubleclick.net https://www.google.com https://www.facebook.com; connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com https://www.google.com; frame-src https://www.googletagmanager.com https://td.doubleclick.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
  next();
});

// ============================================================
// SETTINGS (PAYMENT LINKS)
// ============================================================
const DEFAULT_SITE = {
  company_name: 'Bovic Premier Cleaning Pros LLC',
  tagline: 'Premier Home & Office Cleaning in North Atlanta',
  phone: '678-799-4634',
  booking_email: 'booking@boviccleaning.com',
  info_email: 'info@boviccleaning.com',
  service_areas: 'Buckhead, Sandy Springs, Roswell & Alpharetta, GA',
  hours: 'Mon - Sat : 8am to 6pm',
  copyright_text: '© 2026 Bovic Premier Cleaning Pros LLC. All Rights Reserved.',
  footer_about: 'Bovic Premier Cleaning Pros LLC provides reliable home, deep, move-in/move-out, Airbnb turnover, and office cleaning across Buckhead, Sandy Springs, Roswell, and Alpharetta, GA.',
  social: { facebook: '', instagram: '', twitter: '', linkedin: '', pinterest: '', tiktok: '', youtube: '', google_business: '' },
  hero: {
    eyebrow: 'Home & Office Cleaning · Buckhead to Alpharetta',
    title_1: 'Spotless Homes.',
    title_highlight: 'Zero Stress.',
    subtitle: 'Bovic Premier Cleaning Pros LLC handles the scrubbing, dusting, and degreasing so you can get your evenings and weekends back.',
    cta_text: 'Book Online Now',
  },
  about: {
    tagline: 'About Us',
    title: 'Focused by Care, Crafted for Perfection',
    text: 'At Bovic Premier Cleaning Pros LLC we believe a clean space is the first step to a clear mind. From tough stains to everyday dust, our trained North Atlanta team combines efficiency, safety, and eco-friendliness so you enjoy a fresh, healthy environment.',
    experience_years: '10',
    active_staff: '25',
  },
  policies: {
    privacy_intro: 'Bovic Premier Cleaning Pros LLC respects your privacy. This Privacy Policy explains what information we collect when you request an estimate, book a cleaning online, or communicate with our North Atlanta team.',
    privacy_collection: 'We collect only the information needed to schedule and deliver your cleaning: your name, phone number, email address, property street address, service area, entry/gate instructions, and booking preferences. Card payments are processed securely by Stripe or PayPal — we never store raw credit card numbers on our servers.',
    privacy_photos: 'Our cleaners may take brief before-and-after photos strictly for quality assurance, before/after verification reports, and documenting pre-existing wear or damage. Photos are stored privately for operational review and are never posted publicly or on social media without your explicit permission.',
    privacy_security: 'Access to client booking details and entry codes is restricted to authorized Bovic Premier administrators and the cleaner assigned to your appointment. You may request an export, correction, or deletion of your contact records anytime by emailing info@boviccleaning.com or calling 678-799-4634.',
    terms_booking: 'All published prices are starting rates for homes in typical condition. If a home requires substantially more time due to heavy buildup, undeclared square footage, post-construction dust, or hoarding conditions, our team will confirm an adjusted estimate with you before beginning work.',
    terms_cancellation: 'You may reschedule or cancel free of charge at least 24 hours before your arrival window. Cancellations under 24 hours or lockouts where cleaners wait 15+ minutes without entry access (missing gate codes, unreturned calls, or locked doors) may incur a $50 late-cancellation / lockout fee.',
    terms_guarantee: 'Your satisfaction is guaranteed. If any area on your room-by-room checklist was missed, notify us within 48 hours of service with a quick note or photo and we will return promptly to re-clean the missed spot at no extra charge. Refunds are not issued once a re-clean option is declined.',
    terms_payment: 'Bookings scheduled online are confirmed via Stripe, PayPal, or approved pay-later agreement. Invoices unpaid 48 hours after completion are subject to late fees and suspension of recurring discounts. Unwarranted payment chargebacks after completed service will be contested with signed/timestamped checklists and verification photos.',
    terms_exclusions: 'For team safety and regulatory compliance, cleaners do NOT handle biohazards (blood, bodily fluids, human/pet waste, litter boxes), mold/asbestos remediation, pest infestations, exterior upper-story windows, moving furniture over 30 lbs, climbing ladders higher than a 2-step stool, or dishwashing/heavy clutter organizing unless explicitly agreed.',
    terms_risks: 'Cleaning Risk & Liability Disclosure: (1) Pre-existing Wear & Fragile Surfaces — we are not liable for pre-existing scratches, unsealed marble/granite etching, loose grout/tiles, brittle blinds, unstable shelves, or worn paint/wallpaper. (2) Valuables & Electronics — please secure cash, jewelry, heirlooms, fragile collectibles, firearms, and delicate electronics before arrival. (3) Pets & Home Access — pets anxious around vacuums or new people must be crated or secured; please share accurate alarm/gate codes. (4) Surface & Chemical Compatibility — notify us of specialty finishes or custom cleaners you prefer us to use. (5) Damage Claims — any accidental breakage must be reported within 48 hours; maximum liability is limited to repair/replacement value up to $1,000 or 2x the cleaning fee (whichever is greater) unless covered by general liability insurance.',
  },
  logo_version: 1,
  plugins: {
    black_november: {
      enabled: true,
      mode: 'auto',
      badge: 'BLACK NOVEMBER SALE',
      title: '20% OFF Deep Clean & Move-In / Move-Out Cleanings',
      subtitle: 'Limited-time November savings across Buckhead, Sandy Springs, Roswell & Alpharetta.',
      promo_code: 'BLACKNOV20',
      discount_percent: 20,
      cta_text: 'Claim 20% Off',
      end_date: '2026-11-30',
      applies_to: ['deep', 'move'],
    },
    christmas_december: {
      enabled: true,
      mode: 'auto',
      badge: 'CHRISTMAS & HOLIDAY SPECIAL',
      title: '15% OFF Holiday & Christmas Guest-Ready Cleaning',
      subtitle: 'Sparkling kitchens, baths & living areas before family and holiday guests arrive.',
      promo_code: 'XMAS15',
      discount_percent: 15,
      cta_text: 'Book Holiday Clean',
      end_date: '2026-12-31',
      applies_to: ['standard', 'deep', 'move', 'airbnb'],
      decorations: true, // twinkling lights, snow & Santa hat on the logo while active
    },
  },
  seo: {
    default_title: 'Bovic Premier Cleaning Pros LLC | Home & Office Cleaning in North Atlanta',
    site_title_suffix: 'Bovic Premier Cleaning Pros LLC',
    meta_description: 'Premier residential, deep cleaning, move-in/move-out, Airbnb turnover, and office cleaning across Buckhead, Sandy Springs, Roswell & Alpharetta, GA.',
    meta_keywords: 'house cleaning Atlanta, Buckhead maid service, Sandy Springs deep cleaning, Roswell move out cleaning, Alpharetta commercial cleaning',
    canonical_base: 'https://boviccleaning.com',
    og_image: 'assets/images/backgrounds/slider-1-1.jpg',
    robots_index: true,
    schema_price_range: '$$',
  },
  marketing: {
    google_ads_id: '',
    google_ads_label: '',
    ga4_id: '',
    gtm_id: '',
    search_console_token: '',
    meta_pixel_id: '',
  },
  // Automatic emails to customers after a job is marked "completed"
  followups: {
    thanks_enabled: true,     // thank-you + Google review request
    thanks_delay_hours: 3,    // hours after the job is marked completed
    review_url: '',           // Google review link; empty = use the Google Business link from Social
    rebook_enabled: true,     // "time for another clean?" for one-time customers who haven't rebooked
    rebook_days: 30,
    rebook_offer: '',         // optional line, e.g. "Use code WELCOMEBACK for 10% off"
  },
};

function getSite() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'site'").get();
  const base = JSON.parse(JSON.stringify(DEFAULT_SITE));
  if (!row) return base;
  try {
    const parsed = JSON.parse(row.value);
    return {
      ...base,
      ...parsed,
      social: { ...base.social, ...(parsed.social || {}) },
      hero: { ...base.hero, ...(parsed.hero || {}) },
      about: { ...base.about, ...(parsed.about || {}) },
      policies: { ...base.policies, ...(parsed.policies || {}) },
      plugins: {
        black_november: { ...base.plugins.black_november, ...((parsed.plugins && parsed.plugins.black_november) || {}) },
        christmas_december: { ...base.plugins.christmas_december, ...((parsed.plugins && parsed.plugins.christmas_december) || {}) },
      },
      seo: (() => {
        const seo = { ...base.seo, ...(parsed.seo || {}) };
        // Old default pointed to an image that doesn't exist
        if (seo.og_image === 'assets/images/backgrounds/main-slider-1-1.jpg') seo.og_image = base.seo.og_image;
        return seo;
      })(),
      marketing: { ...base.marketing, ...(parsed.marketing || {}) },
      followups: { ...base.followups, ...(parsed.followups || {}) },
    };
  } catch {
    return base;
  }
}

function isPluginActiveForMonth(cfg, targetMonth1Based, now = new Date()) {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.mode === 'off') return false;
  // An end date always wins: the promo stops after that day (business time zone)
  const end = String(cfg.end_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && businessToday(now.getTime()) > end) return false;
  if (cfg.mode === 'on') return true;
  return businessMonth(now.getTime()) === targetMonth1Based;
}

function promoAppliesToService(cfg, serviceKey) {
  const list = Array.isArray(cfg && cfg.applies_to) ? cfg.applies_to : [];
  return list.length === 0 || list.includes(serviceKey);
}

function serviceLabelsFor(keys) {
  const svcs = catalog.SERVICES;
  return (keys || []).map(k => (svcs[k] ? svcs[k].label : k)).join(', ');
}

function resolveActivePromo(site = getSite(), now = new Date()) {
  const plg = (site && site.plugins) || {};
  const dec = plg.christmas_december;
  const nov = plg.black_november;
  const decorate = (key, theme, cfg) => ({
    key, theme, ...cfg,
    applies_to_labels: serviceLabelsFor(cfg.applies_to),
  });
  // Explicit force-on wins over auto-month so Admin can preview December anytime (end dates still apply)
  const decForced = dec && dec.mode === 'on' && isPluginActiveForMonth(dec, 12, now);
  const novForced = nov && nov.mode === 'on' && isPluginActiveForMonth(nov, 11, now);
  if (decForced) return decorate('christmas_december', 'christmas', dec);
  if (novForced) return decorate('black_november', 'black_november', nov);
  if (isPluginActiveForMonth(dec, 12, now)) return decorate('christmas_december', 'christmas', dec);
  if (isPluginActiveForMonth(nov, 11, now)) return decorate('black_november', 'black_november', nov);
  return null;
}

// Returns a promo object, { error } when the code exists but doesn't apply, or null when unknown/inactive.
function validatePromoCode(codeInput, baseCents, serviceKey, site = getSite(), now = new Date()) {
  const code = String(codeInput || '').trim().toUpperCase();
  if (!code || baseCents == null || baseCents <= 0) return null;
  const plg = (site && site.plugins) || {};
  const candidates = [
    { key: 'black_november', month: 11, cfg: plg.black_november },
    { key: 'christmas_december', month: 12, cfg: plg.christmas_december },
  ];
  for (const item of candidates) {
    if (!isPluginActiveForMonth(item.cfg, item.month, now)) continue;
    const cfgCode = String(item.cfg.promo_code || '').trim().toUpperCase();
    const pct = Math.max(0, Math.min(50, Number(item.cfg.discount_percent || 0)));
    if (cfgCode && cfgCode === code && pct > 0) {
      if (!promoAppliesToService(item.cfg, serviceKey)) {
        return { error: `${cfgCode} applies only to: ${serviceLabelsFor(item.cfg.applies_to)}.` };
      }
      let discountCents = Math.round(baseCents * (pct / 100));
      const minFloor = baseCents >= 5000 ? 5000 : baseCents;
      const finalCents = Math.max(minFloor, baseCents - discountCents);
      discountCents = Math.max(0, baseCents - finalCents);
      return {
        plugin_key: item.key,
        promo_code: cfgCode,
        discount_percent: pct,
        discount_cents: discountCents,
        final_cents: finalCents,
        label: item.cfg.badge || cfgCode,
      };
    }
  }
  return null;
}

const DEFAULT_PAYMENTS = {
  stripe_checkout_enabled: true,
  stripe_links_enabled: false,
  stripe_default_link: '',
  stripe_item_links: {},
  paypal_enabled: false,
  paypal_link: '',
  paypal_item_links: {},
  pay_later_enabled: false,
  pay_later_label: 'Pay after cleaning (cash, Zelle, or card on site)',
};

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return { ...fallback, ...JSON.parse(row.value) }; } catch { return fallback; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
const getPayments = () => getSetting('payments', DEFAULT_PAYMENTS);

function validLink(url, kind) {
  if (!url) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (kind === 'stripe') return host === 'stripe.com' || host.endsWith('.stripe.com');
    if (kind === 'paypal') return host === 'paypal.me' || host.endsWith('.paypal.me') || host === 'paypal.com' || host.endsWith('.paypal.com');
    return false;
  } catch { return false; }
}

function isPaypalMe(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname.replace('www.', '') === 'paypal.me') return parts.length === 1;
    if (u.hostname.endsWith('paypal.com') && parts[0] && parts[0].toLowerCase() === 'paypalme') return parts.length === 2;
    return false;
  } catch { return false; }
}

function stripeLinkFor(booking, p = getPayments()) {
  if (!p.stripe_links_enabled) return null;
  const key = catalog.itemKey(booking.service_key, booking.frequency_key, booking.size_key);
  const base = p.stripe_item_links[key] || p.stripe_default_link;
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set('client_reference_id', booking.booking_code);
  u.searchParams.set('prefilled_email', booking.customer_email);
  return u.toString();
}

function paypalLinkFor(booking, p = getPayments()) {
  if (!p.paypal_enabled) return null;
  const key = catalog.itemKey(booking.service_key, booking.frequency_key, booking.size_key);
  // Fixed-price item links can't carry a promo discount — only a PayPal.me link with the exact amount can
  if (Number(booking.discount_cents || 0) > 0) {
    return isPaypalMe(p.paypal_link) && booking.price_cents
      ? p.paypal_link.replace(/\/+$/, '') + '/' + (booking.price_cents / 100).toFixed(2) + 'USD'
      : null;
  }
  if (p.paypal_item_links[key]) return p.paypal_item_links[key];
  if (!p.paypal_link) return null;
  if (isPaypalMe(p.paypal_link) && booking.price_cents) {
    return p.paypal_link.replace(/\/+$/, '') + '/' + (booking.price_cents / 100).toFixed(2) + 'USD';
  }
  return p.paypal_link;
}

function availableMethods(p = getPayments()) {
  const methods = [];
  if (stripeApiConfigured && p.stripe_checkout_enabled) {
    methods.push({ key: 'stripe', label: 'Card (Stripe Checkout)', desc: 'Pay securely by card, Apple Pay or Google Pay', icon: 'fab fa-cc-stripe' });
  }
  if (p.stripe_links_enabled && (p.stripe_default_link || Object.keys(p.stripe_item_links).length)) {
    methods.push({ key: 'stripe_link', label: 'Card (Stripe Payment Link)', desc: 'Secure Stripe payment page', icon: 'fab fa-stripe', items: Object.keys(p.stripe_item_links), hasDefault: Boolean(p.stripe_default_link) });
  }
  if (p.paypal_enabled && (p.paypal_link || Object.keys(p.paypal_item_links).length)) {
    methods.push({ key: 'paypal', label: 'PayPal', desc: 'Pay with your PayPal account or card', icon: 'fab fa-paypal', items: Object.keys(p.paypal_item_links), hasDefault: Boolean(p.paypal_link) });
  }
  if (p.pay_later_enabled) {
    methods.push({ key: 'later', label: 'Pay later', desc: p.pay_later_label, icon: 'fas fa-hand-holding-usd' });
  }
  // Demo checkout only on a local dev server (or ALLOW_DEMO_CHECKOUT=true) — never on the live site
  const demo = methods.length === 0 && DEMO_CHECKOUT_ALLOWED;
  if (demo) methods.push({ key: 'demo', label: 'Demo checkout', desc: 'Test mode — add Stripe or PayPal in Admin → Payments', icon: 'fas fa-flask' });
  return { methods, demo };
}

const METHOD_LABELS = { stripe: 'Stripe', stripe_link: 'Stripe', paypal: 'PayPal', later: 'Pay later', demo: 'Demo', cash: 'Cash', zelle: 'Zelle', other: 'Other' };

// ============================================================
// BOOKING HELPERS
// ============================================================
function getBooking(id) {
  return db.prepare(`
    SELECT b.*, u.name AS worker_name, u.email AS worker_email, u.phone AS worker_phone
    FROM bookings b LEFT JOIN users u ON b.assigned_worker_id = u.id
    WHERE b.id = ?`).get(id);
}

async function markPaid(booking, method, reference) {
  if (!booking || booking.payment_status === 'paid') return booking;
  db.prepare(`
    UPDATE bookings
    SET payment_status = 'paid', payment_method = ?, payment_reference = ?, paid_at = datetime('now'),
        booking_status = CASE WHEN booking_status = 'pending' THEN 'confirmed' ELSE booking_status END
    WHERE id = ?`).run(method || booking.payment_method || '', reference || '', booking.id);
  const updated = getBooking(booking.id);
  if (updated.booking_status === 'cancelled') {
    postMessage({
      threadType: 'booking', bookingId: updated.id, sender: null,
      body: `Payment received for this booking, but it is marked cancelled (its slot may have been released). Please review and contact the customer.`,
    });
  }
  await mailer.sendBookingConfirmation(updated);
  return updated;
}

// Checks that a Stripe Checkout Session actually charged this booking's full price in USD.
function stripeAmountMatches(booking, session) {
  return Number(session.amount_total) === Number(booking.price_cents)
    && String(session.currency || '').toLowerCase() === 'usd';
}

async function flagPaymentMismatch(booking, session) {
  const paid = (Number(session.amount_total || 0) / 100).toFixed(2);
  const expected = (Number(booking.price_cents || 0) / 100).toFixed(2);
  const ref = session.payment_intent || session.id;
  const already = db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment_amount_mismatch' AND details LIKE ?").get(`%${ref}%`);
  if (already) return;
  const note = `Stripe payment of $${paid} ${String(session.currency || '').toUpperCase()} received, but this booking costs $${expected}. NOT auto-marked paid — check Stripe (ref ${ref}) and mark paid or refund manually.`;
  postMessage({ threadType: 'booking', bookingId: booking.id, sender: null, body: note });
  try {
    db.prepare(`INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, target, ip, details) VALUES (NULL, '', 'system', 'payment_amount_mismatch', ?, '', ?)`)
      .run(String(booking.booking_code), note.slice(0, 300));
  } catch {}
  await mailer.sendStaffNotification({
    to: process.env.ADMIN_ALERT_EMAIL || 'booking@boviccleaning.com',
    bookingId: booking.id,
    subject: `⚠ Payment amount mismatch on ${booking.booking_code}`,
    title: `Payment needs review — ${booking.booking_code}`,
    text: note,
  });
}

// A slot stays reserved while its booking is active. Unpaid online-payment bookings release their slot:
// Stripe Checkout / demo after 60 minutes, emailed Stripe/PayPal links after 24 hours.
const ACTIVE_BOOKING_SQL = `booking_status != 'cancelled' AND NOT (
  payment_status = 'pending' AND (
    (payment_method IN ('stripe', 'demo') AND created_at < datetime('now', '-60 minutes')) OR
    (payment_method IN ('stripe_link', 'paypal') AND quote_required = 0 AND created_at < datetime('now', '-24 hours'))
  ))`;

function postMessage({ threadType, bookingId = null, recipientId = null, audience = 'team', sender, body, emailStatus = '' }) {
  const info = db.prepare(`
    INSERT INTO messages (thread_type, booking_id, recipient_id, audience, sender_id, sender_name, sender_role, body, email_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    threadType, bookingId, recipientId, audience,
    sender ? sender.id : null, sender ? sender.name : 'System', sender ? sender.role : 'system',
    body, emailStatus
  );
  return info.lastInsertRowid;
}

// --- Stripe webhook (raw body, before express.json) ---
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET.includes('your_webhook')) {
    return res.json({ received: true, mode: 'not_configured' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      if (s.payment_status === 'paid') {
        // Prefer the server-created session id; fall back to the booking code (Payment Links)
        let booking = db.prepare('SELECT * FROM bookings WHERE stripe_session_id = ?').get(s.id);
        const code = s.client_reference_id || (s.metadata && s.metadata.booking_code);
        if (!booking && code) booking = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
        if (booking && booking.payment_status !== 'paid') {
          // Never trust the booking code alone: the amount charged must equal the booking price
          if (stripeAmountMatches(booking, s)) {
            await markPaid(booking, s.payment_link ? 'stripe_link' : 'stripe', s.payment_intent || s.id);
          } else {
            await flagPaymentMismatch(booking, s);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Stripe Webhook]', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  res.json({ received: true });
});

app.use('/api/admin/site/logo', express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  if (req.path === '/api/admin/site/logo') return next();
  return express.json({ limit: '200kb' })(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// Theme demo / non-functional template pages that must never be indexed by search engines.
// Keep in sync with DEMO_PAGE_RE in assets/js/bovic-cms.js
const DEMO_PAGE_RE = /^(index\d.*|index-.*|.*one-page.*|profile-.*|my-profile.*|cart|checkout|wishlist|products?|product-details|coming-soon|login|sign-up|nullphpscript\.com)\.html$/i;
const NOINDEX_PAGES = ['admin.html', '404.html'];
// Theme pages with placeholder people (stock team members, sample reviews). They're hidden
// until real content exists: left out of the sitemap and sent to the About page.
// To bring one back, put real content in it and remove it from this list.
const HIDDEN_PAGES = ['team.html', 'team-details.html', 'testimonials.html'];

// Dynamic SEO robots.txt & sitemap.xml (before static file blocker)
app.get('/robots.txt', (req, res) => {
  const s = getSite();
  const baseUrl = (s.seo && s.seo.canonical_base ? s.seo.canonical_base : BASE_URL).replace(/\/+$/, '');
  const allowIndex = !s.seo || s.seo.robots_index !== false;
  let demoPages = [];
  try {
    demoPages = fs.readdirSync(path.resolve(__dirname, '..')).filter(f => DEMO_PAGE_RE.test(f)).sort();
  } catch {}
  const lines = allowIndex
    ? ['User-agent: *', 'Allow: /', 'Disallow: /admin.html', 'Disallow: /backend/', 'Disallow: /api/',
      ...demoPages.map(f => `Disallow: /${f}`), `Sitemap: ${baseUrl}/sitemap.xml`]
    : ['User-agent: *', 'Disallow: /'];
  res.type('text/plain').send(lines.join('\n') + '\n');
});

app.get('/sitemap.xml', (req, res) => {
  const s = getSite();
  const baseUrl = (s.seo && s.seo.canonical_base ? s.seo.canonical_base : BASE_URL).replace(/\/+$/, '');
  const rootDir = path.resolve(__dirname, '..');
  const exclude = new Set([...NOINDEX_PAGES, ...HIDDEN_PAGES]);
  const priorityMap = {
    'index.html': '1.0',
    'book.html': '0.95',
    'services.html': '0.9',
    'pricing.html': '0.9',
    'house-cleaning.html': '0.85',
    'commercial-cleaning.html': '0.85',
    'residential-cleaning.html': '0.85',
    'about.html': '0.8',
    'contact.html': '0.8',
    'privacy.html': '0.4',
    'terms.html': '0.4',
  };
  let files = [];
  try {
    files = fs.readdirSync(rootDir)
      .filter(f => f.toLowerCase().endsWith('.html') && !exclude.has(f.toLowerCase()) && !DEMO_PAGE_RE.test(f))
      .sort();
  } catch { files = ['index.html', 'book.html', 'services.html', 'pricing.html', 'about.html', 'contact.html', 'terms.html', 'privacy.html']; }

  const today = businessToday();
  const escXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const urls = files.map(f => {
    const loc = f === 'index.html' ? `${baseUrl}/` : `${baseUrl}/${f}`;
    const prio = priorityMap[f.toLowerCase()] || '0.7';
    return `  <url><loc>${escXml(loc)}</loc><lastmod>${today}</lastmod><priority>${prio}</priority></url>`;
  }).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

// Block sensitive directories, dotfiles, PHP scripts, DB files before static serving
app.use((req, res, next) => {
  let p;
  try {
    p = decodeURIComponent(req.path || '/').toLowerCase();
  } catch {
    return res.status(400).end(); // malformed percent-encoding
  }
  if (
    p.split('/').some(seg => seg.startsWith('.') && seg.length > 1) ||
    p.startsWith('/backend') ||
    p.startsWith('/assets/inc') ||
    p.startsWith('/node_modules') ||
    p === '/nullphpscript.com.html' ||
    /\.(php|db|sqlite|sqlite3|wal|shm|log|py|sh|md|env|ini|sql|txt)$/.test(p)
  ) {
    return res.status(404).end();
  }
  next();
});

// Placeholder-content pages → About (302, so they can be re-enabled later without browsers caching the redirect)
app.get(HIDDEN_PAGES.map(p => '/' + p), (req, res) => res.redirect(302, '/about.html'));

// Service worker for the installable app: browsers must always re-check it so updates roll out
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.resolve(__dirname, '..', 'sw.js'));
});

// Google Search Console "HTML tag" verification: the check reads the raw homepage HTML
// (it doesn't wait for bovic-cms.js), so put the saved token into the <head> on the server.
const HOME_HTML_PATH = path.resolve(__dirname, '..', 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  const s = getSite();
  const token = (s.marketing && s.marketing.search_console_token) || '';
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(token)) return next(); // nothing saved: serve the file as usual
  fs.readFile(HOME_HTML_PATH, 'utf8', (err, html) => {
    if (err) return next();
    const tag = `<meta name="google-site-verification" content="${token}" />`;
    const out = html.replace(/<head([^>]*)>/i, m => `${m}\n    ${tag}`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(out);
  });
});

app.use(express.static(path.resolve(__dirname, '..')));

// ============================================================
// AUTHENTICATION MIDDLEWARE (HttpOnly Cookie + CSRF + Token Revocation)
// ============================================================
function verifyCsrfAndOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;

  // Origin check (when present)
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch { return false; }
  }

  const cookies = parseCookies(req);
  const cookieCsrf = String(cookies[CSRF_COOKIE] || '');
  const headerCsrf = String(req.headers['x-csrf-token'] || '');
  if (!cookieCsrf || !headerCsrf || cookieCsrf.length !== headerCsrf.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cookieCsrf), Buffer.from(headerCsrf));
  } catch {
    return false;
  }
}

function authRequired(roles = [], options = {}) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    if (!verifyCsrfAndOrigin(req)) {
      return res.status(403).json({ error: 'Security check failed (CSRF). Please refresh the page.' });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare(`
        SELECT id, name, email, role, phone, service_areas, active, token_version, must_change_password
        FROM users WHERE id = ?
      `).get(payload.id);

      if (!user || !user.active || payload.tv !== user.token_version) {
        return res.status(401).json({ error: 'Session expired or revoked — please sign in again' });
      }
      if (!options.allowPasswordChangeOnly && user.must_change_password) {
        return res.status(403).json({
          error: 'You must update your temporary password before accessing the dashboard',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
      }
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Session expired — please sign in again' });
    }
  };
}

app.post('/api/auth/login', (req, res) => {
  const ip = clientIp(req);
  if (!checkRate(`login_ip:${ip}`, 15, 15 * 60 * 1000)) {
    auditLog(req, null, 'login_rate_limited', ip, 'Too many login attempts from IP');
    return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes and try again.' });
  }

  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(cleanEmail);

  // Per (account + IP) limit: 5 wrong passwords from one IP blocks only that IP for this account,
  // so an attacker can't lock the real owner out from their own device.
  const pairKey = `login_fail:${cleanEmail}:${ip}`;
  if (rateCount(pairKey, LOGIN_PAIR_WINDOW_MS) >= LOGIN_PAIR_LIMIT) {
    auditLog(req, user || null, 'login_rate_limited', cleanEmail, 'Too many failures for this account from IP');
    return res.status(429).json({ error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  }

  // Account-wide lockout only after many failures (distributed attack), and only briefly
  if (user && user.locked_until && Date.parse(user.locked_until + 'Z') > Date.now()) {
    auditLog(req, user, 'login_locked', cleanEmail, 'Attempt while account locked');
    return res.status(429).json({ error: 'Account temporarily locked due to failed attempts. Try again in 15 minutes.' });
  }

  // Always run bcrypt (dummy hash for unknown emails) so response time doesn't reveal which emails exist
  const passwordOk = bcrypt.compareSync(String(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    checkRate(pairKey, Number.MAX_SAFE_INTEGER, LOGIN_PAIR_WINDOW_MS); // record failure
    if (user) {
      const fails = Number(user.failed_attempts || 0) + 1;
      const locking = fails >= ACCOUNT_LOCK_THRESHOLD;
      const lockUntil = locking ? new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') : '';
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(locking ? 0 : fails, lockUntil, user.id);
      auditLog(req, user, locking ? 'account_locked' : 'login_failed', cleanEmail, `Failed attempts: ${fails}`);
    } else {
      auditLog(req, null, 'login_failed', cleanEmail, 'Unknown email');
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  rateBuckets.delete(pairKey);

  if (!user.active) {
    auditLog(req, user, 'login_disabled_attempt', cleanEmail);
    return res.status(403).json({ error: 'This account has been deactivated.' });
  }

  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = '' WHERE id = ?").run(user.id);

  const token = jwt.sign({ id: user.id, role: user.role, tv: user.token_version }, JWT_SECRET, { expiresIn: '8h' });
  const csrfToken = crypto.randomBytes(24).toString('hex');
  setSessionCookies(res, req, token, csrfToken);
  auditLog(req, user, 'login_success', cleanEmail);

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      service_areas: user.service_areas,
      must_change_password: Boolean(user.must_change_password),
    },
  });
});

app.get('/api/auth/me', authRequired([], { allowPasswordChangeOnly: true }), (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      phone: req.user.phone,
      service_areas: req.user.service_areas,
      must_change_password: Boolean(req.user.must_change_password),
    },
  });
});

app.post('/api/auth/logout', authRequired([], { allowPasswordChangeOnly: true }), (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
  clearSessionCookies(res, req);
  auditLog(req, req.user, 'logout', req.user.email);
  res.json({ success: true });
});

app.post('/api/auth/logout-all', authRequired(['super_admin']), (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1').run();
  clearSessionCookies(res, req);
  auditLog(req, req.user, 'logout_all_devices', 'all_users');
  res.json({ success: true });
});

app.patch('/api/auth/password', authRequired([], { allowPasswordChangeOnly: true }), (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current_password || ''), user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const pwErr = validatePasswordStrength(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (bcrypt.compareSync(String(new_password), user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different from your current password' });
  }

  const nextTv = Number(user.token_version || 1) + 1;
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(new_password), 12), nextTv, user.id);

  // Re-issue fresh session cookie for this device with updated token_version
  const token = jwt.sign({ id: user.id, role: user.role, tv: nextTv }, JWT_SECRET, { expiresIn: '8h' });
  const csrfToken = crypto.randomBytes(24).toString('hex');
  setSessionCookies(res, req, token, csrfToken);
  auditLog(req, req.user, 'password_changed', user.email);

  res.json({ success: true });
});

// ============================================================
// PUBLIC: CATALOG, AVAILABILITY, CHECKOUT
// ============================================================
app.get('/api/public/config', (req, res) => {
  const { methods, demo } = availableMethods();
  const site = getSite();
  res.json({
    catalog: catalog.publicCatalog(),
    timeSlots: TIME_SLOTS,
    maxPerSlot: MAX_BOOKINGS_PER_SLOT,
    paymentMethods: methods,
    demoMode: demo,
    activePromo: resolveActivePromo(site),
    today: businessToday(),
    timeZone: BUSINESS_TZ,
  });
});

app.get('/api/public/site', (req, res) => {
  const site = getSite();
  res.json({ site, catalog: catalog.publicCatalog(), activePromo: resolveActivePromo(site) });
});

app.post('/api/bookings/promo-check', (req, res) => {
  if (!checkRate(`promo:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many promo checks. Try again shortly.' });
  }
  const b = req.body || {};
  const svc = catalog.SERVICES[b.service_key];
  if (!svc) return res.status(400).json({ error: 'Invalid service' });
  const freqKey = svc.prices[b.frequency_key] ? b.frequency_key : Object.keys(svc.prices)[0];
  const sizeKey = svc.sizes[b.size_key] ? b.size_key : 'family';
  const basePrice = catalog.priceFor(b.service_key, freqKey, sizeKey);
  if (basePrice == null) return res.status(400).json({ error: 'Promos apply to priced packages (custom quotes are priced during consultation).' });
  const promo = validatePromoCode(b.promo_code, basePrice, b.service_key, getSite());
  if (!promo) return res.status(404).json({ valid: false, error: 'Promo code is invalid or inactive right now.' });
  if (promo.error) return res.status(422).json({ valid: false, error: promo.error });
  res.json({ valid: true, ...promo, base_cents: basePrice });
});

// Slots that have already started (or start within the booking lead time) for a given business date
const BOOKING_LEAD_MINUTES = Number(process.env.BOOKING_LEAD_MINUTES || 60);
function closedSlotsFor(dateStr, now = Date.now()) {
  return TIME_SLOTS.filter(s => apptTime(dateStr, s) <= now + BOOKING_LEAD_MINUTES * 60000);
}

app.get('/api/availability', (req, res) => {
  const today = businessToday();
  const month = String(req.query.month || today.slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month (YYYY-MM)' });
  const blocked = db.prepare('SELECT date, reason FROM blocked_dates WHERE date LIKE ?').all(`${month}-%`);
  const counts = db.prepare(`
    SELECT cleaning_date, time_slot, COUNT(*) AS cnt FROM bookings
    WHERE cleaning_date LIKE ? AND ${ACTIVE_BOOKING_SQL}
    GROUP BY cleaning_date, time_slot`).all(`${month}-%`);
  const bookedSlots = {};
  for (const r of counts) {
    (bookedSlots[r.cleaning_date] = bookedSlots[r.cleaning_date] || {})[r.time_slot] = r.cnt;
  }
  const closedSlots = {};
  if (today.startsWith(month)) closedSlots[today] = closedSlotsFor(today);
  res.json({ month, today, timeSlots: TIME_SLOTS, maxPerSlot: MAX_BOOKINGS_PER_SLOT, blockedDates: blocked, bookedSlots, closedSlots });
});

const MAX_OPEN_BOOKINGS_PER_EMAIL = 3;

app.post('/api/bookings/checkout', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRate(`checkout:${ip}`, 10, 10 * 60 * 1000) || !checkRate(`checkout_day:${ip}`, 30, 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many booking attempts. Please wait a while or call 678-799-4634.' });
  }
  try {
    const b = req.body || {};
    const name = String(b.customer_name || '').trim().slice(0, 120);
    const email = String(b.customer_email || '').trim().slice(0, 160);
    const phone = String(b.customer_phone || '').trim().slice(0, 40);
    const address = String(b.address || '').trim().slice(0, 300);
    const date = String(b.cleaning_date || '');
    const slot = String(b.time_slot || '');

    if (!name || !email || !phone || !address) return res.status(400).json({ error: 'Please complete your name, email, phone and address.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !TIME_SLOTS.includes(slot)) return res.status(400).json({ error: 'Please pick a date and time slot on the calendar.' });
    if (date < businessToday()) return res.status(400).json({ error: 'That date has already passed.' });
    if (closedSlotsFor(date).includes(slot)) return res.status(400).json({ error: 'That arrival window has already passed or is too soon — please pick a later time.' });

    const svc = catalog.SERVICES[b.service_key];
    if (!svc) return res.status(400).json({ error: 'Please choose a service.' });
    const freqKey = svc.prices[b.frequency_key] ? b.frequency_key : Object.keys(svc.prices)[0];
    const sizeKey = svc.sizes[b.size_key] ? b.size_key : 'family';
    const basePrice = catalog.priceFor(b.service_key, freqKey, sizeKey);
    const isQuote = basePrice == null;
    const labels = catalog.labelsFor(b.service_key, freqKey, sizeKey);

    let promo = null;
    if (!isQuote && String(b.promo_code || '').trim()) {
      promo = validatePromoCode(b.promo_code, basePrice, b.service_key, getSite());
      if (!promo) return res.status(400).json({ error: 'That promo code is no longer active. Remove it to continue at the regular price.' });
      if (promo.error) return res.status(400).json({ error: promo.error });
    }
    const finalPrice = isQuote ? 0 : (promo ? promo.final_cents : basePrice);
    const discountCents = isQuote ? 0 : (promo ? promo.discount_cents : 0);

    const blocked = db.prepare('SELECT reason FROM blocked_dates WHERE date = ?').get(date);
    if (blocked) return res.status(409).json({ error: `That date is unavailable (${blocked.reason}). Please choose another day.` });
    const taken = db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE cleaning_date = ? AND time_slot = ? AND ${ACTIVE_BOOKING_SQL}`).get(date, slot).c;
    if (taken >= MAX_BOOKINGS_PER_SLOT) return res.status(409).json({ error: 'That time slot just filled up — please pick another.' });

    // Anti-abuse: cap how many open upcoming bookings one email can hold
    const openForEmail = db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE LOWER(customer_email) = LOWER(?)
      AND cleaning_date >= ? AND booking_status NOT IN ('cancelled','completed') AND ${ACTIVE_BOOKING_SQL}`).get(email, businessToday()).c;
    if (openForEmail >= MAX_OPEN_BOOKINGS_PER_EMAIL) {
      return res.status(429).json({ error: 'You already have several upcoming bookings with us. Please call 678-799-4634 to add more.' });
    }

    const { methods } = availableMethods();
    let method = isQuote ? 'quote' : String(b.payment_method || '');
    if (!isQuote && !methods.some(m => m.key === method)) {
      if (!methods.length) {
        return res.status(503).json({ error: 'Online payment is temporarily unavailable. Please call 678-799-4634 to book.' });
      }
      method = methods[0].key;
    }
    // Stripe Payment Links have a fixed price, so a discounted booking can't be paid through them
    if (method === 'stripe_link' && promo) {
      return res.status(400).json({ error: 'Promo codes can’t be used with Stripe payment links. Choose another payment method or remove the code.' });
    }

    const noteRaw = String(b.notes || '').trim();
    const fullNote = (promo ? `[Promo ${promo.promo_code} -${promo.discount_percent}%] ` : '') + noteRaw;
    const code = 'BOV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const info = db.prepare(`
      INSERT INTO bookings (booking_code, customer_name, customer_email, customer_phone, address, service_area,
        service_type, home_size, frequency, cleaning_date, time_slot, price_cents, notes,
        service_key, size_key, frequency_key, quote_required, payment_method, payment_status, booking_status,
        promo_code, discount_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
      code, name, email, phone, address, String(b.service_area || 'Buckhead').slice(0, 80),
      labels.service, labels.size, labels.freq, date, slot, finalPrice, fullNote.slice(0, 1000),
      b.service_key, sizeKey, freqKey, isQuote ? 1 : 0, method === 'quote' ? '' : method,
      method === 'later' ? 'confirmed' : 'pending',
      promo ? promo.promo_code : '', discountCents
    );
    const booking = getBooking(info.lastInsertRowid);
    const cancelBooking = () => db.prepare("UPDATE bookings SET booking_status = 'cancelled' WHERE id = ?").run(booking.id);

    if (isQuote) {
      await mailer.sendQuoteReceived(booking);
      return res.json({ mode: 'quote', bookingCode: code });
    }

    if (method === 'stripe') {
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: email,
          client_reference_id: code,
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${labels.service} — ${labels.size}`,
                description: `${labels.freq} · ${date} at ${slot}${promo ? ` · Promo ${promo.promo_code} (-${promo.discount_percent}%)` : ''}`,
              },
              unit_amount: finalPrice,
            },
            quantity: 1,
          }],
          metadata: { booking_code: code, promo_code: promo ? promo.promo_code : '' },
          success_url: `${BASE_URL}/book.html?status=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/book.html?status=cancelled&code=${code}`,
        });
      } catch (err) {
        cancelBooking(); // release the slot if Stripe is unreachable
        throw err;
      }
      db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(session.id, booking.id);
      return res.json({ mode: 'redirect', checkoutUrl: session.url, bookingCode: code });
    }

    if (method === 'stripe_link' || method === 'paypal') {
      const payUrl = method === 'paypal' ? paypalLinkFor(booking) : stripeLinkFor(booking);
      if (!payUrl) {
        cancelBooking();
        return res.status(400).json({
          error: promo
            ? `Promo codes can’t be paid through this ${METHOD_LABELS[method]} link. Choose another payment method or remove the code.`
            : `${METHOD_LABELS[method]} isn't set up for this service yet. Please choose another payment method.`,
        });
      }
      await mailer.sendBookingReceived(booking, payUrl, METHOD_LABELS[method]);
      return res.json({ mode: 'external', payUrl, method, bookingCode: code, amount: (finalPrice / 100).toFixed(2) });
    }

    if (method === 'later') {
      await mailer.sendBookingReceived(booking, null, getPayments().pay_later_label);
      return res.json({ mode: 'later', bookingCode: code, amount: (finalPrice / 100).toFixed(2) });
    }

    if (method !== 'demo' || !DEMO_CHECKOUT_ALLOWED) {
      cancelBooking();
      return res.status(503).json({ error: 'Online payment is temporarily unavailable. Please call 678-799-4634 to book.' });
    }
    const demoSession = 'demo_cs_' + crypto.randomBytes(8).toString('hex');
    db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(demoSession, booking.id);
    return res.json({ mode: 'demo', checkoutUrl: `${BASE_URL}/book.html?status=demo_pay&session_id=${demoSession}&amount=${(finalPrice / 100).toFixed(2)}`, bookingCode: code });
  } catch (err) {
    console.error('[Checkout Error]', err);
    res.status(500).json({ error: 'We could not start your checkout. Please try again or call 678-799-4634.' });
  }
});

app.post('/api/bookings/confirm-session', async (req, res) => {
  if (!checkRate(`confirm:${clientIp(req)}`, 30, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  try {
    const sid = String((req.body || {}).session_id || '');
    if (!sid) return res.status(400).json({ error: 'Missing session_id' });
    const booking = db.prepare('SELECT * FROM bookings WHERE stripe_session_id = ?').get(sid);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (sid.startsWith('demo_cs_')) {
      if (!DEMO_CHECKOUT_ALLOWED || !availableMethods().demo) return res.status(403).json({ error: 'Demo checkout is disabled' });
      const paid = await markPaid(booking, 'demo', sid);
      return res.json({ booking: publicBookingSummary(paid) });
    }
    if (!stripe) return res.status(400).json({ error: 'Card payments are not configured' });
    if (booking.payment_status === 'paid') return res.json({ booking: publicBookingSummary(booking) });
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment has not completed yet' });
    if (!stripeAmountMatches(booking, session)) {
      await flagPaymentMismatch(booking, session);
      return res.status(409).json({ error: 'We received your payment but need to verify the amount. Our team will contact you shortly.' });
    }
    const paid = await markPaid(booking, 'stripe', session.payment_intent || sid);
    res.json({ booking: publicBookingSummary(paid) });
  } catch (err) {
    console.error('[Confirm Session Error]', err);
    res.status(500).json({ error: 'We could not verify your payment yet. If you were charged, your booking will be confirmed by email shortly.' });
  }
});

function publicBookingSummary(b) {
  return {
    booking_code: b.booking_code,
    customer_email: b.customer_email,
    service_type: b.service_type,
    home_size: b.home_size,
    frequency: b.frequency,
    cleaning_date: b.cleaning_date,
    time_slot: b.time_slot,
    address: b.address,
    service_area: b.service_area,
    price_cents: b.price_cents,
    payment_status: b.payment_status,
    booking_status: b.booking_status,
  };
}

// Public Contact & Newsletter Form Handler (replaces legacy sendemail.php)
app.post('/api/contact', async (req, res) => {
  if (!checkRate(`contact:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
    return res.status(429).send('Too many requests. Please wait a few minutes or call 678-799-4634.');
  }
  const f = req.body || {};
  const email = String(f.email || '').trim();
  const name = String(f.name || '').trim();
  const phone = String(f.phone || f.Phone || '').trim();
  const service = String(f.service || '').trim();
  const message = String(f.message || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send('Please provide a valid email address.');
  }

  const isNewsletter = !name && !message && !phone;
  const subject = isNewsletter
    ? `New Newsletter Subscriber: ${email}`
    : `Website Inquiry from ${name || email}`;

  const html = `
    <p><strong>Type:</strong> ${isNewsletter ? 'Newsletter Subscription' : 'Contact / Estimate Inquiry'}</p>
    ${name ? `<p><strong>Name:</strong> ${mailer.esc(name)}</p>` : ''}
    <p><strong>Email:</strong> ${mailer.esc(email)}</p>
    ${phone ? `<p><strong>Phone:</strong> ${mailer.esc(phone)}</p>` : ''}
    ${service ? `<p><strong>Service:</strong> ${mailer.esc(service)}</p>` : ''}
    ${message ? `<p><strong>Message:</strong><br>${mailer.esc(message).replace(/\n/g, '<br>')}</p>` : ''}
  `;

  await mailer.sendEmail({
    to: process.env.ADMIN_ALERT_EMAIL || 'booking@boviccleaning.com',
    emailType: isNewsletter ? 'newsletter' : 'contact_inquiry',
    subject,
    html,
    textPreview: `${subject} (${email})`,
  });

  res.send(isNewsletter
    ? 'Thank you for subscribing to Bovic Premier Cleaning Pros LLC updates!'
    : 'Thank you! We received your message and will get back to you shortly.');
});

// ============================================================
// DASHBOARD: STATS & BOOKINGS
// ============================================================
function unreadCountFor(user) {
  return threadsFor(user).reduce((sum, t) => sum + t.unread, 0);
}

app.get('/api/admin/stats', authRequired(), (req, res) => {
  const today = businessToday();
  const unreadMessages = unreadCountFor(req.user);
  if (req.user.role === 'worker') {
    const q = sql => db.prepare(sql).get(req.user.id).c;
    return res.json({
      myJobs: q('SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ?'),
      todayJobs: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ? AND cleaning_date = ? AND booking_status != 'cancelled'").get(req.user.id, today).c,
      upcoming: q("SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ? AND booking_status IN ('assigned','in_progress','confirmed')"),
      completed: q("SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ? AND booking_status = 'completed'"),
      unreadMessages,
    });
  }
  const one = sql => db.prepare(sql).get().c;
  res.json({
    paidRevenueCents: one("SELECT COALESCE(SUM(price_cents), 0) AS c FROM bookings WHERE payment_status = 'paid'"),
    totalBookings: one("SELECT COUNT(*) AS c FROM bookings WHERE booking_status != 'cancelled'"),
    needsWorker: one("SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id IS NULL AND booking_status IN ('pending','confirmed')"),
    unpaid: one("SELECT COUNT(*) AS c FROM bookings WHERE payment_status = 'pending' AND booking_status != 'cancelled' AND price_cents > 0"),
    quotes: one("SELECT COUNT(*) AS c FROM bookings WHERE quote_required = 1 AND price_cents = 0 AND booking_status != 'cancelled'"),
    todayJobs: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE cleaning_date = ? AND booking_status != 'cancelled'").get(today).c,
    activeWorkers: one("SELECT COUNT(*) AS c FROM users WHERE role = 'worker' AND active = 1"),
    unreadMessages,
    stripeApiConfigured,
    smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_PASS),
    paymentMethods: availableMethods().methods.map(m => m.key),
  });
});

app.get('/api/admin/bookings', authRequired(), (req, res) => {
  const base = `SELECT b.*, u.name AS worker_name FROM bookings b LEFT JOIN users u ON b.assigned_worker_id = u.id`;
  const rows = req.user.role === 'worker'
    ? db.prepare(`${base} WHERE b.assigned_worker_id = ? ORDER BY b.cleaning_date, b.time_slot`).all(req.user.id)
    : db.prepare(`${base} ORDER BY CASE WHEN b.booking_status IN ('completed','cancelled') THEN 1 ELSE 0 END, b.cleaning_date, b.time_slot`).all();
  res.json({ bookings: rows });
});

app.get('/api/admin/bookings/:id', authRequired(), (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (req.user.role === 'worker' && b.assigned_worker_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
  const links = req.user.role === 'worker' ? {} : {
    stripe_link: stripeLinkFor(b),
    paypal: paypalLinkFor(b),
    stripe_api: stripeApiConfigured,
  };
  const emails = req.user.role === 'worker' ? [] :
    db.prepare('SELECT email_type, recipient, subject, status, sent_at FROM email_logs WHERE booking_id = ? ORDER BY sent_at DESC LIMIT 30').all(b.id);
  res.json({ booking: b, paymentLinks: links, emails });
});

app.get('/api/admin/bookings/:id/candidates', authRequired(STAFF_ROLES), (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const workers = db.prepare("SELECT id, name, email, phone, service_areas FROM users WHERE role = 'worker' AND active = 1").all();
  const area = String(b.service_area || '').toLowerCase();
  const candidates = workers.map(w => {
    const areas = String(w.service_areas || '').toLowerCase();
    const conflict = db.prepare(`SELECT booking_code FROM bookings WHERE assigned_worker_id = ? AND cleaning_date = ? AND time_slot = ?
      AND id != ? AND booking_status NOT IN ('cancelled','completed')`).get(w.id, b.cleaning_date, b.time_slot, b.id);
    const sameDay = db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ? AND cleaning_date = ?
      AND id != ? AND booking_status != 'cancelled'`).get(w.id, b.cleaning_date, b.id).c;
    const week = db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE assigned_worker_id = ? AND booking_status IN ('assigned','in_progress','confirmed')
      AND cleaning_date BETWEEN date(?, '-3 days') AND date(?, '+3 days')`).get(w.id, b.cleaning_date, b.cleaning_date).c;
    const areaMatch = !area || areas.includes(area) || areas.includes('all');
    let score = 100;
    if (conflict) score -= 100;
    if (!areaMatch) score -= 30;
    score -= sameDay * 10 + week * 2;
    return { ...w, areaMatch, conflict: conflict ? conflict.booking_code : null, sameDay, week, score, current: b.assigned_worker_id === w.id };
  }).sort((a, z) => z.score - a.score);
  res.json({ candidates });
});

app.patch('/api/admin/bookings/:id/assign', authRequired(STAFF_ROLES), async (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const workerId = req.body && req.body.worker_id ? Number(req.body.worker_id) : null;

  if (!workerId) {
    db.prepare("UPDATE bookings SET assigned_worker_id = NULL, booking_status = CASE WHEN booking_status = 'assigned' THEN 'confirmed' ELSE booking_status END WHERE id = ?").run(b.id);
    postMessage({ threadType: 'booking', bookingId: b.id, sender: req.user, body: `Unassigned ${b.worker_name || 'the worker'} from this job.` });
    auditLog(req, req.user, 'worker_unassigned', b.booking_code);
    return res.json({ success: true, booking: getBooking(b.id) });
  }
  const worker = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'worker' AND active = 1").get(workerId);
  if (!worker) return res.status(404).json({ error: 'Active worker not found' });

  db.prepare(`UPDATE bookings SET assigned_worker_id = ?,
    booking_status = CASE WHEN booking_status IN ('pending','confirmed') THEN 'assigned' ELSE booking_status END WHERE id = ?`).run(worker.id, b.id);
  const updated = getBooking(b.id);
  const note = String((req.body && req.body.note) || '').trim();
  postMessage({ threadType: 'booking', bookingId: b.id, sender: req.user, body: `Assigned ${worker.name} to this job.${note ? '\n\nNote: ' + note : ''}` });
  if (req.body.notify !== false) await mailer.sendWorkerAssignment(updated, worker);
  auditLog(req, req.user, 'worker_assigned', b.booking_code, `Worker: ${worker.name}`);
  res.json({ success: true, booking: updated });
});

app.patch('/api/admin/bookings/:id/status', authRequired(), (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const status = String((req.body || {}).booking_status || '');
  const allowed = req.user.role === 'worker' ? ['in_progress', 'completed'] : ['pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (req.user.role === 'worker' && b.assigned_worker_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
  if (req.user.role === 'worker' && ['cancelled', 'completed'].includes(b.booking_status)) {
    return res.status(400).json({ error: `This job is already ${b.booking_status}. Contact the office if it needs to change.` });
  }
  if (status === b.booking_status) return res.json({ success: true, booking: b });
  // completed_at starts the clock for the automatic thank-you / rebook emails
  db.prepare('UPDATE bookings SET booking_status = ?, completed_at = ? WHERE id = ?')
    .run(status, status === 'completed' ? new Date().toISOString() : '', b.id);
  postMessage({ threadType: 'booking', bookingId: b.id, sender: req.user, body: `Status changed to “${status.replace('_', ' ')}”.` });
  auditLog(req, req.user, 'booking_status_changed', b.booking_code, status);
  res.json({ success: true, booking: getBooking(b.id) });
});

app.patch('/api/admin/bookings/:id/price', authRequired(STAFF_ROLES), (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'Booking is already paid' });
  const dollars = Number((req.body || {}).price);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100000) return res.status(400).json({ error: 'Enter a valid price' });
  db.prepare('UPDATE bookings SET price_cents = ? WHERE id = ?').run(Math.round(dollars * 100), b.id);
  postMessage({ threadType: 'booking', bookingId: b.id, sender: req.user, body: `Price set to $${dollars.toFixed(2)}.` });
  auditLog(req, req.user, 'quote_price_set', b.booking_code, `$${dollars.toFixed(2)}`);
  res.json({ success: true, booking: getBooking(b.id) });
});

app.post('/api/admin/bookings/:id/payment-request', authRequired(STAFF_ROLES), async (req, res) => {
  try {
    const b = getBooking(Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.payment_status === 'paid') return res.status(400).json({ error: 'Booking is already paid' });
    if (!b.price_cents) return res.status(400).json({ error: 'Set a price first' });
    const method = String((req.body || {}).method || '');
    let payUrl = null;

    if (method === 'stripe') {
      if (!stripe) return res.status(400).json({ error: 'Stripe API key is not configured in backend/.env' });
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: b.customer_email,
        client_reference_id: b.booking_code,
        line_items: [{ price_data: { currency: 'usd', product_data: { name: `${b.service_type} — ${b.home_size}`, description: `${b.cleaning_date} at ${b.time_slot}` }, unit_amount: b.price_cents }, quantity: 1 }],
        metadata: { booking_code: b.booking_code },
        success_url: `${BASE_URL}/book.html?status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/book.html?status=cancelled&code=${b.booking_code}`,
      });
      db.prepare("UPDATE bookings SET stripe_session_id = ?, payment_method = 'stripe' WHERE id = ?").run(session.id, b.id);
      payUrl = session.url;
    } else if (method === 'stripe_link') {
      payUrl = stripeLinkFor(b);
    } else if (method === 'paypal') {
      payUrl = paypalLinkFor(b);
    }
    if (!payUrl) return res.status(400).json({ error: `No ${METHOD_LABELS[method] || method} link is set up for this service. Add one in Payments settings.` });
    if (method !== 'stripe') db.prepare('UPDATE bookings SET payment_method = ? WHERE id = ?').run(method, b.id);

    const status = await mailer.sendPaymentRequest(getBooking(b.id), payUrl, String((req.body || {}).note || '').trim());
    postMessage({ threadType: 'booking', bookingId: b.id, audience: 'customer', sender: req.user, body: `Sent ${METHOD_LABELS[method]} payment request ($${(b.price_cents / 100).toFixed(2)}) to customer.`, emailStatus: status });
    auditLog(req, req.user, 'payment_request_sent', b.booking_code, METHOD_LABELS[method]);
    res.json({ success: true, payUrl, emailStatus: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/bookings/:id/mark-paid', authRequired(STAFF_ROLES), async (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.price_cents) return res.status(400).json({ error: 'Set a price first' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'Booking is already marked paid' });
  const method = String((req.body || {}).method || b.payment_method || 'other');
  if (!Object.prototype.hasOwnProperty.call(METHOD_LABELS, method)) return res.status(400).json({ error: 'Invalid payment method' });
  const updated = await markPaid(b, method, String((req.body || {}).reference || '').trim());
  postMessage({ threadType: 'booking', bookingId: b.id, sender: req.user, body: `Marked as paid via ${METHOD_LABELS[method] || method}.` });
  auditLog(req, req.user, 'booking_marked_paid', b.booking_code, `${METHOD_LABELS[method] || method}`);
  res.json({ success: true, booking: updated });
});

app.post('/api/admin/bookings/:id/remind', authRequired(STAFF_ROLES), async (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const status = await mailer.sendReminder(b, 'upcoming appointment', b.worker_name);
  postMessage({ threadType: 'booking', bookingId: b.id, audience: 'customer', sender: req.user, body: 'Sent a reminder email to the customer.', emailStatus: status });
  res.json({ success: true, emailStatus: status });
});

// ============================================================
// MESSAGING
// ============================================================
function threadCondition(thread) {
  if (thread === 'broadcast') return { sql: "m.thread_type = 'broadcast'", params: [] };
  const [kind, idStr] = String(thread).split(':');
  const id = Number(idStr);
  if (kind === 'worker' && id) return { sql: "m.thread_type = 'direct' AND m.recipient_id = ?", params: [id] };
  if (kind === 'booking' && id) return { sql: "m.thread_type = 'booking' AND m.booking_id = ?", params: [id] };
  return null;
}

function canAccessThread(user, thread) {
  if (STAFF_ROLES.includes(user.role)) return true;
  if (thread === 'broadcast') return true;
  const [kind, idStr] = String(thread).split(':');
  if (kind === 'worker') return Number(idStr) === user.id;
  if (kind === 'booking') {
    const b = db.prepare('SELECT assigned_worker_id FROM bookings WHERE id = ?').get(Number(idStr));
    return Boolean(b && b.assigned_worker_id === user.id);
  }
  return false;
}

function threadStats(user, thread) {
  const cond = threadCondition(thread);
  const last = db.prepare(`SELECT m.body, m.sender_name, m.created_at FROM messages m WHERE ${cond.sql} ORDER BY m.id DESC LIMIT 1`).get(...cond.params);
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${cond.sql}
    AND (m.sender_id IS NULL OR m.sender_id != ?)
    AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)`).get(...cond.params, user.id, user.id).c;
  return { last: last || null, unread };
}

function threadsFor(user) {
  const threads = [];
  const add = (key, title, subtitle, kind) => threads.push({ key, title, subtitle, kind, ...threadStats(user, key) });

  add('broadcast', 'Team announcements', 'Office → all cleaners', 'broadcast');
  if (STAFF_ROLES.includes(user.role)) {
    for (const w of db.prepare("SELECT id, name, service_areas FROM users WHERE role = 'worker' AND active = 1 ORDER BY name").all()) {
      add(`worker:${w.id}`, w.name, w.service_areas, 'worker');
    }
    for (const b of db.prepare(`SELECT DISTINCT b.id, b.booking_code, b.customer_name, b.cleaning_date FROM bookings b
      JOIN messages m ON m.booking_id = b.id AND m.thread_type = 'booking' ORDER BY b.cleaning_date DESC LIMIT 60`).all()) {
      add(`booking:${b.id}`, `${b.booking_code} · ${b.customer_name}`, `Job on ${b.cleaning_date}`, 'booking');
    }
  } else {
    add(`worker:${user.id}`, 'Office (Admin team)', 'Message the Bovic office', 'worker');
    for (const b of db.prepare(`SELECT id, booking_code, customer_name, cleaning_date FROM bookings
      WHERE assigned_worker_id = ? ORDER BY cleaning_date DESC LIMIT 60`).all(user.id)) {
      add(`booking:${b.id}`, `${b.booking_code} · ${b.customer_name}`, `Job on ${b.cleaning_date}`, 'booking');
    }
  }
  return threads;
}

app.get('/api/messages/threads', authRequired(), (req, res) => {
  const threads = threadsFor(req.user).sort((a, z) => {
    if (z.unread !== a.unread) return z.unread - a.unread;
    return String((z.last && z.last.created_at) || '').localeCompare(String((a.last && a.last.created_at) || ''));
  });
  res.json({ threads });
});

app.get('/api/messages', authRequired(), (req, res) => {
  const thread = String(req.query.thread || '');
  const cond = threadCondition(thread);
  if (!cond || !canAccessThread(req.user, thread)) return res.status(403).json({ error: 'Conversation not available' });
  const rows = db.prepare(`SELECT m.id, m.audience, m.sender_id, m.sender_name, m.sender_role, m.body, m.email_status, m.created_at
    FROM messages m WHERE ${cond.sql} ORDER BY m.id ASC LIMIT 300`).all(...cond.params);
  const mark = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
  for (const r of rows) if (r.sender_id !== req.user.id) mark.run(r.id, req.user.id);
  res.json({ messages: rows });
});

app.post('/api/messages', authRequired(), async (req, res) => {
  const { thread, body, audience, notify_email } = req.body || {};
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Message is empty' });
  const cond = threadCondition(thread);
  if (!cond || !canAccessThread(req.user, thread)) return res.status(403).json({ error: 'Conversation not available' });
  const isStaff = STAFF_ROLES.includes(req.user.role);
  const [kind, idStr] = String(thread).split(':');
  const id = Number(idStr);
  let emailStatus = '';

  if (thread === 'broadcast') {
    if (!isStaff) return res.status(403).json({ error: 'Only the office can post announcements' });
    if (notify_email) {
      for (const w of db.prepare("SELECT email FROM users WHERE role = 'worker' AND active = 1").all()) {
        await mailer.sendStaffNotification({ to: w.email, subject: 'Team announcement from Bovic Premier', title: 'Team announcement', text });
      }
      emailStatus = 'emailed_team';
    }
    postMessage({ threadType: 'broadcast', sender: req.user, body: text, emailStatus });
  } else if (kind === 'worker') {
    if (notify_email !== false) {
      if (isStaff) {
        const w = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
        if (w) emailStatus = await mailer.sendStaffNotification({ to: w.email, subject: `New message from ${req.user.name} (Bovic office)`, title: `Message from ${req.user.name}`, text });
      } else {
        emailStatus = await mailer.sendStaffNotification({ to: process.env.ADMIN_ALERT_EMAIL || 'booking@boviccleaning.com', subject: `New message from cleaner ${req.user.name}`, title: `Message from ${req.user.name}`, text });
      }
    }
    postMessage({ threadType: 'direct', recipientId: id, sender: req.user, body: text, emailStatus });
  } else {
    const b = getBooking(id);
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    const aud = audience === 'customer' && isStaff ? 'customer' : 'team';
    if (aud === 'customer') {
      emailStatus = await mailer.sendCustomerMessage(b, text, req.user.name);
    } else if (notify_email !== false) {
      if (isStaff && b.worker_email) {
        emailStatus = await mailer.sendStaffNotification({ to: b.worker_email, bookingId: b.id, subject: `Update on job ${b.booking_code} (${b.cleaning_date})`, title: `Job ${b.booking_code} — message from ${req.user.name}`, text });
      } else if (!isStaff) {
        emailStatus = await mailer.sendStaffNotification({ to: process.env.ADMIN_ALERT_EMAIL || 'booking@boviccleaning.com', bookingId: b.id, subject: `${req.user.name} on job ${b.booking_code}`, title: `Job ${b.booking_code} — message from ${req.user.name}`, text });
      }
    }
    postMessage({ threadType: 'booking', bookingId: b.id, audience: aud, sender: req.user, body: text, emailStatus });
  }
  res.status(201).json({ success: true });
});

// ============================================================
// USERS (STRICT LEAST PRIVILEGE + PASSWORD ROTATION + SESSION REVOCATION)
// ============================================================
app.get('/api/admin/users', authRequired(STAFF_ROLES), (req, res) => {
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.phone, u.service_areas, u.active, u.must_change_password, u.created_at,
      (SELECT COUNT(*) FROM bookings b WHERE b.assigned_worker_id = u.id AND b.booking_status IN ('assigned','in_progress','confirmed')) AS open_jobs,
      (SELECT COUNT(*) FROM bookings b WHERE b.assigned_worker_id = u.id AND b.booking_status = 'completed') AS done_jobs
    FROM users u ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`).all();
  res.json({ users });
});

app.post('/api/admin/users', authRequired(STAFF_ROLES), (req, res) => {
  const { name, email, password, role, phone, service_areas } = req.body || {};
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Name, email, password and role are required' });
  if (!['admin', 'worker'].includes(role)) return res.status(400).json({ error: 'Role must be admin or worker' });
  if (role === 'admin' && req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only the Super Admin can create admins' });
  const pwErr = validatePasswordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const cleanEmail = String(email).trim().toLowerCase();
  try {
    const info = db.prepare('INSERT INTO users (name, email, password_hash, role, phone, service_areas, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(String(name).trim(), cleanEmail, bcrypt.hashSync(String(password), 12), role,
        String(phone || '').trim(), String(service_areas || 'Buckhead, Sandy Springs, Roswell, Alpharetta').trim());
    auditLog(req, req.user, 'user_created', cleanEmail, `Role: ${role}`);
    res.status(201).json({ id: info.lastInsertRowid, success: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'A user with that email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', authRequired(STAFF_ROLES), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'worker' && req.user.role !== 'super_admin' && target.id !== req.user.id) {
    return res.status(403).json({ error: 'Only the Super Admin can edit admin accounts' });
  }
  const { name, phone, service_areas, password } = req.body || {};
  // Validate everything first so a rejected password doesn't leave a half-saved update
  if (password) {
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, service_areas = ? WHERE id = ?').run(
    String(name || target.name).trim().slice(0, 120), String(phone ?? target.phone).trim().slice(0, 40),
    String(service_areas ?? target.service_areas).trim().slice(0, 300), target.id);
  if (password) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?')
      .run(bcrypt.hashSync(String(password), 12), target.id);
    auditLog(req, req.user, 'user_password_reset', target.email);
  } else {
    auditLog(req, req.user, 'user_updated', target.email);
  }
  res.json({ success: true });
});

app.patch('/api/admin/users/:id/toggle', authRequired(STAFF_ROLES), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'The Super Admin cannot be deactivated' });
  if (target.role === 'admin' && req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only the Super Admin can manage admins' });
  db.prepare('UPDATE users SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, token_version = token_version + 1 WHERE id = ?').run(target.id);
  auditLog(req, req.user, target.active ? 'user_disabled' : 'user_enabled', target.email);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', authRequired(['super_admin']), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'The Super Admin cannot be deleted' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  auditLog(req, req.user, 'user_deleted', target.email, `Role: ${target.role}`);
  res.json({ success: true });
});

// ============================================================
// CALENDAR BLOCKS, EMAIL LOGS, PAYMENT SETTINGS, SECURITY & AUDIT
// ============================================================
app.get('/api/admin/blocked-dates', authRequired(STAFF_ROLES), (req, res) => {
  res.json({ blockedDates: db.prepare('SELECT * FROM blocked_dates ORDER BY date').all() });
});
app.post('/api/admin/blocked-dates', authRequired(STAFF_ROLES), (req, res) => {
  const { date, reason } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Valid date required' });
  try {
    db.prepare('INSERT INTO blocked_dates (date, reason, created_by) VALUES (?, ?, ?)').run(date, String(reason || 'Unavailable').trim(), req.user.id);
    auditLog(req, req.user, 'date_blocked', date, reason);
    res.status(201).json({ success: true });
  } catch { res.status(409).json({ error: 'That date is already blocked' }); }
});
app.delete('/api/admin/blocked-dates/:id', authRequired(STAFF_ROLES), (req, res) => {
  db.prepare('DELETE FROM blocked_dates WHERE id = ?').run(Number(req.params.id));
  auditLog(req, req.user, 'date_unblocked', String(req.params.id));
  res.json({ success: true });
});

app.get('/api/admin/email-logs', authRequired(STAFF_ROLES), (req, res) => {
  res.json({ logs: db.prepare('SELECT * FROM email_logs ORDER BY id DESC LIMIT 150').all() });
});

app.get('/api/admin/audit-logs', authRequired(['super_admin']), (req, res) => {
  res.json({
    logs: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 150').all(),
    security: {
      httpOnlyCookie: true,
      sameSiteStrict: true,
      csrfTokenProtection: true,
      cspStrictSelf: true,
      loginRateLimit: '15 attempts / 15 min per IP, 5 failures per account+IP, 25-failure account lockout',
      passwordPolicy: '10+ chars with uppercase, lowercase, and number/symbol + first-login rotation',
      httpsActive: IS_HTTPS,
      sessionTimeout: '8 hours (revocable)',
    },
  });
});

app.get('/api/admin/settings/payments', authRequired(['super_admin']), (req, res) => {
  res.json({
    settings: getPayments(),
    items: catalog.pricedItems(),
    stripeApiConfigured,
    webhookUrl: `${BASE_URL}/api/webhooks/stripe`,
    activeMethods: availableMethods().methods.map(m => m.key),
  });
});

app.put('/api/admin/settings/payments', authRequired(['super_admin']), (req, res) => {
  const input = req.body || {};
  const validKeys = new Set(catalog.pricedItems().map(i => i.key));
  const cleanMap = (map, kind) => {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
      const url = String(v || '').trim();
      if (!url || !validKeys.has(k)) continue;
      if (!validLink(url, kind)) throw new Error(`Invalid ${kind === 'stripe' ? 'Stripe' : 'PayPal'} link: ${url}`);
      out[k] = url;
    }
    return out;
  };
  try {
    const stripeDefault = String(input.stripe_default_link || '').trim();
    const paypalLink = String(input.paypal_link || '').trim();
    if (!validLink(stripeDefault, 'stripe')) throw new Error('The default Stripe link must be an https://buy.stripe.com/... link');
    if (!validLink(paypalLink, 'paypal')) throw new Error('The PayPal link must be an https://paypal.me/... or https://www.paypal.com/... link');
    const next = {
      stripe_checkout_enabled: Boolean(input.stripe_checkout_enabled),
      stripe_links_enabled: Boolean(input.stripe_links_enabled),
      stripe_default_link: stripeDefault,
      stripe_item_links: cleanMap(input.stripe_item_links, 'stripe'),
      paypal_enabled: Boolean(input.paypal_enabled),
      paypal_link: paypalLink,
      paypal_item_links: cleanMap(input.paypal_item_links, 'paypal'),
      pay_later_enabled: Boolean(input.pay_later_enabled),
      pay_later_label: String(input.pay_later_label || DEFAULT_PAYMENTS.pay_later_label).trim().slice(0, 140),
    };
    setSetting('payments', next);
    auditLog(req, req.user, 'payment_settings_updated', 'payments', availableMethods(next).methods.map(m => m.key).join(','));
    res.json({ success: true, settings: next, activeMethods: availableMethods().methods.map(m => m.key) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// WEBSITE CMS, LIVE PRICING, POLICIES & LOGO UPLOAD (ADMIN / SUPER ADMIN)
// ============================================================
app.get('/api/admin/site', authRequired(STAFF_ROLES), (req, res) => {
  const site = getSite();
  res.json({
    site,
    activePromo: resolveActivePromo(site),
    pricingItems: catalog.pricedItems(),
    pricingOverrides: catalog.getOverrides(),
    emailProvider: ({ resend: 'Resend', zoho: 'Zoho Mail', smtp: 'SMTP' })[mailer.emailProvider()] || '',
  });
});

// Sends both follow-up emails to the logged-in staff member, with sample booking details.
app.post('/api/admin/followups/test', authRequired(STAFF_ROLES), async (req, res) => {
  if (!checkRate(`fu-test:${req.user.id}`, 5, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many test emails. Try again in a few minutes.' });
  const site = getSite();
  const f = site.followups || {};
  const sample = {
    id: null, booking_code: 'BOV-SAMPLE', customer_name: req.user.name || 'Sample Customer', customer_email: req.user.email,
    service_type: 'Standard Home Cleaning', cleaning_date: businessToday(), time_slot: '9:00 AM',
  };
  const bookUrl = `${BASE_URL}/book.html`;
  const unsub = unsubscribeUrl(req.user.email);
  const a = await mailer.sendFollowupThanks(sample, { reviewUrl: f.review_url || (site.social && site.social.google_business) || '', bookUrl, unsubscribeUrl: unsub });
  const b = await mailer.sendFollowupRebook(sample, { days: f.rebook_days || 30, bookUrl, unsubscribeUrl: unsub, offerText: f.rebook_offer });
  auditLog(req, req.user, 'followup_test_sent', req.user.email);
  res.json({ success: true, to: req.user.email, statuses: [a, b] });
});

app.put('/api/admin/site', authRequired(STAFF_ROLES), (req, res) => {
  const input = req.body || {};
  const cur = getSite();

  const cleanStr = (v, fallback, max = 300) => {
    const s = String(v == null ? fallback : v).trim();
    return s.slice(0, max);
  };
  const cleanUrl = (v, fallback = '') => {
    if (v === undefined) return fallback;
    const s = String(v || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
    } catch { return ''; }
  };
  const cleanRegex = (v, re, fallback = '') => {
    if (v === undefined) return fallback;
    const s = String(v || '').trim();
    if (!s) return '';
    return re.test(s) ? s : '';
  };
  const cleanPlugin = (inCfg, curCfg, fallbackMode = 'auto') => {
    const src = inCfg && typeof inCfg === 'object' ? inCfg : {};
    const mode = ['auto', 'on', 'off'].includes(src.mode) ? src.mode : curCfg.mode || fallbackMode;
    const pctNum = Number(src.discount_percent == null ? curCfg.discount_percent : src.discount_percent);
    const pct = Number.isFinite(pctNum) ? Math.max(0, Math.min(50, Math.round(pctNum))) : curCfg.discount_percent;
    return {
      enabled: src.enabled === undefined ? curCfg.enabled !== false : Boolean(src.enabled),
      mode,
      badge: cleanStr(src.badge, curCfg.badge, 60),
      title: cleanStr(src.title, curCfg.title, 160),
      subtitle: cleanStr(src.subtitle, curCfg.subtitle, 300),
      promo_code: cleanStr(src.promo_code, curCfg.promo_code, 24).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
      discount_percent: pct,
      cta_text: cleanStr(src.cta_text, curCfg.cta_text, 40),
      end_date: (() => {
        const e = cleanStr(src.end_date, curCfg.end_date, 20);
        return e === '' || /^\d{4}-\d{2}-\d{2}$/.test(e) ? e : curCfg.end_date || '';
      })(),
      decorations: src.decorations === undefined ? curCfg.decorations !== false : Boolean(src.decorations),
      applies_to: (() => {
        const list = Array.isArray(src.applies_to) ? src.applies_to : curCfg.applies_to;
        const valid = Object.keys(catalog.BASE_SERVICES);
        return [...new Set((list || []).map(String).filter(k => valid.includes(k)))];
      })(),
    };
  };

  const sIn = input.site || {};
  const socIn = sIn.social || {};
  const plgIn = sIn.plugins || {};
  const seoIn = sIn.seo || {};
  const mktIn = sIn.marketing || {};
  const nextSite = {
    company_name: cleanStr(sIn.company_name, cur.company_name, 120),
    tagline: cleanStr(sIn.tagline, cur.tagline, 180),
    phone: cleanStr(sIn.phone, cur.phone, 40),
    booking_email: cleanStr(sIn.booking_email, cur.booking_email, 120),
    info_email: cleanStr(sIn.info_email, cur.info_email, 120),
    service_areas: cleanStr(sIn.service_areas, cur.service_areas, 200),
    hours: cleanStr(sIn.hours, cur.hours, 120),
    copyright_text: cleanStr(sIn.copyright_text, cur.copyright_text, 200),
    footer_about: cleanStr(sIn.footer_about, cur.footer_about, 600),
    social: {
      facebook: cleanUrl(socIn.facebook, cur.social.facebook),
      instagram: cleanUrl(socIn.instagram, cur.social.instagram),
      twitter: cleanUrl(socIn.twitter, cur.social.twitter),
      linkedin: cleanUrl(socIn.linkedin, cur.social.linkedin),
      pinterest: cleanUrl(socIn.pinterest, cur.social.pinterest),
      tiktok: cleanUrl(socIn.tiktok, cur.social.tiktok),
      youtube: cleanUrl(socIn.youtube, cur.social.youtube),
      google_business: cleanUrl(socIn.google_business, cur.social.google_business),
    },
    hero: {
      eyebrow: cleanStr(sIn.hero && sIn.hero.eyebrow, cur.hero.eyebrow, 160),
      title_1: cleanStr(sIn.hero && sIn.hero.title_1, cur.hero.title_1, 100),
      title_highlight: cleanStr(sIn.hero && sIn.hero.title_highlight, cur.hero.title_highlight, 100),
      subtitle: cleanStr(sIn.hero && sIn.hero.subtitle, cur.hero.subtitle, 500),
      cta_text: cleanStr(sIn.hero && sIn.hero.cta_text, cur.hero.cta_text, 60),
    },
    about: {
      tagline: cleanStr(sIn.about && sIn.about.tagline, cur.about.tagline, 80),
      title: cleanStr(sIn.about && sIn.about.title, cur.about.title, 180),
      text: cleanStr(sIn.about && sIn.about.text, cur.about.text, 800),
      experience_years: cleanStr(sIn.about && sIn.about.experience_years, cur.about.experience_years, 12),
      active_staff: cleanStr(sIn.about && sIn.about.active_staff, cur.about.active_staff, 12),
    },
    policies: {},
    plugins: {
      black_november: cleanPlugin(plgIn.black_november, cur.plugins.black_november, 'auto'),
      christmas_december: cleanPlugin(plgIn.christmas_december, cur.plugins.christmas_december, 'auto'),
    },
    seo: {
      default_title: cleanStr(seoIn.default_title, cur.seo.default_title, 140),
      site_title_suffix: cleanStr(seoIn.site_title_suffix, cur.seo.site_title_suffix, 80),
      meta_description: cleanStr(seoIn.meta_description, cur.seo.meta_description, 320),
      meta_keywords: cleanStr(seoIn.meta_keywords, cur.seo.meta_keywords, 400),
      canonical_base: cleanUrl(seoIn.canonical_base, cur.seo.canonical_base) || cur.seo.canonical_base,
      og_image: cleanStr(seoIn.og_image, cur.seo.og_image, 260),
      robots_index: seoIn.robots_index === undefined ? cur.seo.robots_index !== false : Boolean(seoIn.robots_index),
      schema_price_range: cleanStr(seoIn.schema_price_range, cur.seo.schema_price_range, 10),
    },
    marketing: {
      google_ads_id: cleanRegex(mktIn.google_ads_id, /^AW-[A-Z0-9]{6,20}$/, cur.marketing.google_ads_id),
      google_ads_label: cleanRegex(mktIn.google_ads_label, /^[A-Za-z0-9_-]{4,40}$/, cur.marketing.google_ads_label),
      ga4_id: cleanRegex(mktIn.ga4_id, /^G-[A-Z0-9]{6,15}$/, cur.marketing.ga4_id),
      gtm_id: cleanRegex(mktIn.gtm_id, /^GTM-[A-Z0-9]{5,12}$/, cur.marketing.gtm_id),
      search_console_token: cleanRegex(mktIn.search_console_token, /^[A-Za-z0-9_-]{10,80}$/, cur.marketing.search_console_token),
      meta_pixel_id: cleanRegex(mktIn.meta_pixel_id, /^\d{10,20}$/, cur.marketing.meta_pixel_id),
    },
    followups: (() => {
      const f = sIn.followups || {};
      const c = cur.followups;
      const int = (v, fb, min, max) => {
        const n = Math.round(Number(v));
        return v === undefined || !Number.isFinite(n) ? fb : Math.min(max, Math.max(min, n));
      };
      return {
        thanks_enabled: f.thanks_enabled === undefined ? c.thanks_enabled !== false : Boolean(f.thanks_enabled),
        thanks_delay_hours: int(f.thanks_delay_hours, c.thanks_delay_hours, 1, 168),
        review_url: cleanUrl(f.review_url, c.review_url),
        rebook_enabled: f.rebook_enabled === undefined ? c.rebook_enabled !== false : Boolean(f.rebook_enabled),
        rebook_days: int(f.rebook_days, c.rebook_days, 7, 180),
        rebook_offer: cleanStr(f.rebook_offer, c.rebook_offer, 160),
      };
    })(),
    logo_version: cur.logo_version || 1,
  };

  for (const pk of Object.keys(DEFAULT_SITE.policies)) {
    nextSite.policies[pk] = cleanStr(sIn.policies && sIn.policies[pk], cur.policies[pk], 4000);
  }
  setSetting('site', nextSite);

  if (input.pricingOverrides && typeof input.pricingOverrides === 'object') {
    const validKeys = new Set(catalog.pricedItems().map(i => i.key));
    const cleanPrices = {};
    for (const [k, dollars] of Object.entries(input.pricingOverrides)) {
      if (!validKeys.has(k)) continue;
      const num = Number(dollars);
      if (Number.isFinite(num) && num >= 10 && num <= 50000) {
        cleanPrices[k] = Math.round(num * 100);
      }
    }
    setSetting('pricing_overrides', cleanPrices);
  }

  auditLog(req, req.user, 'website_content_updated', 'site_cms');
  const updated = getSite();
  res.json({ success: true, site: updated, activePromo: resolveActivePromo(updated), pricingItems: catalog.pricedItems() });
});

function detectImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

app.post('/api/admin/site/logo', authRequired(STAFF_ROLES), (req, res) => {
  const { variant, dataUrl } = req.body || {};
  if (!['logo-1', 'logo-2', 'logo-3'].includes(variant)) {
    return res.status(400).json({ error: 'Choose logo-1, logo-2, or logo-3' });
  }
  // Logos are stored and referenced site-wide as logo-N.png, so only real PNG files are accepted
  const m = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Please upload a PNG image (logos need PNG for transparency)' });

  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo file must be under 2 MB' });
  if (detectImageType(buf) !== 'png') return res.status(400).json({ error: 'That file is not a valid PNG image (SVG is blocked for security)' });

  const dest = path.resolve(__dirname, '..', 'assets', 'images', 'resources', `${variant}.png`);
  fs.writeFileSync(dest, buf);

  const cur = getSite();
  cur.logo_version = Date.now();
  setSetting('site', cur);
  auditLog(req, req.user, 'logo_uploaded', variant, `${buf.length} bytes`);
  res.json({ success: true, logo_version: cur.logo_version, src: `assets/images/resources/${variant}.png?v=${cur.logo_version}` });
});

app.post('/api/admin/site/logo/reset', authRequired(STAFF_ROLES), (req, res) => {
  const { variant } = req.body || {};
  if (!['logo-1', 'logo-2', 'logo-3'].includes(variant)) {
    return res.status(400).json({ error: 'Invalid logo variant' });
  }
  const src = path.join(__dirname, 'data', 'default-logos', `${variant}.png`);
  const dest = path.resolve(__dirname, '..', 'assets', 'images', 'resources', `${variant}.png`);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Default logo backup not found' });
  fs.copyFileSync(src, dest);

  const cur = getSite();
  cur.logo_version = Date.now();
  setSetting('site', cur);
  auditLog(req, req.user, 'logo_reset', variant);
  res.json({ success: true, logo_version: cur.logo_version, src: `assets/images/resources/${variant}.png?v=${cur.logo_version}` });
});

// ============================================================
// AUTOMATED REMINDERS (every 15 minutes)
// ============================================================
function apptTime(dateStr, slot) {
  const m = String(slot).match(/(\d+):(\d+)\s*(AM|PM)/i);
  let hr = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  if (m && m[3].toUpperCase() === 'PM' && hr < 12) hr += 12;
  if (m && m[3].toUpperCase() === 'AM' && hr === 12) hr = 0;
  // Slots are North Atlanta wall-clock times, regardless of the server's own time zone
  return zonedToEpoch(dateStr, hr, min);
}

async function runReminderSweep() {
  const rows = db.prepare(`SELECT b.*, u.name AS worker_name FROM bookings b LEFT JOIN users u ON b.assigned_worker_id = u.id
    WHERE b.booking_status IN ('confirmed','assigned') AND (b.reminder_24h_sent = 0 OR b.reminder_2h_sent = 0)
      AND b.cleaning_date >= ?`).all(businessToday(Date.now() - 86400000));
  for (const b of rows) {
    const hrs = (apptTime(b.cleaning_date, b.time_slot) - Date.now()) / 3600000;
    if (hrs > 2 && hrs <= 24 && !b.reminder_24h_sent) {
      await mailer.sendReminder(b, '24 hours', b.worker_name);
      db.prepare('UPDATE bookings SET reminder_24h_sent = 1 WHERE id = ?').run(b.id);
    } else if (hrs > 0 && hrs <= 2 && !b.reminder_24h_sent) {
      // Booked at the last minute: skip the 24h email so the customer doesn't get two at once
      db.prepare('UPDATE bookings SET reminder_24h_sent = 1 WHERE id = ?').run(b.id);
    }
    if (hrs > 0 && hrs <= 2 && !b.reminder_2h_sent) {
      await mailer.sendReminder(b, '2 hours', b.worker_name);
      db.prepare('UPDATE bookings SET reminder_2h_sent = 1 WHERE id = ?').run(b.id);
    }
  }
}
cron.schedule('*/15 * * * *', () => runReminderSweep().catch(e => console.error('[Reminder Cron]', e)));

// ============================================================
// AUTOMATIC FOLLOW-UP EMAILS (after a job is marked completed)
// ============================================================
const FOLLOWUP_SEND_HOURS = [9, 19];   // only email customers 9:00–18:59 business time
const FOLLOWUP_BATCH = 25;             // max emails per type per sweep

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function unsubToken(email) {
  return crypto.createHmac('sha256', JWT_SECRET).update('unsub:' + normEmail(email)).digest('base64url').slice(0, 32);
}
function unsubscribeUrl(email) {
  return `${BASE_URL}/api/public/unsubscribe?e=${encodeURIComponent(normEmail(email))}&t=${unsubToken(email)}`;
}
function validUnsub(email, token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(unsubToken(email));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isOptedOut(email) {
  return Boolean(db.prepare('SELECT 1 FROM email_optouts WHERE email = ?').get(normEmail(email)));
}
function unsubPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${mailer.esc(title)}</title><style>body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f7f4f1;color:#0c342f;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.c{background:#fff;border:1px solid #ded8cf;border-radius:14px;max-width:440px;padding:28px;text-align:center}button,a.b{background:#f1ab21;color:#0c342f;border:0;border-radius:999px;padding:12px 24px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block;margin-top:8px}</style></head>
<body><div class="c"><h2>${mailer.esc(title)}</h2>${body}</div></body></html>`;
}

// Link in the email shows a confirm button (so mail scanners that open links don't unsubscribe people).
app.get('/api/public/unsubscribe', (req, res) => {
  const email = normEmail(req.query.e);
  if (!email || !validUnsub(email, req.query.t)) return res.status(400).send(unsubPage('Link not valid', '<p>This unsubscribe link is incomplete. Reply to any of our emails and we\'ll remove you.</p>'));
  if (isOptedOut(email)) return res.send(unsubPage('You\'re unsubscribed', '<p>You won\'t get follow-up emails from us. Booking confirmations and reminders still arrive.</p><a class="b" href="/index.html">Back to website</a>'));
  res.send(unsubPage('Stop follow-up emails?', `<p>${mailer.esc(email)} will no longer get thank-you or "time to rebook" emails. Booking confirmations and reminders still arrive.</p>
    <form method="post"><input type="hidden" name="e" value="${mailer.esc(email)}"><input type="hidden" name="t" value="${mailer.esc(req.query.t)}"><button type="submit">Unsubscribe</button></form>`));
});
// Form above + one-click unsubscribe from Gmail/Outlook (RFC 8058) both POST here.
app.post('/api/public/unsubscribe', (req, res) => {
  const email = normEmail((req.body && req.body.e) || req.query.e);
  const token = (req.body && req.body.t) || req.query.t;
  if (!email || !validUnsub(email, token)) return res.status(400).send(unsubPage('Link not valid', '<p>Reply to any of our emails and we\'ll remove you.</p>'));
  db.prepare('INSERT OR IGNORE INTO email_optouts (email) VALUES (?)').run(email);
  res.send(unsubPage('You\'re unsubscribed', '<p>You won\'t get follow-up emails from us. Booking confirmations and reminders still arrive.</p><a class="b" href="/index.html">Back to website</a>'));
});

async function runFollowupSweep(now = Date.now()) {
  const f = getSite().followups || {};
  const hour = tzParts(now).hour;
  if (hour < FOLLOWUP_SEND_HOURS[0] || hour >= FOLLOWUP_SEND_HOURS[1]) return { skipped: 'outside sending hours' };
  const site = getSite();
  const reviewUrl = f.review_url || (site.social && site.social.google_business) || '';
  const bookUrl = `${BASE_URL}/book.html`;
  const result = { thanks: 0, rebook: 0 };

  // 1) Thank-you + review request, N hours after the job is marked completed
  if (f.thanks_enabled !== false) {
    const cutoff = new Date(now - (Number(f.thanks_delay_hours) || 3) * 3600000).toISOString();
    const oldest = new Date(now - 14 * 86400000).toISOString(); // never email about jobs older than 2 weeks
    const rows = db.prepare(`SELECT * FROM bookings WHERE booking_status = 'completed' AND followup_thanks_sent = 0
      AND completed_at != '' AND completed_at <= ? AND completed_at >= ? ORDER BY completed_at LIMIT ?`).all(cutoff, oldest, FOLLOWUP_BATCH);
    for (const b of rows) {
      db.prepare('UPDATE bookings SET followup_thanks_sent = 1 WHERE id = ?').run(b.id);
      if (!b.customer_email || isOptedOut(b.customer_email)) continue;
      // Weekly / every-2-weeks customers: one thank-you a month is plenty
      const recent = db.prepare(`SELECT 1 FROM email_logs WHERE email_type = 'followup_thanks' AND lower(recipient) = ?
        AND status IN ('sent','logged_demo') AND sent_at >= datetime('now', '-30 days')`).get(normEmail(b.customer_email));
      if (recent) continue;
      await mailer.sendFollowupThanks(b, { reviewUrl, bookUrl, unsubscribeUrl: unsubscribeUrl(b.customer_email) });
      result.thanks++;
    }
  }

  // 2) "Time for another clean?" for one-time customers who haven't booked again
  if (f.rebook_enabled !== false) {
    const days = Number(f.rebook_days) || 30;
    const dueBy = businessToday(now - days * 86400000);
    const notBefore = businessToday(now - (days + 14) * 86400000);
    const rows = db.prepare(`SELECT * FROM bookings WHERE booking_status = 'completed' AND followup_rebook_sent = 0
      AND (frequency_key = 'onetime' OR (frequency_key = '' AND lower(frequency) LIKE 'one%'))
      AND cleaning_date <= ? AND cleaning_date >= ? ORDER BY cleaning_date LIMIT ?`).all(dueBy, notBefore, FOLLOWUP_BATCH);
    for (const b of rows) {
      db.prepare('UPDATE bookings SET followup_rebook_sent = 1 WHERE id = ?').run(b.id);
      if (!b.customer_email || isOptedOut(b.customer_email)) continue;
      const rebooked = db.prepare(`SELECT 1 FROM bookings WHERE lower(customer_email) = ? AND id != ?
        AND booking_status != 'cancelled' AND (cleaning_date > ? OR created_at > ?)`).get(normEmail(b.customer_email), b.id, b.cleaning_date, b.created_at);
      if (rebooked) continue;
      await mailer.sendFollowupRebook(b, { days, bookUrl, unsubscribeUrl: unsubscribeUrl(b.customer_email), offerText: f.rebook_offer });
      result.rebook++;
    }
  }
  return result;
}
cron.schedule('5,35 * * * *', () => runFollowupSweep().catch(e => console.error('[Follow-up Cron]', e)));

app.listen(PORT, () => {
  console.log(`\nBovic Premier server ready (Hardened Mode)`);
  console.log(`  Website:      ${BASE_URL}/index.html`);
  console.log(`  Book online:  ${BASE_URL}/book.html`);
  console.log(`  Staff portal: ${BASE_URL}/admin.html`);
  console.log(`  Payments:     ${availableMethods().methods.map(m => m.label).join(', ')}\n`);
});
