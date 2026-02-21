/**
 * pool.js — PostgreSQL connection pool (singleton)
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const { Pool } = require('pg');

const isRemote = process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('localhost') &&
    !process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/civicpulse',
    ssl: isRemote ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;
