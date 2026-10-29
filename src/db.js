'use strict';

const mysql = require('mysql2/promise');

// Times are stored as BIGINT milliseconds since epoch to stay clear of
// server/database timezone differences on shared hosting.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owners (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    auth_hash VARCHAR(255) NOT NULL,
    public_id CHAR(32) NOT NULL UNIQUE,
    wrapped_key TEXT NOT NULL,
    ciphertext MEDIUMTEXT NOT NULL,
    threshold TINYINT UNSIGNED NOT NULL DEFAULT 0,
    interval_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    grace_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    last_signal_at BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'active',
    state_since BIGINT NOT NULL,
    last_reminder_at BIGINT NULL,
    released_at BIGINT NULL,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    owner_id INT UNSIGNED NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX (owner_id),
    FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
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
}

module.exports = { createPool, migrate };
