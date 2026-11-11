// 先生として入ってよいかの確認（画面に依存しない）。先生の画面へ移るたびに呼ぶ。
// 判定だけを返し、ログアウトはしない（古い応答が、あとから入った別の人を外さないように）。
// verdict: 'ok' 先生として登録されている / 'signed-out' ログインしていない
//          'not-teacher' 登録されていない / 'offline' 確かめられなかった
// uid: 確かめた相手の uid（ログインしていなければ null）
export async function checkTeacherAccess({ auth, repo }) {
  const user = auth.user;
  if (!user || !repo) return { verdict: 'signed-out', uid: null };
  const uid = user.uid;
  try {
    return { verdict: (await repo.isTeacher()) ? 'ok' : 'not-teacher', uid };
  } catch {
    return { verdict: 'offline', uid };
  }
}

// 確かめている間に、ログインしている人が替わっていないか
export function isStillUser(auth, uid) {
  return (auth.user ? auth.user.uid : null) === uid;
}
