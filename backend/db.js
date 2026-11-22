const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'bovic.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'worker')),
    phone TEXT DEFAULT '',
    service_areas TEXT DEFAULT 'Buckhead, Sandy Springs, Roswell, Alpharetta',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_code TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    address TEXT NOT NULL,
    service_area TEXT NOT NULL,
    service_type TEXT NOT NULL,
    home_size TEXT NOT NULL,
    frequency TEXT NOT NULL,
    cleaning_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending', 'paid', 'refunded')),
    stripe_session_id TEXT DEFAULT '',
    booking_status TEXT NOT NULL DEFAULT 'pending' CHECK(booking_status IN ('pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled')),
    assigned_worker_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reminder_24h_sent INTEGER NOT NULL DEFAULT 0,
    reminder_2h_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    reason TEXT DEFAULT 'Unavailable',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    email_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_preview TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Migrations ---
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('bookings', 'service_key', "TEXT DEFAULT ''");
addColumn('bookings', 'size_key', "TEXT DEFAULT ''");
addColumn('bookings', 'frequency_key', "TEXT DEFAULT ''");
addColumn('bookings', 'quote_required', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bookings', 'payment_method', "TEXT DEFAULT ''");
addColumn('bookings', 'payment_reference', "TEXT DEFAULT ''");
addColumn('bookings', 'paid_at', "TEXT DEFAULT ''");

// Automatic follow-up emails after a completed job
{
  const hadFollowups = db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'followup_thanks_sent');
  addColumn('bookings', 'completed_at', "TEXT DEFAULT ''");
  addColumn('bookings', 'followup_thanks_sent', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bookings', 'followup_rebook_sent', 'INTEGER NOT NULL DEFAULT 0');
  if (!hadFollowups) {
    // Jobs finished before this feature existed: never email those customers out of the blue.
    db.exec("UPDATE bookings SET followup_thanks_sent = 1, followup_rebook_sent = 1 WHERE booking_status = 'completed'");
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS email_optouts (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Security columns on users
addColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'locked_until', "TEXT DEFAULT ''");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_type TEXT NOT NULL CHECK(thread_type IN ('booking', 'direct', 'broadcast')),
    booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    audience TEXT NOT NULL DEFAULT 'team' CHECK(audience IN ('team', 'customer')),
    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sender_name TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    body TEXT NOT NULL,
    email_status TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id);
  CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(thread_type, sender_id, recipient_id);

  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT DEFAULT '',
    actor_role TEXT DEFAULT '',
    action TEXT NOT NULL,
    target TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

// Seed initial accounts ONLY on an empty database using random passwords written once to backend/data/INITIAL_CREDENTIALS.txt
const existingSuper = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
if (!existingSuper) {
  const genPass = () => crypto.randomBytes(12).toString('base64url') + '!A9';
  const creds = {
    super: genPass(),
    admin: genPass(),
    maya: genPass(),
    david: genPass(),
    sofia: genPass(),
  };

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (name, email, password_hash, role, phone, service_areas, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insertUser.run('Bovic Super Admin', 'superadmin@boviccleaning.com', bcrypt.hashSync(creds.super, 12), 'super_admin', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');
  insertUser.run('Operations Admin', 'admin@boviccleaning.com', bcrypt.hashSync(creds.admin, 12), 'admin', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');
  insertUser.run('Maya Carter', 'maya@boviccleaning.com', bcrypt.hashSync(creds.maya, 12), 'worker', '678-799-4634', 'Buckhead, Sandy Springs');
  insertUser.run('David Brooks', 'david@boviccleaning.com', bcrypt.hashSync(creds.david, 12), 'worker', '678-799-4634', 'Roswell, Alpharetta');
  insertUser.run('Sofia Morales', 'sofia@boviccleaning.com', bcrypt.hashSync(creds.sofia, 12), 'worker', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');

  const credPath = path.join(dataDir, 'INITIAL_CREDENTIALS.txt');
  fs.writeFileSync(credPath, [
    'BOVIC PREMIER — INITIAL ONE-TIME STAFF CREDENTIALS (DELETE THIS FILE AFTER CHANGING PASSWORDS)',
    `Super Admin: superadmin@boviccleaning.com  |  ${creds.super}`,
    `Admin:       admin@boviccleaning.com       |  ${creds.admin}`,
    `Worker 1:    maya@boviccleaning.com        |  ${creds.maya}`,
    `Worker 2:    david@boviccleaning.com       |  ${creds.david}`,
    `Worker 3:    sofia@boviccleaning.com       |  ${creds.sofia}`,
    ''
  ].join('\n'), { mode: 0o600 });
  console.log(`\n[FIRST RUN] Random initial credentials written to: ${credPath}\n`);
} else {
  // Enforce mandatory password rotation if any existing account is still using the old demo passwords
  const weakDefaults = ['BovicSuper@2026', 'BovicAdmin@2026', 'BovicWorker@2026'];
  const allUsers = db.prepare('SELECT id, password_hash, must_change_password FROM users').all();
  for (const u of allUsers) {
    if (!u.must_change_password && weakDefaults.some(pw => bcrypt.compareSync(pw, u.password_hash))) {
      db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(u.id);
    }
  }
}

module.exports = db;
