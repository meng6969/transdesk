/* 本地测试台：node test.js [方向]  —— 加载 engine.js + 四个词库，跑句子集
 * 统计口径：句数、单元数、未命中单元数（整句所有分段都算，不只看第一段）。 */
const fs = require('fs');
const path = require('path');
global.window = global;
eval(fs.readFileSync(path.join(__dirname, 'web/engine.js'), 'utf8'));

const E = global.TransEngine;
const dirs = ['en2zh', 'ja2zh', 'zh2en', 'zh2ja'];
const extra = [['en2core', 'en2zh']];
for (const [f, d] of extra) {
  const p = path.join(__dirname, 'web/data', f + '.json');
  if (fs.existsSync(p)) E.load(d, JSON.parse(fs.readFileSync(p, 'utf8')));
}
for (const d of dirs) {
  const p = path.join(__dirname, 'web/data', d + '.json');
  if (fs.existsSync(p)) E.load(d, JSON.parse(fs.readFileSync(p, 'utf8')));
}

const assert = require('assert');

// 质量回归：参照项必须剔除，但合法的 see/compare 与完整短语不能误伤。
assert.strictEqual(E.mk('erroneous variant of 茐'), null);
assert.strictEqual(E.mk('erhua variant of 茐'), null);
assert.strictEqual(E.mk('Japanese variant of 東京'), null);
assert.strictEqual(E.mk('variant Chinese character'), null);
assert.strictEqual(E.mk('variant form'), null);
assert.strictEqual(E.mk('see the entry for details'), null);
assert.strictEqual(E.mk('参见上条'), null);
assert.strictEqual(E.mk('see-saw').g, 'see-saw');
assert.strictEqual(E.mk('compare notes').g, 'compare notes');
assert.strictEqual(E.mk('form of government').g, 'form of government');
assert.strictEqual(E.short(E.mk(' Hope to see you again').g), 'Hope to see you again');
assert.strictEqual(E.mk('basket for chopsticks；erhua variant of 茐').g, 'basket for chopsticks');
assert.strictEqual(E.short(E.mk('basket for chopsticks').g), 'basket for chopsticks');
assert.strictEqual(E.load('en2zh', { w: { __filter_test_bad__: '参见某条', __filter_test_good__: '筷子' } }), 1);
assert.strictEqual(E.lookup('en2zh', '__filter_test_bad__'), null);
assert.ok(E.lookup('en2zh', '__filter_test_good__'));
E.D.en2zh.w.delete('__filter_test_good__');

const BAT = {
  en2zh: [
    'I usually take the bus to work, but yesterday I walked because the weather was nice.',
    'She showed respect by listening without interrupting her colleague.',
    'Each province should adapt its transport policies to local geography and economic needs.',
    'Schools should encourage students to respect different opinions.',
    'How long does it take to get to the library from here?',
    'There are many advantages to using public transport in a crowded city.',
    'He has worked here for five years and knows almost everyone in the office.',
    'If you finish your homework, you can play games for thirty minutes.',
    'What did you do last weekend?',
    'The report is more detailed than the one we read last month.',
    'I want to borrow two books with my library card.',
    'This is the most interesting book I have ever read.',
    'We should protect the environment by reducing plastic waste.',
    'My sister is good at drawing and she wants to be an artist.',
    'The meeting will be held in the main hall at nine tomorrow morning.',
    'Would you mind opening the window? It is rather hot in here.',
    'Learning a foreign language takes time and patience.',
    'He explained the rule to us twice, but nobody understood it.',
  ],
  ja2zh: [
    '私は毎朝七時に起きます。',
    '図書館で本を借りました。',
    '明日は雨が降るかもしれません。',
    'この本はとても面白いです。',
    '日本語で手紙を書くことができました。',
    '駅まで歩いて行きます。',
    '母は台所で料理をしています。',
    '昨日は友達と映画を見ませんでした。',
    'もっと練習すれば、上手になると思います。',
    'ここでは明日の天気について話します。',
    '彼は学校に行くのが嫌です。',
    '食べすぎて、おなかがいっぱいです。',
    '写真を見せてください。',
    'もう一度言っていただけませんか。',
    '週末に実家に帰るつもりです。',
    'このアプリは使い方が簡単で、とても便利です。',
    '友達に誕生日のプレゼントをあげました。',
    '電車が遅れたので、会議に遅刻しました。',
  ],
  zh2en: [
    '我每天早上七点起床。',
    '这本书非常有趣。',
    '我们在图书馆借了两本书。',
    '他昨天没有来上班。',
    '你喜欢吃什么？',
    '明天可能下雨。',
    '我不认识这个人。',
    '她在厨房做饭。',
    '我们一起去公园吧。',
    '学习外语需要很多时间。',
    '谢谢你帮我。',
    '他喝一杯水。',
    '我骑自行车去上班。',
    '游泳对身体好。',
    '我喜欢吃苹果。',
    '他没有钱。',
    '你在哪里工作？',
    '请给我一杯咖啡。',
    '这个杯子很贵。',
    '我每天跑步三十分钟。',
  ],
  zh2ja: [
    '我每天早上七点起床。',
    '这本书非常有趣。',
    '我们在图书馆借了两本书。',
    '他昨天没有来上班。',
    '你喜欢吃什么？',
    '明天可能下雨。',
    '我不认识这个人。',
    '她在厨房做饭。',
    '我们一起去公园吧。',
    '这里很安静，适合学习。',
    '他没有钱。',
    '他很喜欢吃肉。',
    '车站在哪里？',
    '我买了三本书。',
    '请帮我。',
    '谢谢你的帮助。',
    '我喜欢跑步。',
    '你去哪里？',
    '这个杯子很贵。',
    '我们明天一起去图书馆吧。',
  ],
};

const only = process.argv[2];
let grand = { n: 0, miss: 0, units: 0 };
for (const dir of dirs) {
  if (only && only !== dir) continue;
  console.log('\n================ ' + dir + ' ================');
  let sub = { n: 0, miss: 0, units: 0 };
  for (const s of BAT[dir]) {
    const r = E.translate(s, dir);
    let out = [], notes = [];
    for (const seg of r.segs) {
      out.push(seg.dst);
      if (seg.notes) {
        notes.push(seg.notes);
        sub.miss += +(seg.notes.match(/(\d+) 处/) || [0, 1])[1];
      }
    }
    sub.n++; sub.units += r.stats.units;
    console.log('IN  ' + s);
    console.log('OUT ' + out.join(' / '));
    if (notes.length) console.log('    ! ' + notes.join(' | '));
  }
  console.log(dir + ' 小结：句 ' + sub.n + ' 单元 ' + sub.units + ' 未命中 ' + sub.miss +
    ' → ' + (100 * (1 - sub.miss / sub.units)).toFixed(1) + '%');
  console.log('counts', JSON.stringify(E.counts()));
  grand.n += sub.n; grand.units += sub.units; grand.miss += sub.miss;
}
console.log('\n合计句 ' + grand.n + ' 单元 ' + grand.units + ' 未命中 ' + grand.miss +
  ' → 单元命中率 ' + (100 * (1 - grand.miss / grand.units)).toFixed(1) + '%');
