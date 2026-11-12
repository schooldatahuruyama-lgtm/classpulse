import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const rules = () => JSON.parse(read('docs/firebase/rules.json')).rules;

test('規則が JSON として読める', () => {
  assert.doesNotThrow(() => JSON.parse(read('docs/firebase/rules.json')));
});

test('最上位で読み書きを許していない', () => {
  const r = rules();
  assert.equal(r['.read'], undefined);
  assert.equal(r['.write'], undefined);
});

test('回答は本人だけが読める（inbox・answers・質問の単位では読めない）', () => {
  const inbox = rules().sessions.$sid.inbox;
  assert.equal(inbox['.read'], undefined);
  assert.equal(inbox.answers['.read'], undefined);
  assert.equal(inbox.answers.$slideId['.read'], undefined);
  assert.equal(inbox.answers.$slideId.$uid['.read'], 'auth != null && auth.uid === $uid');
});

test('回答の書きこみは受付中だけ', () => {
  const w = rules().sessions.$sid.inbox.answers.$slideId.$uid['.write'];
  assert.ok(w.includes("'open'"));
  assert.ok(w.includes("'live'"));
  assert.ok(w.includes('auth.uid === $uid'));
});

test('設定のファイルに秘密のキーがない', () => {
  const t = read('js/firebase-config.js').toLowerCase();
  for (const w of ['password', 'secret', 'private_key']) assert.ok(!t.includes(w), w);
});

test('授業の読み取りは登録済みの先生で持ち主だけ', () => {
  const r = rules().sessions.$sid['.read'];
  assert.ok(r.includes('teacherList'));
  assert.ok(r.includes("data.child('owner').val() === auth.uid"));
});

test('回答の検証は整数で、質問に実在する選択肢だけ', () => {
  const v = rules().sessions.$sid.inbox.answers.$slideId.$uid['.validate'];
  assert.ok(v.includes('% 1 === 0'));
  assert.ok(v.includes('options'));
});

test('先生のデータは本人だけが読み書きできる', () => {
  const t = rules().teachers.$uid;
  assert.ok(t['.read'].includes('auth.uid === $uid'));
  assert.ok(t['.write'].includes('auth.uid === $uid'));
});

test('集計（pub/results/<質問>）は、その質問の結果を公開しているときだけ書ける', () => {
  const pub = rules().sessions.$sid.pub;
  assert.equal(pub['.read'], 'auth != null');
  const v = pub.results.$slideId['.validate'];
  // 書きこんだあとのデータ（newData）で確かめる。公開と集計を 1 回の update で書いても通る
  assert.equal(v, "newData.parent().parent().child('polls').child($slideId).child('resultsVisible').val() === true");
  // 集計の場所に、読み書きを広げる規則は置かない（書けるのは授業の持ち主だけのまま）
  assert.equal(pub.results['.write'], undefined);
  assert.equal(pub.results.$slideId['.write'], undefined);
  assert.equal(pub['.write'], undefined);
});

test('回答の検証は free の質問では text（1〜200 文字の文字列）、それ以外では choice', () => {
  const a = rules().sessions.$sid.inbox.answers.$slideId.$uid;
  const v = a['.validate'];
  assert.equal(typeof v, 'string');
  assert.ok(v.includes("child('type').val() === 'free'"));
  assert.ok(/hasChildren\(\['text', ?'at'\]\)/.test(v));
  assert.ok(v.includes("child('text').isString()"));
  assert.ok(v.includes('<= 200'));
  assert.ok(v.includes('% 1 === 0'));
  const other = a.$other['.validate'];
  assert.ok(other.includes("'text'") && other.includes("'choice'") && other.includes("'at'"));
  assert.ok(other.includes("'free'"));
});

test('自由記述の text は空白だけでは通らない（空白以外の文字を 1 つ以上含む）', () => {
  const raw = read('docs/firebase/rules.json');
  assert.doesNotThrow(() => JSON.parse(raw));
  const v = rules().sessions.$sid.inbox.answers.$slideId.$uid['.validate'];
  const cond = String.raw`newData.child('text').val().matches(/\S/)`;
  assert.ok(v.includes(cond));
  // free の枝（choice の枝より前）に入っている
  const freeBranch = v.split('||')[0];
  assert.ok(freeBranch.includes("=== 'free'") && freeBranch.includes(cond));
  // ファイルの中では、バックスラッシュを 2 つ重ねて書く
  assert.ok(raw.includes(String.raw`matches(/\\S/)`));
});

// ---- ワードクラウド（cloud）----
const TYPE = "root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val()";

test('回答の検証は 3 つの場合: free・アンケート（どちらも cloud ではない）・cloud（words と at）', () => {
  const raw = read('docs/firebase/rules.json');
  assert.doesNotThrow(() => JSON.parse(raw));
  const v = rules().sessions.$sid.inbox.answers.$slideId.$uid['.validate'];
  assert.equal(typeof v, 'string');
  assert.ok(!v.includes('?'), '三項演算子は使わない');
  const branches = v.split(') || (');
  assert.equal(branches.length, 3);
  const [free, poll, cloud] = branches;
  assert.ok(free.includes(`${TYPE} === 'free'`));
  assert.ok(free.includes(`!(${TYPE} === 'cloud')`));
  assert.ok(free.includes("newData.hasChildren(['text', 'at'])"));
  assert.ok(poll.includes(`!(${TYPE} === 'free')`));
  assert.ok(poll.includes(`!(${TYPE} === 'cloud')`));
  assert.ok(poll.includes("newData.hasChildren(['choice', 'at'])"));
  assert.ok(cloud.includes(`${TYPE} === 'cloud'`));
  assert.ok(!cloud.includes(`!(${TYPE} === 'cloud')`));
  assert.ok(cloud.includes("newData.hasChildren(['words', 'at'])"));
  assert.ok(cloud.includes("newData.child('at').val() === now"));
  assert.ok(!cloud.includes("'text'") && !cloud.includes("'choice'"));
});

test('words は名前つきの子: cloud だけで 0 を必ず持ち、$i は 0・1・2 の 1〜20 文字の空白でない文字列', () => {
  const raw = read('docs/firebase/rules.json');
  const w = rules().sessions.$sid.inbox.answers.$slideId.$uid.words;
  assert.ok(w, 'words の規則がある');
  assert.equal(w['.validate'], `${TYPE} === 'cloud' && newData.hasChild('0')`);
  assert.equal(w['.write'], undefined);
  const i = w.$i['.validate'];
  assert.ok(i.includes("($i === '0' || $i === '1' || $i === '2')"));
  assert.ok(!i.includes("'3'"));
  assert.ok(!i.includes('?'));
  for (const c of ['newData.isString()', 'newData.val().length >= 1', 'newData.val().length <= 20', String.raw`newData.val().matches(/\S/)`]) {
    assert.ok(i.includes(c), c);
  }
  assert.ok(raw.includes(String.raw`newData.val().matches(/\\S/)`));
});

test('$other は free・cloud で choice を、アンケート・cloud で text を拒む（words は $other に入らない）', () => {
  const other = rules().sessions.$sid.inbox.answers.$slideId.$uid.$other['.validate'];
  assert.ok(!other.includes('?'));
  const parts = other.split(' || ');
  const choice = parts.find((p) => p.includes("$other === 'choice'"));
  const text = parts.find((p) => p.includes("$other === 'text'"));
  assert.ok(choice.includes(`!(${TYPE} === 'free')`));
  assert.ok(choice.includes(`!(${TYPE} === 'cloud')`));
  assert.ok(text.includes(`${TYPE} === 'free'`));
  assert.ok(!other.includes("'words'"));
});
