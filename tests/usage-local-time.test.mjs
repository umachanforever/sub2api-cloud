import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTime } from '../web/usage/time.js';

test('usage timestamps describe the same instant in the selected local zone', () => {
  const instant = '2026-10-16T11:37:32.000Z';
  assert.match(formatTime(instant, 'Asia/Shanghai'), /19:37:32/);
  assert.match(formatTime(instant, 'America/New_York'), /07:37:32/);
  assert.match(formatTime(instant, 'UTC'), /11:37:32/);
  assert.equal(formatTime(instant, 'Asia/Shanghai'), formatTime('2026-10-16T19:37:32+08:00', 'Asia/Shanghai'));
  assert.equal(formatTime(null, 'UTC'), '未知');
  assert.equal(formatTime('invalid', 'UTC'), '未知');
});
