const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const isTurso = Boolean(TURSO_URL);

let localDb = null;
let tursoClient = null;

if (isTurso) {
  const { createClient } = require('@libsql/client');
  tursoClient = createClient({
    url: TURSO_URL,
    ...(TURSO_TOKEN ? { authToken: TURSO_TOKEN } : {}),
  });
} else {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  localDb = new DatabaseSync(path.join(dataDir, 'bovic.db'));
}

function toPlainRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

async function get(sql, ...params) {
  if (isTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    return res.rows.length ? toPlainRow(res.rows[0]) : undefined;
  }
  return localDb.prepare(sql).get(...params);
}

async function all(sql, ...params) {
  if (isTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    return res.rows.map(toPlainRow);
  }
  return localDb.prepare(sql).all(...params);
}

async function run(sql, ...params) {
  if (isTurso) {
    const res = await tursoClient.execute({ sql, args: params });
    return {
      lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : 0,
      changes: Number(res.rowsAffected || 0),
    };
  }
  const info = localDb.prepare(sql).run(...params);
  return {
    lastInsertRowid: Number(info.lastInsertRowid || 0),
    changes: Number(info.changes || 0),
  };
}

async function exec(sql) {
  if (isTurso) {
    if (typeof tursoClient.executeMultiple === 'function') {
      await tursoClient.executeMultiple(sql);
    } else {
      for (const stmt of String(sql).split(';').map(s => s.trim()).filter(Boolean)) {
        await tursoClient.execute(stmt);
      }
    }
    return;
  }
  localDb.exec(sql);
}

async function addColumn(table, column, definition) {
  const cols = (await all(`PRAGMA table_info(${table})`)).map(c => c.name);
  if (!cols.includes(column)) await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

let initPromise = null;
async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isTurso) {
      await exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    } else {
      await exec('PRAGMA foreign_keys = ON;');
    }

    await exec(`
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

    await addColumn('bookings', 'service_key', "TEXT DEFAULT ''");
    await addColumn('bookings', 'size_key', "TEXT DEFAULT ''");
    await addColumn('bookings', 'frequency_key', "TEXT DEFAULT ''");
    await addColumn('bookings', 'quote_required', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('bookings', 'payment_method', "TEXT DEFAULT ''");
    await addColumn('bookings', 'payment_reference', "TEXT DEFAULT ''");
    await addColumn('bookings', 'paid_at', "TEXT DEFAULT ''");
    await addColumn('bookings', 'promo_code', "TEXT DEFAULT ''");
    await addColumn('bookings', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');

    const bookingCols = await all('PRAGMA table_info(bookings)');
    const hadFollowups = bookingCols.some(c => c.name === 'followup_thanks_sent');
    await addColumn('bookings', 'completed_at', "TEXT DEFAULT ''");
    await addColumn('bookings', 'followup_thanks_sent', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('bookings', 'followup_rebook_sent', 'INTEGER NOT NULL DEFAULT 0');
    if (!hadFollowups) {
      await run("UPDATE bookings SET followup_thanks_sent = 1, followup_rebook_sent = 1 WHERE booking_status = 'completed'");
    }

    await exec(`
      CREATE TABLE IF NOT EXISTS email_optouts (
        email TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await addColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
    await addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('users', 'locked_until', "TEXT DEFAULT ''");

    await exec(`
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

    const existingSuper = await get("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1");
    if (!existingSuper) {
      const genPass = () => crypto.randomBytes(12).toString('base64url') + '!A9';
      const envSuperPass = String(process.env.INITIAL_ADMIN_PASSWORD || '').trim();
      const superPass = envSuperPass.length >= 8 ? envSuperPass : genPass();
      const creds = {
        super: superPass,
        admin: genPass(),
        maya: genPass(),
        david: genPass(),
        sofia: genPass(),
      };

      const insertSql = `
        INSERT OR IGNORE INTO users (name, email, password_hash, role, phone, service_areas, must_change_password)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `;
      await run(insertSql, 'Bovic Super Admin', 'superadmin@boviccleaning.com', bcrypt.hashSync(creds.super, 12), 'super_admin', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');
      await run(insertSql, 'Operations Admin', 'admin@boviccleaning.com', bcrypt.hashSync(creds.admin, 12), 'admin', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');
      await run(insertSql, 'Maya Carter', 'maya@boviccleaning.com', bcrypt.hashSync(creds.maya, 12), 'worker', '678-799-4634', 'Buckhead, Sandy Springs');
      await run(insertSql, 'David Brooks', 'david@boviccleaning.com', bcrypt.hashSync(creds.david, 12), 'worker', '678-799-4634', 'Roswell, Alpharetta');
      await run(insertSql, 'Sofia Morales', 'sofia@boviccleaning.com', bcrypt.hashSync(creds.sofia, 12), 'worker', '678-799-4634', 'Buckhead, Sandy Springs, Roswell, Alpharetta');

      if (!isTurso && !envSuperPass) {
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
        console.log('\n[FIRST RUN] Super Admin seeded (superadmin@boviccleaning.com). Use INITIAL_ADMIN_PASSWORD from environment to sign in & rotate password.\n');
      }
    } else {
      const weakDefaults = ['BovicSuper@2026', 'BovicAdmin@2026', 'BovicWorker@2026'];
      const allUsers = await all('SELECT id, password_hash, must_change_password FROM users');
      for (const u of allUsers) {
        if (!u.must_change_password && weakDefaults.some(pw => bcrypt.compareSync(pw, u.password_hash))) {
          await run('UPDATE users SET must_change_password = 1 WHERE id = ?', u.id);
        }
      }
    }
  })();
  return initPromise;
}

module.exports = {
  get,
  all,
  run,
  exec,
  init,
  DATA_DIR: dataDir,
  isTurso,
};
