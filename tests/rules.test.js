import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const rules = () => JSON.parse(read('docs/firebase/rules.json')).rules;

const ADMIN = "auth != null && root.child('admins').child(auth.uid).val() === true";

test('admins は本人だけが読め、どの階層にも書きこみの許可がない', () => {
  const admin = rules().admins;
  assert.deepEqual(admin, { $uid: { '.read': 'auth != null && auth.uid === $uid' } });
});

test('teacherList は管理者だけが一覧を読み、自分以外の利用状態だけを書ける', () => {
  const list = rules().teacherList;
  assert.equal(list['.read'], ADMIN);
  assert.equal(list.$uid['.read'], 'auth != null && auth.uid === $uid');
  assert.equal(list.$uid['.write'], "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true");
  assert.equal(list.$uid['.validate'], "newData.isBoolean() && (newData.val() === true ? !newData.parent().parent().child('teacherDirectory').child($uid).child('suspendedAt').exists() : (data.val() === false || !newData.parent().parent().child('teacherDirectory').child($uid).exists() || newData.parent().parent().child('teacherDirectory').child($uid).child('suspendedAt').val() === now))");
  assert.equal(list['.write'], undefined);
});

test('古い停止日時を残す再開・止め直しを拒否する規則は、設計書の文字列と一致する', () => {
  // markSuspended も失敗して古い時刻が残る場合は、アプリだけでは防げない。
  // 新しい規則が状態だけの書きこみを拒否するので、本物では起きない。文字列の一致で確かめる。
  const design = read('docs/superpowers/specs/2026-11-14-teacher-auto-delete-design.md');
  const blocks = [...design.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)];
  const specified = JSON.parse(`{${blocks[1][1]}}`);
  assert.equal(rules().teacherList.$uid['.validate'], specified['.validate']);
});

test('申しこみは未登録の本人の匿名でない認証だけ。管理者は削除だけできる', () => {
  const requests = rules().teacherRequests;
  assert.equal(requests['.read'], ADMIN);
  assert.equal(requests.$uid['.read'], 'auth != null && auth.uid === $uid');
  assert.equal(requests.$uid['.write'], "auth != null && ((auth.uid === $uid && auth.provider !== 'anonymous' && newData.exists() && !root.child('teacherList').child($uid).exists()) || (root.child('admins').child(auth.uid).val() === true && !newData.exists()))");
  assert.ok(requests.$uid['.write'].includes("auth.provider !== 'anonymous'"));
  assert.ok(!requests.$uid['.write'].includes("'password'"));
  assert.equal(requests.$uid['.validate'], "newData.hasChildren(['email', 'at']) && newData.child('email').isString() && newData.child('email').val().length <= 254 && newData.child('email').val() === auth.token.email && newData.child('at').val() === now");
  assert.equal(requests.$uid.$other['.validate'], "$other === 'email' || $other === 'at'");
});

test('名簿を読める・書けるのは管理者だけ。メール・承認日時・停止日時だけを許す', () => {
  const directory = rules().teacherDirectory;
  assert.equal(directory['.read'], ADMIN);
  assert.equal(directory.$uid['.read'], undefined);
  assert.equal(directory.$uid['.write'], ADMIN);
  assert.equal(directory.$uid['.validate'], "newData.hasChildren(['email', 'approvedAt']) && newData.child('email').isString() && newData.child('email').val().length <= 254 && newData.child('approvedAt').isNumber() && (!newData.hasChild('suspendedAt') || newData.child('suspendedAt').isNumber())");
  assert.equal(directory.$uid.$other['.validate'], "$other === 'email' || $other === 'approvedAt' || $other === 'suspendedAt'");
});

test('名簿の停止日時の規則は、自動削除の設計書の文字列と一致する', () => {
  const design = read('docs/superpowers/specs/2026-11-14-teacher-auto-delete-design.md');
  const specified = JSON.parse(`{${design.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]}}`);
  assert.deepEqual(rules().teacherDirectory.$uid, specified.$uid);
});

// 削除の設計で指定された 2 か所以外は、先生の管理を足す前の規則をそのまま保つ
const unchangedRules = {
  "teachers": {
    "$uid": {
      ".read": "auth != null && auth.uid === $uid && root.child('teacherList').child($uid).val() === true",
      ".write": "auth != null && ((auth.uid === $uid && root.child('teacherList').child($uid).val() === true) || (auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false && !newData.exists()))",
      "history": { ".read": "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false" },
      "active": { ".read": "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false" },
      "sessions": { ".read": "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false" }
    }
  },
  "sessions": {
    "$sid": {
      ".read": "auth != null && root.child('teacherList').child(auth.uid).val() === true && data.child('owner').val() === auth.uid",
      ".write": "auth != null && ((root.child('teacherList').child(auth.uid).val() === true && (data.exists() ? data.child('owner').val() === auth.uid : newData.child('owner').val() === auth.uid)) || (root.child('admins').child(auth.uid).val() === true && !newData.exists() && (!data.exists() || (root.child('teacherList').child(data.child('owner').val()).val() === false && !newData.parent().parent().child('teachers').child(data.child('owner').val()).exists()))))",
      "owner": { ".read": "auth != null && root.child('admins').child(auth.uid).val() === true" },
      "pub": {
        ".read": "auth != null",
        "polls": {
          "$slideId": {
            "status": {
              ".validate": "data.val() !== 'closed' || newData.val() === 'closed'"
            }
          }
        },
        "results": {
          "$slideId": {
            ".validate": "newData.parent().parent().child('polls').child($slideId).child('resultsVisible').val() === true"
          }
        }
      },
      "deck": {
        ".read": "auth != null"
      },
      "inbox": {
        "participants": {
          "$uid": {
            ".write": "auth != null && auth.uid === $uid && root.child('sessions').child($sid).child('pub').child('state').val() === 'live'",
            ".validate": "newData.isNumber()"
          }
        },
        "answers": {
          "$slideId": {
            "$uid": {
              ".read": "auth != null && auth.uid === $uid",
              ".write": "auth != null && auth.uid === $uid && newData.exists() && root.child('sessions').child($sid).child('pub').child('state').val() === 'live' && root.child('sessions').child($sid).child('pub').child('polls').child($slideId).child('status').val() === 'open' && root.child('sessions').child($sid).child('pub').child('current').child('slideId').val() === $slideId",
              ".validate": "(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'free' && !(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'cloud') && newData.hasChildren(['text', 'at']) && newData.child('text').isString() && newData.child('text').val().length >= 1 && newData.child('text').val().length <= 200 && newData.child('text').val().matches(/\\S/) && newData.child('at').val() === now) || (!(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'free') && !(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'cloud') && newData.hasChildren(['choice', 'at']) && newData.child('choice').isNumber() && newData.child('choice').val() >= 0 && newData.child('choice').val() < 6 && newData.child('choice').val() % 1 === 0 && root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('options').child(newData.child('choice').val() + '').exists() && newData.child('at').val() === now) || (root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'cloud' && newData.hasChildren(['words', 'at']) && newData.child('at').val() === now)",
              "words": {
                ".validate": "root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'cloud' && newData.hasChild('0')",
                "$i": {
                  ".validate": "($i === '0' || $i === '1' || $i === '2') && newData.isString() && newData.val().length >= 1 && newData.val().length <= 20 && newData.val().matches(/\\S/)"
                }
              },
              "$other": {
                ".validate": "$other === 'at' || ($other === 'choice' && !(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'free') && !(root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'cloud')) || ($other === 'text' && root.child('sessions').child($sid).child('deck').child('slides').child($slideId).child('type').val() === 'free')"
              }
            }
          }
        }
      }
    }
  },
  "check": {
    "ping": {
      ".read": true
    },
    "$uid": {
      ".read": "auth != null && auth.uid === $uid",
      ".write": "auth != null && auth.uid === $uid",
      ".validate": "newData.isNumber()"
    }
  }
};

test('teachers・sessions の削除用の規則は設計どおりで、ほかの規則と check は変更前の文字列のまま', () => {
  const r = rules();
  for (const key of Object.keys(unchangedRules)) assert.deepEqual(r[key], unchangedRules[key], key);
});

test('授業の削除と owner の読み取りの規則は設計書の文字列と一致する', () => {
  const design = read('docs/superpowers/specs/2026-11-15-teacher-delete-design.md');
  const sessionRules = design.split('`sessions/$sid`')[1].match(/```\r?\n([\s\S]*?)\r?\n```/)[1];
  const write = JSON.parse(sessionRules.match(/^"\.write": (".*")\r?$/m)[1]);
  const owner = JSON.parse(`{${sessionRules.match(/^"owner": .*$/m)[0]}}`).owner;
  assert.equal(rules().sessions.$sid['.write'], write);
  assert.deepEqual(rules().sessions.$sid.owner, owner);
  assert.equal(owner['.read'], ADMIN);
});

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

test('先生本人の読み書きを保ち、管理者は停止中の他の先生を削除し、history・active・sessions だけ読める', () => {
  const t = rules().teachers.$uid;
  assert.deepEqual(t, unchangedRules.teachers.$uid);
  assert.equal(t.sessions['.read'], t.history['.read']);
  assert.equal(t.sessions['.read'], t.active['.read']);
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

// ---- クイズ（quiz）と 5 段階評価（rating）----

test('quiz・rating は規則に名前が無く、アンケートの枝（free でも cloud でもない）で選択肢の実在を確かめる', () => {
  const raw = read('docs/firebase/rules.json');
  assert.ok(!raw.includes('quiz'));
  assert.ok(!raw.includes('rating'));
  const v = rules().sessions.$sid.inbox.answers.$slideId.$uid['.validate'];
  const poll = v.split(') || (')[1];
  assert.ok(poll.includes("child('options').child(newData.child('choice').val() + '').exists()"));
});

test('host（クイズの正解・かくした回答）には、読み書きを広げる規則が無い（授業の持ち主だけ）', () => {
  const s = rules().sessions.$sid;
  assert.equal(s.host, undefined);
  assert.equal(s.deck['.write'], undefined);
  assert.equal(s.pub['.write'], undefined);
});

test('規則: 締め切った質問（closed）は、ほかの状態に戻せない', () => {
  const rules = JSON.parse(readFileSync(new URL('../docs/firebase/rules.json', import.meta.url), 'utf8'));
  const v = rules.rules.sessions.$sid.pub.polls.$slideId.status['.validate'];
  assert.equal(v, "data.val() !== 'closed' || newData.val() === 'closed'");
});
