export function createJournal({ max = 200 } = {}) {
  const entries = [];
  const subs = new Set();

  function add(entry) {
    const stored = { ts: Date.now(), ...entry };
    entries.push(stored);
    while (entries.length > max) entries.shift();
    for (const fn of subs) fn(stored);
    return stored;
  }

  function recent() {
    return entries.slice();
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  return { add, recent, subscribe };
}
