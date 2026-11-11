// 先生として入ってよいかの確認（画面に依存しない）。先生の画面へ移るたびに呼ぶ。
// 'ok' 先生として登録されている / 'signed-out' ログインしていない
// 'not-teacher' 登録されていない（ここでログアウトする） / 'offline' 確かめられなかった（ログアウトしない）
export async function checkTeacherAccess({ auth, repo }) {
  if (!auth.user || !repo) return 'signed-out';
  let ok;
  try {
    ok = await repo.isTeacher();
  } catch {
    return 'offline';
  }
  if (ok) return 'ok';
  auth.signOut();
  return 'not-teacher';
}
