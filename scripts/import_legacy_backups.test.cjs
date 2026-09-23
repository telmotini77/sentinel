'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { opticalPlan, opticalRecord } = require('./import_legacy_backups.cjs');
const reading = { id: 1, sn: 'ONU001', timestamp: '2026-08-21T15:10:04.017Z',
  rx_power: -20, tx_power: 2, temperature: 40, voltage: 3.3, bias_current: 7 };
const source = (rows, test_data = false) => ({ test_data, tables: { optical_history: rows } });
test('merges readings by content rather than source IDs and deduplicates backups', () => {
  const plan = opticalPlan([source([reading]), source([{ ...reading, id: 55 }])], []);
  assert.equal(plan.unique, 1);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.duplicateBackupReadings, 1);
});
test('retains live values when a historical reading contradicts the same timestamp', () => {
  const plan = opticalPlan([source([reading])], [{ ...reading, rx_power: -19 }]);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.conflictingReadingsArchivedOnly, 1);
});
test('never activates test-database records or known obsolete Zabbix fixtures', () => {
  const plan = opticalPlan([source([reading], true), source([{ ...reading, sn: 'FHTTZAB0001' }])], []);
  assert.equal(plan.unique, 0);
  assert.equal(plan.testExcluded, 2);
});
test('recognizes equivalent timestamps and is idempotent after import', () => {
  const live = [{ ...reading, timestamp: '2026-08-21T10:10:04.017-05:00' }];
  const plan = opticalPlan([source([reading])], live);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.alreadyPresent, 1);
});
test('rejects malformed backup readings instead of silently coercing them', () => {
  assert.throws(() => opticalRecord({ ...reading, timestamp: 'bad date' }));
  assert.throws(() => opticalRecord({ ...reading, voltage: 'not a number' }));
});
