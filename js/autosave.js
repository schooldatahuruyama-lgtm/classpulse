// 変更をまとめて保存する自動保存。タイマーは引数で受け取る。
// 同時に動く save は最大 1 つ。失敗しても変更は持ったままで、一定時間後に再試行する。
export function createAutosaver({ save, delayMs, retryMs, maxWaitMs, onState, setTimeout, clearTimeout }) {
  let pending = null;   // まだ保存していない最新の内容
  let hasChange = false;
  let timer = null;
  let maxTimer = null;  // 最初の変更からの最大待ち時間
  let running = null;   // 保存中の Promise
  let failed = false;

  const notify = (state) => { if (onState) onState(state); };

  function cancelTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (maxTimer !== null) { clearTimeout(maxTimer); maxTimer = null; }
  }

  function schedule(ms) {
    cancelTimer();
    timer = setTimeout(() => { timer = null; run(); }, ms);
  }

  // 保存を 1 回始める（保存中なら、その完了を返す）。成否にかかわらず例外は投げない
  function run() {
    if (running) return running;
    if (!hasChange) return Promise.resolve();
    cancelTimer();
    const deck = pending;
    pending = null;
    hasChange = false;
    notify('saving');
    running = (async () => {
      try {
        // 同期で投げる save も失敗として扱う（running を確実に解除するため、必ず 1 回 await を挟む）
        await Promise.resolve().then(() => save(deck));
        failed = false;
      } catch {
        failed = true;
        // 保存中に新しい変更が入っていれば、そちらを残す
        if (!hasChange) { pending = deck; hasChange = true; }
      }
      running = null;
      if (failed) {
        notify('failed');
        schedule(retryMs);
      } else if (hasChange) {
        await run();
      } else {
        notify('saved');
      }
    })();
    return running;
  }

  return {
    touch(deck) {
      pending = deck;
      hasChange = true;
      if (running) return;
      // 連続編集で延びても、最初の変更から maxWaitMs 以内には保存を始める
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run(); }, delayMs);
      if (maxTimer === null && maxWaitMs > 0) {
        maxTimer = setTimeout(() => { maxTimer = null; run(); }, maxWaitMs);
      }
    },
    // すぐ保存して、終わる（失敗なら失敗する）まで待つ
    async flush() {
      cancelTimer();
      if (running) await running;
      while (hasChange) {
        await run();
        if (failed) return;
      }
    },
    // 失敗のあと、待たずにすぐ再試行する
    retry() {
      run();
    },
    hasPending() {
      return hasChange || running !== null;
    },
  };
}
