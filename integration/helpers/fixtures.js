// Per-adapter fixtures: seed → verify.
//
// Each entry exposes:
//   conn      — connection object to pass into the adapter
//   seed(c)   — install fresh tables / collections / keys + sample data
//   drop(c)   — wipe everything (so restore starts from blank state)
//   verify(c) → returns { ok, summary } so the orchestrator can decide pass/fail

const path = require('path');
const fs = require('fs');

// ============ MySQL ============
const mysqlConn = {
  host: '127.0.0.1', port: 33306, user: 'root', password: 'dbmigrator', database: 'testdb',
};

async function mysqlSeed() {
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection({ ...mysqlConn, multipleStatements: true });
  try {
    await c.query(`
      DROP TABLE IF EXISTS orders;
      DROP TABLE IF EXISTS users;
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        email VARCHAR(128) UNIQUE,
        joined DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        amount DECIMAL(10,2),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO users (name, email) VALUES ('Alice','a@x.com'),('Bob','b@x.com'),('Carol','c@x.com');
      INSERT INTO orders (user_id, amount) VALUES (1, 9.99),(1, 14.50),(2, 99.00);
    `);
  } finally { await c.end(); }
}
async function mysqlDrop() {
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection({ ...mysqlConn, multipleStatements: true });
  try { await c.query('DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS users;'); }
  finally { await c.end(); }
}
async function mysqlVerify() {
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection(mysqlConn);
  try {
    const [users] = await c.query('SELECT COUNT(*) AS n FROM users');
    const [orders] = await c.query('SELECT COUNT(*) AS n FROM orders');
    return { ok: users[0].n === 3 && orders[0].n === 3, summary: `users=${users[0].n} orders=${orders[0].n}` };
  } finally { await c.end(); }
}

// ============ PostgreSQL ============
const pgConn = {
  host: '127.0.0.1', port: 55432, user: 'postgres', password: 'dbmigrator', database: 'testdb',
};

async function pgSeed() {
  const { Client } = require('pg');
  const c = new Client(pgConn);
  await c.connect();
  try {
    await c.query(`
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        email VARCHAR(128) UNIQUE,
        joined TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        amount NUMERIC(10,2)
      );
      INSERT INTO users (name, email) VALUES ('Alice','a@x.com'),('Bob','b@x.com'),('Carol','c@x.com');
      INSERT INTO orders (user_id, amount) VALUES (1, 9.99),(1, 14.50),(2, 99.00);
    `);
  } finally { await c.end(); }
}
async function pgDrop() {
  const { Client } = require('pg');
  const c = new Client(pgConn);
  await c.connect();
  try { await c.query('DROP TABLE IF EXISTS orders CASCADE; DROP TABLE IF EXISTS users CASCADE;'); }
  finally { await c.end(); }
}
async function pgVerify() {
  const { Client } = require('pg');
  const c = new Client(pgConn);
  await c.connect();
  try {
    const u = await c.query('SELECT COUNT(*)::int AS n FROM users');
    const o = await c.query('SELECT COUNT(*)::int AS n FROM orders');
    return { ok: u.rows[0].n === 3 && o.rows[0].n === 3, summary: `users=${u.rows[0].n} orders=${o.rows[0].n}` };
  } finally { await c.end(); }
}

// ============ SQL Server ============
const mssqlConn = {
  host: '127.0.0.1', port: 11433, user: 'sa', password: 'DbMigrator!1', database: 'master',
};

async function mssqlSeed() {
  const mssql = require('mssql');
  const pool = await mssql.connect({
    user: 'sa', password: 'DbMigrator!1', server: '127.0.0.1', port: 11433, database: 'master',
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().batch(`
      IF DB_ID('testdb') IS NULL CREATE DATABASE testdb;
    `);
  } finally { await pool.close(); }
  const dbPool = await mssql.connect({
    user: 'sa', password: 'DbMigrator!1', server: '127.0.0.1', port: 11433, database: 'testdb',
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await dbPool.request().batch(`
      IF OBJECT_ID('dbo.orders', 'U') IS NOT NULL DROP TABLE dbo.orders;
      IF OBJECT_ID('dbo.users', 'U') IS NOT NULL DROP TABLE dbo.users;
      CREATE TABLE dbo.users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        email VARCHAR(128),
        joined DATETIME DEFAULT GETDATE()
      );
      CREATE TABLE dbo.orders (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT FOREIGN KEY REFERENCES dbo.users(id),
        amount DECIMAL(10,2)
      );
      SET IDENTITY_INSERT dbo.users ON;
      INSERT INTO dbo.users (id, name, email) VALUES (1,'Alice','a@x.com'),(2,'Bob','b@x.com'),(3,'Carol','c@x.com');
      SET IDENTITY_INSERT dbo.users OFF;
      INSERT INTO dbo.orders (user_id, amount) VALUES (1, 9.99),(1, 14.50),(2, 99.00);
    `);
  } finally { await dbPool.close(); }
}
async function mssqlDrop() {
  const mssql = require('mssql');
  const pool = await mssql.connect({
    user: 'sa', password: 'DbMigrator!1', server: '127.0.0.1', port: 11433, database: 'testdb',
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().batch(`
      IF OBJECT_ID('dbo.orders', 'U') IS NOT NULL DROP TABLE dbo.orders;
      IF OBJECT_ID('dbo.users', 'U') IS NOT NULL DROP TABLE dbo.users;
    `);
  } finally { await pool.close(); }
}
async function mssqlVerify() {
  const mssql = require('mssql');
  const pool = await mssql.connect({
    user: 'sa', password: 'DbMigrator!1', server: '127.0.0.1', port: 11433, database: 'testdb',
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    const u = (await pool.request().query('SELECT COUNT(*) AS n FROM users')).recordset[0].n;
    const o = (await pool.request().query('SELECT COUNT(*) AS n FROM orders')).recordset[0].n;
    return { ok: u === 3 && o === 3, summary: `users=${u} orders=${o}` };
  } finally { await pool.close(); }
}

// ============ SQLite (no container — local file) ============
const sqliteFile = path.join(__dirname, '..', 'sqlite-test.db');
const sqliteConn = { path: sqliteFile };

async function sqliteSeed() {
  if (fs.existsSync(sqliteFile)) fs.unlinkSync(sqliteFile);
  const Database = require('better-sqlite3');
  const db = new Database(sqliteFile);
  try {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        amount REAL
      );
      INSERT INTO users (name, email) VALUES ('Alice','a@x.com'),('Bob','b@x.com'),('Carol','c@x.com');
      INSERT INTO orders (user_id, amount) VALUES (1, 9.99),(1, 14.50),(2, 99.00);
    `);
  } finally { db.close(); }
}
async function sqliteDrop() {
  if (fs.existsSync(sqliteFile)) fs.unlinkSync(sqliteFile);
}
async function sqliteVerify() {
  const Database = require('better-sqlite3');
  const db = new Database(sqliteFile);
  try {
    const u = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const o = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    return { ok: u === 3 && o === 3, summary: `users=${u} orders=${o}` };
  } finally { db.close(); }
}

// ============ MongoDB ============
const mongoConn = { host: '127.0.0.1', port: 27017, database: 'testdb' };

async function mongoSeed() {
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(`mongodb://127.0.0.1:27017`);
  await c.connect();
  try {
    const db = c.db('testdb');
    await db.dropDatabase();
    await db.collection('users').insertMany([
      { _id: 1, name: 'Alice', email: 'a@x.com' },
      { _id: 2, name: 'Bob',   email: 'b@x.com' },
      { _id: 3, name: 'Carol', email: 'c@x.com' },
    ]);
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('orders').insertMany([
      { user_id: 1, amount: 9.99 },
      { user_id: 1, amount: 14.50 },
      { user_id: 2, amount: 99.00 },
    ]);
  } finally { await c.close(); }
}
async function mongoDrop() {
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(`mongodb://127.0.0.1:27017`);
  await c.connect();
  try { await c.db('testdb').dropDatabase(); }
  finally { await c.close(); }
}
async function mongoVerify() {
  const { MongoClient } = require('mongodb');
  const c = new MongoClient(`mongodb://127.0.0.1:27017`);
  await c.connect();
  try {
    const db = c.db('testdb');
    const u = await db.collection('users').countDocuments();
    const o = await db.collection('orders').countDocuments();
    return { ok: u === 3 && o === 3, summary: `users=${u} orders=${o}` };
  } finally { await c.close(); }
}

// ============ Redis ============
const redisConn = { host: '127.0.0.1', port: 6379, database: '0' };

async function redisSeed() {
  const Redis = require('ioredis');
  const c = new Redis({ host: '127.0.0.1', port: 6379 });
  try {
    await c.flushdb();
    await c.set('user:1:name', 'Alice');
    await c.set('user:2:name', 'Bob');
    await c.set('user:3:name', 'Carol');
    await c.hset('order:1', 'user', '1', 'amount', '9.99');
    await c.hset('order:2', 'user', '1', 'amount', '14.50');
    await c.hset('order:3', 'user', '2', 'amount', '99.00');
    await c.sadd('active_users', 'Alice', 'Bob');
  } finally { c.disconnect(); }
}
async function redisDrop() {
  const Redis = require('ioredis');
  const c = new Redis({ host: '127.0.0.1', port: 6379 });
  try { await c.flushdb(); }
  finally { c.disconnect(); }
}
async function redisVerify() {
  const Redis = require('ioredis');
  const c = new Redis({ host: '127.0.0.1', port: 6379 });
  try {
    const n = (await c.keys('*')).length;
    const a = await c.get('user:1:name');
    return { ok: n === 7 && a === 'Alice', summary: `keys=${n} user:1:name=${a}` };
  } finally { c.disconnect(); }
}

// ============ Registry ============
module.exports = {
  mysql:    { name: 'mysql',    conn: mysqlConn,  seed: mysqlSeed,  drop: mysqlDrop,  verify: mysqlVerify },
  postgres: { name: 'postgres', conn: pgConn,     seed: pgSeed,     drop: pgDrop,     verify: pgVerify },
  mssql:    { name: 'mssql',    conn: { ...mssqlConn, database: 'testdb' }, seed: mssqlSeed, drop: mssqlDrop, verify: mssqlVerify },
  sqlite:   { name: 'sqlite',   conn: sqliteConn, seed: sqliteSeed, drop: sqliteDrop, verify: sqliteVerify },
  mongo:    { name: 'mongo',    conn: mongoConn,  seed: mongoSeed,  drop: mongoDrop,  verify: mongoVerify },
  redis:    { name: 'redis',    conn: redisConn,  seed: redisSeed,  drop: redisDrop,  verify: redisVerify },
};
