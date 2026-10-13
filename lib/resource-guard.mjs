import fs from 'node:fs/promises';

const MIB = 1024 * 1024;
const layouts = [
  ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
  ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
];

function bytes(value) {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function memoryPressure(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.limitBytes) || snapshot.limitBytes <= 0
    || !Number.isSafeInteger(snapshot.usageBytes) || snapshot.usageBytes < 0) return null;
  const thresholdBytes = Math.max(0, Math.floor(Math.min(snapshot.limitBytes * 0.85, snapshot.limitBytes - 128 * MIB)));
  return { limitBytes: snapshot.limitBytes, usageBytes: snapshot.usageBytes, thresholdBytes,
    exceeded: snapshot.usageBytes >= thresholdBytes };
}

// A container shares the host's os.totalmem(); only cgroup limits describe the
// memory it can actually use. v1's huge unlimited sentinel is not a safe integer.
export async function readContainerMemory({ platform = process.platform, readFile = fs.readFile } = {}) {
  if (platform !== 'linux') return null;
  for (const [limitPath, usagePath] of layouts) {
    let rawLimit;
    try { rawLimit = await readFile(limitPath, 'utf8'); } catch { continue; }
    const limitBytes = bytes(rawLimit);
    if (limitBytes === null || limitBytes === 0) return null;
    try {
      const usageBytes = bytes(await readFile(usagePath, 'utf8'));
      return usageBytes === null ? null : { limitBytes, usageBytes };
    } catch { return null; }
  }
  return null;
}

// Schedule after each read finishes, so a slow cgroup filesystem never creates
// concurrent polling. Disposal also invalidates an already pending read.
export function watchContainerMemory(onLimit, { readMemory = readContainerMemory, intervalMs = 150 } = {}) {
  let stopped = false;
  let timer;
  const delay = Number.isFinite(intervalMs) ? Math.max(10, intervalMs) : 150;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const schedule = () => { timer = setTimeout(check, delay); timer.unref?.(); };
  async function check() {
    if (stopped) return;
    let pressure;
    try { pressure = memoryPressure(await readMemory()); } catch { /* A failed read is not an OOM. */ }
    if (stopped) return;
    if (pressure?.exceeded) {
      stop();
      onLimit(pressure);
    } else schedule();
  }
  schedule();
  return stop;
}
