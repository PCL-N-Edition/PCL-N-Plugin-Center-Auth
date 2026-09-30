// Every phrase is a checked-in draft. No model or remote dictionary is used at runtime.
// Human approval of this exact version is required before production binding is enabled.
export const LEXICON_VERSION = 'bili-literary-v1-draft1';
export const LEXICON_REVIEW_STATUS = 'draft';

const entries = (text, tags = []) => text.split(' ').map(word => ({ word, tags }));

export const LITERARY_LEXICON = {
  version: LEXICON_VERSION,
  reviewStatus: LEXICON_REVIEW_STATUS,
  minLength: 32,
  maxLength: 45,
  clauseCount: 3,
  separator: '，',
  terminator: '。',
  // Disjoint spaces are distinguished by visible, semantically meaningful first words.
  spacePrefixes: ['清晨', '黄昏', '深夜'],
  slots: [
    { name: 'time', entries: [
      ...entries('清晨 黎明 拂晓 晨间 午后 正午 晌午 日间', ['day']),
      ...entries('黄昏 傍晚 薄暮 暮间'),
      ...entries('深夜 子夜 午夜 长夜 雨夜 雪夜 今夜 昨夜', ['night']),
      ...entries('初夏 仲夏 盛夏 晚夏', ['summer']),
      ...entries('初春 仲春 暮春 初秋 仲秋 深秋 初冬 深冬'),
    ] },
    { name: 'person', entries: [
      ...entries('旅人 行人 诗人 少年 青年 友人 游人 路人 归人 故人 佳人 文人 书生 学子 游子 过客 来客 常客 樵夫 渔人 牧人 农人 花农 茶农 画师 乐师 歌者 舞者'),
      ...entries('老人 老者 长者 老翁', ['elder']),
    ] },
    { name: 'manner', entries: [
      ...entries('缓缓 慢慢 徐徐 轻轻 悄悄 静静 默默 悠悠 翩翩 从容 安然 坦然 欣然 怡然 悠然 自在 独自 结伴 相携 并肩 迎风 随风 沿途 偶尔 再次 依旧 仍旧 终于 忽然'),
      ...entries('趁夜 乘月', ['night']),
      ...entries('踏雪', ['snow', 'tread']),
    ] },
    { name: 'action', entries: [
      ...entries('走过 经过 路过 行经 途经 穿过 越过 步入 走进 进入 来到 返回 走向'),
      ...entries('踏过 踏入', ['tread']),
      ...entries('奔向', ['rush']),
    ] },
    { name: 'scene', entries: [
      ...entries('寂静 宁静 安静 静谧 幽静 幽深 清幽 朦胧 迷蒙 隐约 熟悉 陌生 古老 遥远 悠远 温柔 明净 清冷 微凉 恬静 平静 沉静 迷离 清寂'),
      ...entries('空旷 开阔 辽阔 苍茫', ['expansive']),
      ...entries('苍翠 青葱 翠绿 葱茏', ['green']),
    ] },
    { name: 'place', entries: [
      ...entries('山谷 山林 林间 松林 竹林 花间 花园 花圃 原野 田野 稻田 麦田 草原 草甸 草地 苔原 山间 山巅 山岭 山麓 山坡 高原 平原 丘陵 荒野 荒原 旷野 郊野 江畔 河畔 湖畔 海边 沙洲 沙丘 沙滩 绿洲 溪边 泉边 水畔'),
      ...entries('渡口 桥头 石桥 长桥 小径 山径 小路 古道 栈道 长街 小巷 巷口 街角 老街 古城 旧城 小镇 村庄 村落 故里 庭院 长廊 回廊 楼台 亭台', ['built']),
    ].map(entry => ({ ...entry, tags: [
      ...entry.tags,
      ...('沙洲 沙丘 沙滩'.split(' ').includes(entry.word) ? ['bare'] : []),
      ...('花间 花圃 林间 山径 小径 小路 街角 巷口 庭院 长廊 回廊 楼台 亭台 泉边 溪边'.split(' ').includes(entry.word) ? ['confined'] : []),
    ] })) },
  ],
  // Rules describe actual excluded combinations and are included in the exact count.
  exclusions: [
    { left: 'time', leftTag: 'day', right: 'manner', rightTag: 'night', reason: '日间不搭配趁夜或乘月。' },
    { left: 'time', leftTag: 'summer', right: 'manner', rightTag: 'snow', reason: '夏季模板不搭配踏雪。' },
    { left: 'person', leftTag: 'elder', right: 'action', rightTag: 'rush', reason: '年长人物模板不搭配奔向。' },
    { left: 'scene', leftTag: 'green', right: 'place', rightTag: 'built', reason: '草木颜色词不修饰建筑或道路。' },
    { left: 'scene', leftTag: 'green', right: 'place', rightTag: 'bare', reason: '草木颜色词不修饰沙地。' },
    { left: 'scene', leftTag: 'expansive', right: 'place', rightTag: 'confined', reason: '辽阔等广度词不修饰狭小地点。' },
    { left: 'manner', leftTag: 'tread', right: 'action', rightTag: 'tread', reason: '避免踏雪踏入等连续重复动词。' },
  ],
};
