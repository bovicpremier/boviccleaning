const nodemailer = require('nodemailer');
const db = require('./db');

const BRAND_DARK = '#0c342f';
const BRAND_GOLD = '#f1ab21';
const BRAND_CREAM = '#f7f4f1';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function formatMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

// Email provider, chosen with EMAIL_PROVIDER in backend/.env:
//   resend → Resend HTTP API (RESEND_API_KEY). Works even where the host blocks SMTP ports.
//   zoho   → Zoho Mail SMTP (SMTP_USER + SMTP_PASS = a Zoho app password). Host defaults to
//            smtppro.zoho.com (custom-domain mailboxes); set SMTP_HOST to override, e.g. smtp.zoho.eu.
//   smtp   → any SMTP server from SMTP_HOST/PORT/SECURE/USER/PASS (Gmail, cPanel...).
// Left empty, it's "smtp" when SMTP_HOST is set, otherwise emails are only logged (demo mode).
function emailProvider() {
  const p = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (p === 'resend') return process.env.RESEND_API_KEY ? 'resend' : null;
  if (p === 'zoho') return process.env.SMTP_USER && process.env.SMTP_PASS ? 'zoho' : null;
  return process.env.SMTP_HOST && process.env.SMTP_PASS ? 'smtp' : null;
}

let cachedTransport = null;
let cachedTransportKey = '';
function getTransporter(provider) {
  const opts = provider === 'zoho'
    ? {
        host: process.env.SMTP_HOST || 'smtppro.zoho.com',
        port: Number(process.env.SMTP_PORT || 465),
        secure: String(process.env.SMTP_SECURE || 'true') === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }
    : {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        secure: String(process.env.SMTP_SECURE || 'true') === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      };
  const key = JSON.stringify([opts.host, opts.port, opts.secure, opts.auth.user]);
  if (!cachedTransport || cachedTransportKey !== key) {
    cachedTransport = nodemailer.createTransport(opts);
    cachedTransportKey = key;
  }
  return cachedTransport;
}

async function sendViaResend({ from, to, subject, html, headers, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, headers, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.message) msg += ' ' + j.message; } catch { /* non-JSON error */ }
    throw new Error('Resend: ' + msg);
  }
}

function wrapHtml(title, bodyHtml) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ded8cf;border-radius:14px;overflow:hidden;color:${BRAND_DARK};">
    <div style="background:${BRAND_DARK};padding:22px 28px;">
      <h2 style="margin:0;font-size:21px;color:${BRAND_GOLD};">Bovic Premier Cleaning Pros LLC</h2>
      <p style="margin:4px 0 0;font-size:13px;color:#cfe3dd;">Buckhead · Sandy Springs · Roswell · Alpharetta · 678-799-4634</p>
    </div>
    <div style="padding:28px;background:#ffffff;">
      <h3 style="margin-top:0;color:${BRAND_DARK};">${esc(title)}</h3>
      ${bodyHtml}
    </div>
    <div style="background:${BRAND_CREAM};padding:16px 28px;font-size:12px;color:#595752;border-top:1px solid #ded8cf;">
      Questions or need to reschedule? Call/text <strong>678-799-4634</strong> or reply to <strong>booking@boviccleaning.com</strong>.
    </div>
  </div>`;
}

function detailsTable(b) {
  const row = (k, v) =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee6da;color:#595752;width:38%;">${k}</td><td style="padding:8px;border-bottom:1px solid #eee6da;">${v}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
    ${row('Booking code', `<strong>${esc(b.booking_code)}</strong>`)}
    ${row('Service', `${esc(b.service_type)} (${esc(b.home_size)} · ${esc(b.frequency)})`)}
    ${row('Date &amp; time', `<strong>${esc(b.cleaning_date)} at ${esc(b.time_slot)}</strong>`)}
    ${row('Location', `${esc(b.address)} (${esc(b.service_area)})`)}
    ${b.price_cents ? row('Amount', `<strong>${formatMoney(b.price_cents)}</strong>`) : row('Amount', 'Custom quote — we will confirm your price')}
  </table>`;
}

function button(url, label) {
  return `<p style="margin:22px 0;"><a href="${esc(url)}" style="background:${BRAND_GOLD};color:${BRAND_DARK};padding:13px 26px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block;">${esc(label)}</a></p>`;
}

async function sendEmail({ bookingId = null, to, emailType, subject, html, textPreview, headers }) {
  const provider = emailProvider();
  const fromName = process.env.FROM_NAME || 'Bovic Premier Cleaning Pros LLC';
  const fromEmail = process.env.FROM_EMAIL || 'booking@boviccleaning.com';
  const from = `"${fromName.replace(/"/g, '')}" <${fromEmail}>`;
  const replyTo = process.env.REPLY_TO_EMAIL || '';
  let status = 'logged_demo';

  if (provider) {
    try {
      if (provider === 'resend') await sendViaResend({ from, to, subject, html, headers, replyTo });
      else await getTransporter(provider).sendMail({ from, to, subject, html, headers, ...(replyTo ? { replyTo } : {}) });
      status = 'sent';
    } catch (err) {
      console.error(`[Mailer Error] (${provider})`, err.message);
      status = 'failed: ' + err.message.slice(0, 120);
    }
  } else {
    console.log(`[Email Demo Log] To: ${to} | Subject: ${subject}`);
  }

  db.prepare(`
    INSERT INTO email_logs (booking_id, recipient, email_type, subject, body_preview, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookingId, to, emailType, subject, String(textPreview || subject).slice(0, 300), status);

  return status;
}

const adminEmail = () => process.env.ADMIN_ALERT_EMAIL || 'booking@boviccleaning.com';

async function sendBookingConfirmation(b) {
  await sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'confirmation',
    subject: `Booking Confirmed (${b.booking_code}) — ${b.cleaning_date} at ${b.time_slot}`,
    html: wrapHtml('Your cleaning is confirmed!', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <p>Thank you for booking with Bovic Premier Cleaning Pros LLC. Your payment is confirmed and your cleaning is on the calendar.</p>
      ${detailsTable(b)}
      <p>We'll email you a reminder 24 hours and 2 hours before your appointment.</p>`),
    textPreview: `Booking ${b.booking_code} confirmed for ${b.cleaning_date} ${b.time_slot}.`,
  });

  await sendEmail({
    bookingId: b.id,
    to: adminEmail(),
    emailType: 'admin_alert',
    subject: `New paid booking ${b.booking_code} — ${b.service_area} (${b.cleaning_date})`,
    html: wrapHtml('New paid booking — ready to assign', `
      <p><strong>${esc(b.customer_name)}</strong> · ${esc(b.customer_phone)} · ${esc(b.customer_email)}</p>
      ${detailsTable(b)}
      <p>Open the Admin Portal to assign a cleaner.</p>`),
    textPreview: `New paid booking ${b.booking_code} from ${b.customer_name}.`,
  });
}

async function sendQuoteReceived(b) {
  await sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'quote_received',
    subject: `We received your estimate request (${b.booking_code})`,
    html: wrapHtml('Your free estimate request is in', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <p>Thanks for reaching out! We've reserved your preferred time and will reply with your exact price, usually within one business day.</p>
      ${detailsTable(b)}`),
    textPreview: `Estimate request ${b.booking_code} received.`,
  });
  await sendEmail({
    bookingId: b.id,
    to: adminEmail(),
    emailType: 'admin_alert',
    subject: `New estimate request ${b.booking_code} — ${b.service_type}`,
    html: wrapHtml('New estimate request', `
      <p><strong>${esc(b.customer_name)}</strong> · ${esc(b.customer_phone)} · ${esc(b.customer_email)}</p>
      ${detailsTable(b)}
      <p><strong>Notes:</strong> ${nl2br(b.notes || 'None')}</p>
      <p>Set a price in the Admin Portal, then send the customer a payment request.</p>`),
    textPreview: `Estimate request ${b.booking_code} from ${b.customer_name}.`,
  });
}

async function sendReminder(b, hoursLabel, workerName) {
  return sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: hoursLabel.includes('24') ? 'reminder_24h' : hoursLabel.includes('2 hours') ? 'reminder_2h' : 'reminder_manual',
    subject: `Reminder: your cleaning on ${b.cleaning_date} at ${b.time_slot}`,
    html: wrapHtml(`Upcoming cleaning reminder (${hoursLabel})`, `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <p>A friendly reminder that your Bovic Premier cleaning is coming up.</p>
      ${detailsTable(b)}
      ${workerName ? `<p><strong>Your cleaning pro:</strong> ${esc(workerName)}</p>` : ''}
      <p>Please have entry instructions or gate codes ready. Call/text 678-799-4634 if anything changes.</p>`),
    textPreview: `${hoursLabel} reminder for ${b.cleaning_date} ${b.time_slot}.`,
  });
}

async function sendWorkerAssignment(b, worker) {
  await sendEmail({
    bookingId: b.id,
    to: worker.email,
    emailType: 'worker_assigned',
    subject: `New job assigned (${b.booking_code}) — ${b.cleaning_date} at ${b.time_slot}`,
    html: wrapHtml('New cleaning job assigned to you', `
      <p>Hi <strong>${esc(worker.name)}</strong>, you've been assigned a new job:</p>
      ${detailsTable(b)}
      <p><strong>Customer:</strong> ${esc(b.customer_name)} (${esc(b.customer_phone)})<br>
         <strong>Notes:</strong> ${nl2br(b.notes || 'None')}</p>
      <p>Log in to the Admin Portal to message the office or update job status.</p>`),
    textPreview: `Assigned ${b.booking_code} to ${worker.name}.`,
  });
  await sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'worker_assigned_customer',
    subject: `Your cleaning pro has been assigned (${b.booking_code})`,
    html: wrapHtml('Meet your cleaning pro', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <p><strong>${esc(worker.name)}</strong> will be taking care of your cleaning on <strong>${esc(b.cleaning_date)} at ${esc(b.time_slot)}</strong>.</p>`),
    textPreview: `Told customer ${worker.name} is assigned.`,
  });
}

async function sendCustomerMessage(b, body, senderName) {
  return sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'customer_message',
    subject: `Message about your cleaning (${b.booking_code})`,
    html: wrapHtml('A message from your Bovic Premier team', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <div style="background:${BRAND_CREAM};border-left:4px solid ${BRAND_GOLD};padding:14px 16px;border-radius:6px;margin:14px 0;">${nl2br(body)}</div>
      <p style="color:#595752;font-size:13px;">— ${esc(senderName)}, Bovic Premier Cleaning Pros LLC</p>
      <p style="font-size:13px;">Booking ${esc(b.booking_code)} · ${esc(b.cleaning_date)} at ${esc(b.time_slot)}</p>`),
    textPreview: body,
  });
}

async function sendPaymentRequest(b, payUrl, note) {
  return sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'payment_request',
    subject: `Complete your payment (${b.booking_code}) — ${formatMoney(b.price_cents)}`,
    html: wrapHtml('Your booking is ready for payment', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      ${note ? `<p>${nl2br(note)}</p>` : '<p>Your price is confirmed. Use the secure link below to pay and lock in your cleaning.</p>'}
      ${detailsTable(b)}
      ${button(payUrl, `Pay ${formatMoney(b.price_cents)} securely`)}
      <p style="font-size:12px;color:#595752;">Or copy this link: ${esc(payUrl)}</p>`),
    textPreview: `Payment request ${formatMoney(b.price_cents)} for ${b.booking_code}.`,
  });
}

async function sendStaffNotification({ to, subject, title, text, bookingId = null }) {
  return sendEmail({
    bookingId,
    to,
    emailType: 'staff_message',
    subject,
    html: wrapHtml(title, `<div style="background:${BRAND_CREAM};padding:14px 16px;border-radius:6px;">${nl2br(text)}</div>
      <p style="font-size:13px;color:#595752;">Reply in the Admin Portal → Messages.</p>`),
    textPreview: text,
  });
}

async function sendBookingReceived(b, payUrl, methodLabel) {
  await sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'booking_received',
    subject: `Booking received (${b.booking_code}) — ${b.cleaning_date} at ${b.time_slot}`,
    html: wrapHtml('We received your booking', `
      <p>Hi <strong>${esc(b.customer_name)}</strong>,</p>
      <p>Your time slot is reserved. ${payUrl
        ? `Please complete your payment via <strong>${esc(methodLabel)}</strong> to confirm it.`
        : `Payment method: <strong>${esc(methodLabel)}</strong>.`}</p>
      ${detailsTable(b)}
      ${payUrl ? button(payUrl, `Pay ${formatMoney(b.price_cents)} with ${methodLabel}`) : ''}
      <p>We'll send reminders 24 hours and 2 hours before your appointment.</p>`),
    textPreview: `Booking ${b.booking_code} received (${methodLabel}).`,
  });
  await sendEmail({
    bookingId: b.id,
    to: adminEmail(),
    emailType: 'admin_alert',
    subject: `New booking ${b.booking_code} (${methodLabel}) — ${b.service_area} ${b.cleaning_date}`,
    html: wrapHtml('New booking — payment to verify', `
      <p><strong>${esc(b.customer_name)}</strong> · ${esc(b.customer_phone)} · ${esc(b.customer_email)}</p>
      ${detailsTable(b)}
      <p>Payment method: <strong>${esc(methodLabel)}</strong>. Mark it paid in the Admin Portal once received.</p>`),
    textPreview: `New booking ${b.booking_code} via ${methodLabel}.`,
  });
}

// --- Automatic follow-ups after a completed job (sent by the cron in server.js) ---
function friendlyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function unsubscribeNote(url) {
  return `<p style="margin-top:26px;font-size:12px;color:#8a857d;">Don't want follow-up emails?
    <a href="${esc(url)}" style="color:#8a857d;">Unsubscribe</a>. You'll still get booking confirmations and reminders.</p>`;
}
function listUnsubHeaders(url) {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

async function sendFollowupThanks(b, { reviewUrl, bookUrl, unsubscribeUrl }) {
  const first = String(b.customer_name || '').trim().split(/\s+/)[0] || 'there';
  return sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'followup_thanks',
    subject: `Thanks for choosing Bovic Premier, ${first}!`,
    headers: listUnsubHeaders(unsubscribeUrl),
    html: wrapHtml('How did we do?', `
      <p>Hi <strong>${esc(first)}</strong>,</p>
      <p>Thank you for choosing us for your <strong>${esc(b.service_type || 'cleaning')}</strong> on ${esc(friendlyDate(b.cleaning_date))}.
         We hope everything feels fresh and spotless.</p>
      ${reviewUrl
        ? `<p>If you were happy with the service, a quick Google review helps our small local team more than anything:</p>
           ${button(reviewUrl, '⭐ Leave a Google review')}
           <p>If anything wasn't perfect, just reply to this email and we'll make it right.</p>`
        : `<p>If anything wasn't perfect, just reply to this email and we'll make it right.</p>`}
      <p>Ready for the next one?</p>
      ${button(bookUrl, 'Book your next cleaning')}
      ${unsubscribeNote(unsubscribeUrl)}`),
    textPreview: `Thank-you / review request for ${b.booking_code}.`,
  });
}

async function sendFollowupRebook(b, { days, bookUrl, unsubscribeUrl, offerText }) {
  const first = String(b.customer_name || '').trim().split(/\s+/)[0] || 'there';
  return sendEmail({
    bookingId: b.id,
    to: b.customer_email,
    emailType: 'followup_rebook',
    subject: `Time for a fresh clean, ${first}?`,
    headers: listUnsubHeaders(unsubscribeUrl),
    html: wrapHtml('Your home is due for a refresh', `
      <p>Hi <strong>${esc(first)}</strong>,</p>
      <p>It's been about ${esc(days)} days since we cleaned for you. Dust and kitchen grease build back up quickly,
         and regular cleanings keep your home easier to maintain.</p>
      ${offerText ? `<p style="background:${BRAND_CREAM};border-left:4px solid ${BRAND_GOLD};padding:12px 14px;border-radius:6px;"><strong>${esc(offerText)}</strong></p>` : ''}
      <p>Pick a date and time online in under a minute. Weekly and every-2-weeks plans cost less per visit.</p>
      ${button(bookUrl, 'Book my next cleaning')}
      ${unsubscribeNote(unsubscribeUrl)}`),
    textPreview: `Rebook reminder (${days} days) for ${b.booking_code}.`,
  });
}

module.exports = {
  emailProvider,
  sendFollowupThanks,
  sendFollowupRebook,
  esc,
  formatMoney,
  sendEmail,
  sendBookingConfirmation,
  sendBookingReceived,
  sendQuoteReceived,
  sendReminder,
  sendWorkerAssignment,
  sendCustomerMessage,
  sendPaymentRequest,
  sendStaffNotification,
};
