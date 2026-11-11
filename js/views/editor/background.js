// アプリで 1 つだけの「画面を離れたあとの保存」。編集画面と授業ダッシュボード（削除）で共有する。
// 今ログインしている先生は、画面から渡された auth（useAuth）で確かめる。
import { CONFIG } from '../../config.js';
import { toast } from '../../ui.js';
import { createBackgroundSaver } from './background-save.js';

let saver = null;
let auth = null;

// 先生の auth を覚える（画面を開くたびに呼ぶ。同じアプリでは同じもの）
export function useAuth(a) {
  if (a) auth = a;
}

function onUnload(ev) {
  ev.preventDefault();
  ev.returnValue = '';
}

export function backgroundSaver() {
  if (!saver) {
    saver = createBackgroundSaver({
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (t) => window.clearTimeout(t),
      retryMs: CONFIG.autosaveRetryMs,
      getCurrentUid: () => (auth && auth.user ? auth.user.uid : null),
      onGuard: (on) => {
        if (on) window.addEventListener('beforeunload', onUnload);
        else window.removeEventListener('beforeunload', onUnload);
      },
      onEvent: (kind, title) => {
        if (kind === 'saved') toast('保存しました。');
        else toast(`「${title}」の変更をまだ保存できていません。通信が戻ると自動で保存します。`);
      },
    });
  }
  return saver;
}
