import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readContainerMemory, memoryPressure, watchContainerMemory } from '../lib/resource-guard.mjs';

const MIB = 1024 * 1024;
const reader = files => async path => {
  if (!Object.hasOwn(files, path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return files[path];
};

test('container memory reads v2 and v1 limits, never host total memory', async () => {
  assert.deepEqual(await readContainerMemory({ platform: 'linux', readFile: reader({
    '/sys/fs/cgroup/memory.max': String(512 * MIB), '/sys/fs/cgroup/memory.current': String(200 * MIB),
  }) }), { limitBytes: 512 * MIB, usageBytes: 200 * MIB });
  assert.deepEqual(await readContainerMemory({ platform: 'linux', readFile: reader({
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(1024 * MIB), '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(100 * MIB),
  }) }), { limitBytes: 1024 * MIB, usageBytes: 100 * MIB });
});

test('cgroup v2 diagnostics retain only safe numeric memory.stat fields', async () => {
  const snapshot = await readContainerMemory({ platform: 'linux', readFile: reader({
    '/sys/fs/cgroup/memory.max': String(512 * MIB), '/sys/fs/cgroup/memory.current': String(390 * MIB),
    '/sys/fs/cgroup/memory.stat': 'anon 123\nfile 456\ninactive_file 300\nfile_dirty 7\nfile_writeback 8\nkernel 10\n'
      + 'slab_reclaimable 11\nactive_file -1\nshmem 1.5\nsecret_url https://private.example/\nunknown_counter 999\nswapcached 9223372036854771712\n',
  }) });
  assert.deepEqual(snapshot.breakdown, { anon: 123, file: 456, inactive_file: 300, file_dirty: 7, file_writeback: 8, kernel: 10, slab_reclaimable: 11 });
  assert.equal(memoryPressure(snapshot).exceeded, true);
  assert.equal(memoryPressure(snapshot).thresholdBytes, 384 * MIB);
  assert.deepEqual(memoryPressure(snapshot).breakdown, snapshot.breakdown);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|unknown_counter/);
});

test('cgroup v1 diagnostics map hierarchical counters and tolerate missing memory.stat', async () => {
  const files = {
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(512 * MIB), '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(390 * MIB),
    '/sys/fs/cgroup/memory/memory.stat': 'rss 1\ntotal_rss 123\ncache 2\ntotal_cache 456\ninactive_file 3\ntotal_inactive_file 300\n'
      + 'total_active_file 156\ntotal_dirty 7\nwriteback 8\ntotal_shmem 9\nswapcached 10\n',
  };
  const snapshot = await readContainerMemory({ platform: 'linux', readFile: reader(files) });
  assert.deepEqual(snapshot.breakdown, { anon: 123, file: 456, inactive_file: 300, active_file: 156,
    shmem: 9, file_dirty: 7, file_writeback: 8, swapcached: 10 });
  delete files['/sys/fs/cgroup/memory/memory.stat'];
  const withoutStat = await readContainerMemory({ platform: 'linux', readFile: reader(files) });
  assert.deepEqual(withoutStat, { limitBytes: 512 * MIB, usageBytes: 390 * MIB });
  assert.equal(memoryPressure(withoutStat).exceeded, true);
});

test('diagnostic snapshot data cannot change the threshold or inject text into limit logs', () => {
  const pressure = memoryPressure({ limitBytes: 512 * MIB, usageBytes: 390 * MIB,
    breakdown: { anon: 100, inactive_file: 380 * MIB, file: 'private-token', kernel: -1, secret: 'private-value' } });
  assert.deepEqual(pressure.breakdown, { anon: 100, inactive_file: 380 * MIB });
  assert.equal(pressure.exceeded, true);
  assert.equal(pressure.thresholdBytes, 384 * MIB);
  assert.doesNotMatch(JSON.stringify(pressure), /private|secret/);
});

test('unlimited, missing, malformed and non-Linux cgroups disable the guard', async () => {
  for (const limit of ['max', '9223372036854771712', '-1', 'NaN', '0', '512MB']) {
    assert.equal(await readContainerMemory({ platform: 'linux', readFile: reader({
      '/sys/fs/cgroup/memory.max': limit, '/sys/fs/cgroup/memory.current': '123',
    }) }), null);
  }
  for (const usage of ['max', '-1', 'NaN', '512MB']) {
    assert.equal(await readContainerMemory({ platform: 'linux', readFile: reader({
      '/sys/fs/cgroup/memory.max': String(512 * MIB), '/sys/fs/cgroup/memory.current': usage,
    }) }), null);
  }
  assert.equal(await readContainerMemory({ platform: 'linux', readFile: reader({}) }), null);
  assert.equal(await readContainerMemory({ platform: 'win32', readFile: () => assert.fail('must not read Linux paths') }), null);
});

test('memory headroom reserves 128 MiB or 15 percent, whichever is larger', () => {
  assert.equal(memoryPressure({ limitBytes: 512 * MIB, usageBytes: 384 * MIB }).exceeded, true);
  assert.equal(memoryPressure({ limitBytes: 512 * MIB, usageBytes: 384 * MIB - 1 }).exceeded, false);
  assert.equal(memoryPressure({ limitBytes: 1024 * MIB, usageBytes: 0 }).thresholdBytes, Math.floor(1024 * MIB * 0.85));
  assert.equal(memoryPressure({ limitBytes: 64 * MIB, usageBytes: 0 }).exceeded, true);
  for (const value of [null, {}, { limitBytes: Infinity, usageBytes: 0 }, { limitBytes: 512 * MIB, usageBytes: -1 }]) {
    assert.equal(memoryPressure(value), null);
  }
});

test('crossing the limit invokes one reclamation callback and stops polling', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  let calls = 0;
  let reads = 0;
  let stop;
  try {
    await once(child, 'spawn');
    const closed = once(child, 'close');
    stop = watchContainerMemory(pressure => {
      calls++;
      assert.equal(pressure.thresholdBytes, 384 * MIB);
      child.kill();
    }, { intervalMs: 10, readMemory: async () => ({ limitBytes: 512 * MIB, usageBytes: ++reads === 1 ? 100 * MIB : 390 * MIB }) });
    await closed;
    const finishedReads = reads;
    await delay(35);
    assert.equal(calls, 1);
    assert.equal(reads, finishedReads);
    assert.equal(child.killed, true);
  } finally { stop?.(); child.kill(); }
});

test('polling is non-overlapping and disposal suppresses a pending high-memory read', { timeout: 3000 }, async () => {
  const keepAlive = setInterval(() => {}, 1000);
  let release;
  let announce;
  let reads = 0;
  let calls = 0;
  const started = new Promise(resolve => { announce = resolve; });
  const stop = watchContainerMemory(() => { calls++; }, { intervalMs: 10, readMemory: () => {
    reads++;
    announce();
    return new Promise(resolve => { release = resolve; });
  } });
  try {
    await started;
    await delay(35);
    assert.equal(reads, 1);
    stop();
    release({ limitBytes: 512 * MIB, usageBytes: 500 * MIB });
    await delay(35);
    assert.equal(calls, 0);
    assert.equal(reads, 1);
  } finally { stop(); clearInterval(keepAlive); }
});

test('transient read errors and invalid usage never cause false memory reclamation', { timeout: 3000 }, async () => {
  const keepAlive = setInterval(() => {}, 1000);
  let reads = 0;
  let done;
  const reached = new Promise(resolve => { done = resolve; });
  const stop = watchContainerMemory(() => assert.fail('invalid readings must not stop a renderer'), { intervalMs: 10, readMemory: async () => {
    reads++;
    if (reads === 1) throw new Error('temporary cgroup read failure');
    if (reads === 2) return { limitBytes: 512 * MIB, usageBytes: NaN };
    done();
    return { limitBytes: 512 * MIB, usageBytes: 100 * MIB };
  } });
  try { await reached; assert.equal(reads, 3); } finally { stop(); clearInterval(keepAlive); }
});
