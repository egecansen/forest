import type { ConsoleConfig } from '../console-config.js';
import { fetchJobBuilds, type JenkinsBuild } from './jenkins.js';
import { fetchBuildFailInfo, sReportUrl } from './es.js';

export interface BuildRow extends JenkinsBuild { failedCount: number; reportUrl: string | null; }

export class BuildsPoller {
  private builds: BuildRow[] = [];
  private fetchedAt: number | null = null;
  private stale = false;
  private timer: NodeJS.Timeout | null = null;
  /** Finished builds' ES info never changes — cache by jobName#number. */
  private esCache = new Map<string, { failedCount: number; reportUrl: string | null }>();

  /** Set by index.ts; called at the end of every successful/failed refreshNow(). */
  onRefresh: ((data: ReturnType<BuildsPoller['getBuilds']>) => void) | null = null;

  constructor(private cfg: ConsoleConfig, private fetchImpl: typeof fetch = fetch) {}

  setClientCount(n: number) {
    if (n > 0 && !this.timer) {
      this.timer = setInterval(() => void this.refreshNow(), this.cfg.pollMs);
      void this.refreshNow();
    } else if (n === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getBuilds() { return { builds: this.builds, fetchedAt: this.fetchedAt, stale: this.stale }; }

  async refreshNow(): Promise<void> {
    try {
      const arrays = await Promise.all(
        this.cfg.jenkins.jobUrls.map((u) => fetchJobBuilds(this.cfg.jenkins, u, this.fetchImpl))
      );
      const all = arrays.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, 25);
      this.builds = await Promise.all(all.map(async (b) => {
        const key = `${b.jobName}#${b.number}`;
        let es = !b.building ? this.esCache.get(key) : undefined;
        if (!es) {
          const info = await fetchBuildFailInfo(this.cfg.es, b.jobName, b.number, this.fetchImpl);
          es = {
            failedCount: info.failedCount,
            reportUrl: info.testBuildName
              ? sReportUrl(this.cfg.reportBase, b.jobName, b.number, b.timestamp, info.testBuildName)
              : null,
          };
          if (!b.building && info.testBuildName) this.esCache.set(key, es);
        }
        return { ...b, ...es };
      }));
      this.fetchedAt = Date.now();
      this.stale = false;
    } catch {
      this.stale = true;  // keep last data — the board degrades, never blanks
    }
    this.onRefresh?.(this.getBuilds());
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
