import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { parseSchedule } from '../lib/cron.js';
import { dueJobs, resultMessage } from './scheduler.js';

const job = (jobid: string, schedule: string) => ({ jobid, schedule, username: 'my_app_owner', parsed: parseSchedule(schedule) });
const state = () => ({ running: new Set<string>(), lastStart: new Map<string, number>() });
const ids = (jobs: { jobid: string }[]) => jobs.map((j) => j.jobid);

test('five-field jobs run once, when their minute starts', () => {
  const s = state();
  const jobs = [job('1', '*/5 * * * *'), job('2', '1 * * * *')];
  const at = Date.parse('2026-03-04T05:10:00.300Z');
  assert.deepEqual(ids(dueJobs(jobs, s, at, true, 4)), ['1']);
  assert.deepEqual(ids(dueJobs(jobs, s, at + 1000, false, 4)), []);
});

test('"N seconds" jobs run every N seconds from when they were first seen', () => {
  const s = state();
  const jobs = [job('1', '2 seconds')];
  const t = 1_000_000;
  assert.deepEqual(ids(dueJobs(jobs, s, t, false, 4)), []);
  assert.deepEqual(ids(dueJobs(jobs, s, t + 1000, false, 4)), []);
  assert.deepEqual(ids(dueJobs(jobs, s, t + 2000, false, 4)), ['1']);
});

test('a job still running is not started again, and the per-project limit holds', () => {
  const s = state();
  const jobs = [job('1', '* * * * *'), job('2', '* * * * *'), job('3', '* * * * *')];
  s.running.add('1');
  assert.deepEqual(ids(dueJobs(jobs, s, Date.parse('2026-01-01T00:00:00Z'), true, 2)), ['2']);
});

test('run messages look like pg_cron', () => {
  const r = (command: string, rowCount: number | null) => ({ command, rowCount }) as pg.QueryResult;
  assert.equal(resultMessage(r('SELECT', 1)), '1 row');
  assert.equal(resultMessage(r('SELECT', 3)), '3 rows');
  assert.equal(resultMessage(r('INSERT', 2)), 'INSERT 0 2');
  assert.equal(resultMessage([r('BEGIN', null), r('UPDATE', 4)]), 'UPDATE 4');
  assert.equal(resultMessage(r('VACUUM', null)), 'VACUUM');
});
