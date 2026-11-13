// 実際の時間を待たずに、期限の順にタイマーを進める
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function fakeScheduler(start = 0) {
  let time = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get count() { return pending.size; },
    delays: () => [...pending.values()].map((t) => t.at - time),
    async advance(ms) {
      const end = time + ms;
      await flush();
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, task] = next;
        time = task.at;
        pending.delete(id);
        task.fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}
