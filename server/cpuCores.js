// The CPU cores this process may really use. os.cpus() lists the host's processors, which on Cloud Run is not the
// service's allotment (a 4-vCPU service reported 9, so telemetry's cpu_util read ~2.25x too low and admission control
// thought it had more room than it has). In order: SE_CPU_CORES (an explicit override), the cgroup CPU quota
// (v2 cpu.max, v1 cfs_quota_us / cfs_period_us), os.availableParallelism() (the affinity mask), os.cpus().length.
import fs from 'node:fs';
import os from 'node:os';

function read(path) { try { return fs.readFileSync(path, 'utf8').trim(); } catch { return null; } }

/** Cores granted by a cgroup quota, or null when there is no quota (or no cgroup). Exported for tests. */
export function cgroupCores(readFile = read) {
  const v2 = readFile('/sys/fs/cgroup/cpu.max');            // "400000 100000" or "max 100000"
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== 'max' && +quota > 0 && +period > 0) return +quota / +period;
    return null;
  }
  const quota = +readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), period = +readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  return quota > 0 && period > 0 ? quota / period : null;
}

/** Effective cores (may be fractional with a quota; at least 1 is reported when rounding for counts). */
export function effectiveCores(env = process.env, readFile = read) {
  const forced = Number(env.SE_CPU_CORES);
  if (forced > 0) return forced;
  const host = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0) || os.cpus().length || 1;
  const quota = cgroupCores(readFile);
  return quota ? Math.min(host, quota) : host;
}

let cached = null;
/** effectiveCores() of this process, read once. */
export const cores = () => (cached ??= effectiveCores());
