#!/usr/bin/env node
/* Preserve every audited record, and merge missing genuine optical history.
 * Inventory snapshots, credentials, queue events and test fixtures are archived
 * only: replaying them into a live SmartOLT deployment changes current state.
 * Usage: node import_legacy_backups.cjs bundle.json [--apply]
 * Requires DATABASE_URL from the API container; defaults to read-only dry-run.
 */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const archive = 'backup_archive';
const schema = 'zasmaolt';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const serial = value => String(value ?? '').trim().toUpperCase();
function opticalRecord(row) {
  const sn = serial(row.sn);
  const time = Date.parse(row.timestamp);
  if (!sn || !Number.isFinite(time)) throw new Error('Invalid optical serial/timestamp');
  const value = { sn, timestamp: new Date(time).toISOString() };
  for (const field of ['rx_power', 'tx_power', 'temperature', 'voltage', 'bias_current']) {
    const raw = row[field];
    if (raw == null) value[field] = null;
    else if (typeof raw === 'number' && Number.isFinite(raw)) value[field] = raw;
    else throw new Error(`Invalid optical number: ${field}`);
  }
  return value;
}
const opticalKey = value => JSON.stringify(opticalRecord(value));
const opticalIdentity = row => JSON.stringify([serial(row.sn), new Date(row.timestamp).toISOString()]);
const isTestSerial = sn => /^FHTTZAB/i.test(String(sn ?? ''));

function opticalPlan(sources, live) {
  const unique = new Map();
  let appearances = 0;
  let testExcluded = 0;
  for (const source of sources) {
    for (const row of source.tables.optical_history || []) {
      if (source.test_data || isTestSerial(row.sn)) { testExcluded++; continue; }
      appearances++;
      const normalized = opticalRecord(row);
      unique.set(opticalKey(normalized), normalized);
    }
  }
  const liveKeys = new Set(live.map(opticalKey));
  const liveIds = new Set(live.map(opticalIdentity));
  const missing = [];
  let present = 0, conflicts = 0;
  for (const [key, row] of unique) {
    if (liveKeys.has(key)) present++;
    else if (liveIds.has(opticalIdentity(row))) conflicts++;
    else missing.push(row);
  }
  return { appearances, unique: unique.size, duplicateBackupReadings: appearances - unique.size,
    testExcluded, alreadyPresent: present, conflictingReadingsArchivedOnly: conflicts, missing };
}

function sourceKey(source, files) {
  return hash(JSON.stringify([source.name, source.logical_sha256,
    files.filter(f => f.name === source.name || f.name.startsWith(source.name + '-'))]));
}

async function archiveSources(client, bundle) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${archive}`);
  await client.query(`REVOKE ALL ON SCHEMA ${archive} FROM PUBLIC`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${archive}.sources (
    source_key TEXT PRIMARY KEY, file_name TEXT NOT NULL, logical_sha256 TEXT NOT NULL,
    is_test BOOLEAN NOT NULL, manifest JSONB NOT NULL, definitions JSONB NOT NULL,
    row_counts JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${archive}.records (
    source_key TEXT NOT NULL REFERENCES ${archive}.sources(source_key),
    table_name TEXT NOT NULL, row_index INTEGER NOT NULL, payload JSONB NOT NULL,
    PRIMARY KEY (source_key, table_name, row_index))`);
  let inserted = 0;
  for (const source of bundle.sources) {
    const key = sourceKey(source, bundle.files);
    const manifest = bundle.files.filter(f => f.name === source.name || f.name.startsWith(source.name + '-'));
    await client.query(`INSERT INTO ${archive}.sources
      (source_key,file_name,logical_sha256,is_test,manifest,definitions,row_counts)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT DO NOTHING`,
      [key, source.name, source.logical_sha256, source.test_data, JSON.stringify(manifest),
        JSON.stringify(source.definitions || {}),
        JSON.stringify(Object.fromEntries(Object.entries(source.tables).map(([name, rows]) => [name, rows.length]))) ]);
    for (const [name, rows] of Object.entries(source.tables)) {
      for (let offset = 0; offset < rows.length; offset += 400) {
        const batch = rows.slice(offset, offset + 400).map((payload, i) => ({ index: offset + i, payload }));
        const result = await client.query(`INSERT INTO ${archive}.records (source_key,table_name,row_index,payload)
          SELECT $1,$2,x.index,x.payload FROM jsonb_to_recordset($3::jsonb) AS x(index INTEGER,payload JSONB)
          ON CONFLICT DO NOTHING`, [key, name, JSON.stringify(batch)]);
        inserted += result.rowCount;
      }
      const check = await client.query(`SELECT row_index,payload FROM ${archive}.records
        WHERE source_key=$1 AND table_name=$2 ORDER BY row_index`, [key, name]);
      if (check.rowCount !== rows.length) throw new Error(`Archive row count mismatch: ${source.name}/${name}`);
      const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
      if (stable(check.rows.map(r => r.payload)) !== stable(rows)) {
        throw new Error(`Archive payload mismatch: ${source.name}/${name}`);
      }
    }
  }
  return inserted;
}

async function inventoryReport(client, sources) {
  const live = (await client.query(`SELECT name,display_name,smartolt_account_id,olt_id,clients FROM ${schema}.naps`)).rows;
  const names = new Set(live.map(n => serial(n.display_name || n.name)));
  const currentSNs = new Set(live.flatMap(n => (n.clients || []).map(c => serial(c.sn))));
  const oldNames = new Set();
  const oldSNs = new Set();
  for (const source of sources.filter(s => !s.test_data)) {
    for (const row of source.tables.naps || []) {
      oldNames.add(serial(row.display_name || row.name));
      const clients = typeof row.clients === 'string' ? JSON.parse(row.clients) : row.clients || [];
      for (const c of clients) if (serial(c.sn)) oldSNs.add(serial(c.sn));
    }
  }
  return { currentNaps: live.length, backupDistinctNames: oldNames.size,
    backupNamesPresentInCurrentInventory: [...oldNames].filter(n => names.has(n)).length,
    backupDistinctClientSerials: oldSNs.size,
    backupClientSerialsPresentInCurrentInventory: [...oldSNs].filter(sn => currentSNs.has(sn)).length,
    action: 'All legacy inventory snapshots archived; current SmartOLT inventory retained without changes.' };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Provide the audited bundle JSON');
  const content = fs.readFileSync(path);
  const bundle = JSON.parse(content);
  if (bundle.format !== 1 || !Array.isArray(bundle.sources)) throw new Error('Unsupported bundle');
  const apply = process.argv.includes('--apply');
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const target = new URL(process.env.DATABASE_URL);
  if (decodeURIComponent(target.pathname) !== '/omniSentinel_db' || target.hostname !== 'postgres') {
    throw new Error('Expected the audited Docker postgres/omniSentinel_db destination');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    const inventory = await inventoryReport(client, bundle.sources);
    const before = Number((await client.query(`SELECT count(*) AS total FROM ${schema}.optical_history`)).rows[0].total);
    let archived = 0;
    if (apply) {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(7162026, 916) AS locked');
      if (!lock.rows[0].locked) throw new Error('Another import is already running');
      archived = await archiveSources(client, bundle);
      await client.query(`LOCK TABLE ${schema}.optical_history IN SHARE ROW EXCLUSIVE MODE`);
    }
    const current = (await client.query(`SELECT sn,rx_power,tx_power,temperature,voltage,bias_current,timestamp FROM ${schema}.optical_history`)).rows;
    const plan = opticalPlan(bundle.sources, current);
    let inserted = 0;
    if (apply) {
      for (let offset = 0; offset < plan.missing.length; offset += 400) {
        const batch = plan.missing.slice(offset, offset + 400);
        const result = await client.query(`INSERT INTO ${schema}.optical_history
          (sn,rx_power,tx_power,temperature,voltage,bias_current,timestamp)
          SELECT sn,rx_power,tx_power,temperature,voltage,bias_current,timestamp
          FROM jsonb_to_recordset($1::jsonb) AS x(sn TEXT,rx_power DOUBLE PRECISION,
          tx_power DOUBLE PRECISION,temperature DOUBLE PRECISION,voltage DOUBLE PRECISION,
          bias_current DOUBLE PRECISION,timestamp TEXT)`, [JSON.stringify(batch)]);
        inserted += result.rowCount;
      }
      const after = (await client.query(`SELECT sn,rx_power,tx_power,temperature,voltage,bias_current,timestamp FROM ${schema}.optical_history`)).rows;
      if (opticalPlan(bundle.sources, after).missing.length) throw new Error('Post-import verification failed');
      if (after.length !== current.length + inserted) throw new Error('Unexpected optical row count');
    }
    const expectedArchiveRows = bundle.sources.reduce((total, s) => total + Object.values(s.tables).reduce((n, rows) => n + rows.length, 0), 0);
    const { missing, ...planSummary } = plan;
    const report = { mode: apply ? 'apply' : 'dry-run', bundleSha256: hash(content),
      destination: { host: target.hostname, database: 'omniSentinel_db', schema },
      sourceFiles: bundle.files.length, logicalSources: bundle.sources.length,
      archive: { schema: archive, expectedRows: expectedArchiveRows, insertedRows: archived,
        verifiedEveryPayload: apply },
      optical: { before, ...planSummary, missing: missing.length, inserted }, inventory,
      otherData: 'History, configuration, counters, outbox and test data preserved only in the archive; no old events replayed.',
      omniSentinel: 'No OmniSentinel public-schema backup is present; public tables are unchanged.' };
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { opticalRecord, opticalKey, opticalPlan, sourceKey };
if (require.main === module) main().catch(error => {
  console.error('Import failed:', error.message);
  process.exitCode = 1;
});
