'use strict';

const mysql = require('mysql2/promise');

// Times are stored as BIGINT milliseconds since epoch to stay clear of
// server/database timezone differences on shared hosting.
// ROW_FORMAT=DYNAMIC keeps the utf8mb4 UNIQUE(email) index legal on older
// MySQL/MariaDB defaults (255 × 4 bytes exceeds the old 767-byte limit).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owners (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    kdf_iterations INT UNSIGNED NOT NULL DEFAULT 600000,
    auth_hash VARCHAR(255) NOT NULL,
    public_id CHAR(32) NOT NULL UNIQUE,
    wrapped_key TEXT NOT NULL,
    ciphertext MEDIUMTEXT NOT NULL,
    vault_version INT UNSIGNED NOT NULL DEFAULT 1,
    threshold TINYINT UNSIGNED NOT NULL DEFAULT 0,
    interval_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    grace_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    last_signal_at BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'active',
    state_since BIGINT NOT NULL,
    notified_stage VARCHAR(16) NOT NULL DEFAULT 'active',
    announce_claimed_at BIGINT NULL,
    last_reminder_at BIGINT NULL,
    released_at BIGINT NULL,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS keepers (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL,
    share_index TINYINT UNSIGNED NOT NULL,
    encrypted_share TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX (owner_id),
    FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    owner_id INT UNSIGNED NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX (owner_id),
    INDEX (expires_at),
    FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC`,
];

// Columns added after the first release. Fresh installs get them from SCHEMA;
// existing databases get them here on the next start. Append, never edit.
const COLUMNS = [
  ['owners', 'kdf_iterations', 'INT UNSIGNED NOT NULL DEFAULT 600000'],
  ['owners', 'vault_version', 'INT UNSIGNED NOT NULL DEFAULT 1'],
  ['owners', 'notified_stage', "VARCHAR(16) NOT NULL DEFAULT 'active'"],
  ['owners', 'announce_claimed_at', 'BIGINT NULL'],
];

function createPool(dbConfig) {
  return mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5, // shared hosting plans cap concurrent connections
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

async function migrate(pool) {
  for (const sql of SCHEMA) await pool.query(sql);
  for (const [table, column, definition] of COLUMNS) {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column],
    );
    if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

module.exports = { createPool, migrate };
