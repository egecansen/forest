import type { Cluster } from '../types';

const CHIP: Record<Cluster['state'], string> = {
  proposed: '· proposed', picked: '◇ picked', skipped: '– skipped', fixing: '⚒ fixing',
  verifying: '', green: '✅ green', 'app-bug': '🐞 app-bug', error: '⚠ error',
};

export function ClustersTab({ clusters }: { clusters: Cluster[] }) {
  if (clusters.length === 0) return <p className="field-note">no clusters yet — they appear after the cluster phase</p>;
  return (
    <table className="clusters-table">
      <thead><tr><th>cluster</th><th>bucket</th><th>tests</th><th>state</th></tr></thead>
      <tbody>
        {clusters.map((c) => (
          <tr key={c.id} className={`cluster-${c.state}`}>
            <td><span className="cluster-id">{c.id}</span> {c.title}</td>
            <td>{c.bucket}</td>
            <td>{c.tests.length === 1 ? c.tests[0] : `${c.tests.length} tests`}</td>
            <td>
              {c.state === 'verifying' ? `verifying ${c.passes ?? 0}/${c.runs ?? '?'}` : CHIP[c.state]}
              {c.note ? <span className="field-note"> · {c.note}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
