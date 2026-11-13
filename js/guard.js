// 先生として入ってよいかの確認（画面に依存しない）。先生の画面へ移るたびに呼ぶ。
// 判定だけを返し、ログアウトはしない（古い応答が、あとから入った別の人を外さないように）。
// verdict: 'ok' 先生として登録されている / 'signed-out' ログインしていない
//          'pending' 登録されていない / 'suspended' 利用停止 / 'offline' 確かめられなかった
// uid: 確かめた相手の uid（ログインしていなければ null）
export async function checkTeacherAccess({ auth, repo }) {
  const user = auth.user;
  if (!user || !repo) return { verdict: 'signed-out', uid: null };
  const uid = user.uid;
  try {
    const status = await repo.teacherStatus();
    return { verdict: status === 'active' ? 'ok' : status === 'suspended' ? 'suspended' : 'pending', uid };
  } catch {
    return { verdict: 'offline', uid };
  }
}

// 確かめている間に、ログインしている人が替わっていないか
export function isStillUser(auth, uid) {
  return (auth.user ? auth.user.uid : null) === uid;
}
