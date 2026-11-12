import { CARDS, CARD_BY_ID } from "./cards.js";

const NAME_ALIASES = CARDS
  .flatMap((card) => [card.name, ...card.aliases].map((label) => [label, card.id]))
  .sort((a, b) => b[0].length - a[0].length);

const CHINESE_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WANT_WORDS = new Set(["缺", "想要", "求", "没有", "无"]);

const TOKEN = "([0-9]{1,3}|[一二两三四五六七八九十]+张?|[一二两三四五六七八九十]+个?|缺|想要|求|没有|无)?";
const PARSE_RE = new RegExp(
  `(${NAME_ALIASES.map(([label]) => label).join("|")})\\s*(?:[xX×*:：]\\s*)?${TOKEN}`,
  "g"
);
const WANT_LINE_RE = /缺|想要|求/;
// BWIKI 目录使用「一·魔法师 … 二十二·愚者」格式，前置编号会紧跟上一张牌名，
// 若不剥离会被误当成上一张牌的数量。
const HEADING_NUMERAL_RE = /(?:[0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*[·・]\s*/g;

function parseToken(token) {
  if (token == null) return null;
  if (WANT_WORDS.has(token)) return { want: true };
  if (/^[0-9]{1,3}$/.test(token)) return { count: Number(token) };
  const bare = token.replace(/[张个]$/, "");
  let total = 0;
  if (bare === "十") total = 10;
  else if (bare.includes("十")) {
    const [head, tail] = bare.split("十");
    total = (CHINESE_DIGITS[head] ?? 1) * 10 + (tail ? CHINESE_DIGITS[tail] ?? 0 : 0);
  } else total = CHINESE_DIGITS[bare] ?? 0;
  if (!total) return null;
  return { count: total };
}

export function parseCardText(text) {
  const counts = new Array(CARDS.length).fill(0);
  const want = new Set();
  const unknown = [];
  const overflow = [];
  let matched = false;
  for (const rawLine of String(text ?? "").split(/[\n;；。]+/)) {
    const line = rawLine.trim().replace(HEADING_NUMERAL_RE, "");
    if (!line) continue;
    let lineMatched = false;
    const matches = [...line.matchAll(PARSE_RE)];
    matches.forEach((match, index) => {
      const id = NAME_ALIASES.find(([label]) => label === match[1])[1];
      lineMatched = true;
      matched = true;
      const value = parseToken(match[2]);
      if (value?.count != null && value.count > 99) {
        overflow.push(`${match[1]}×${value.count}`);
        value.count = 99;
      }
      const nextStart = index + 1 < matches.length ? matches[index + 1].index : line.length;
      const prefix = line.slice(0, match.index);
      if (value?.want || (value == null && (WANT_LINE_RE.test(prefix) || gapHasWant()))) {
        want.add(id);
      } else if (value?.count != null) {
        counts[CARD_BY_ID[id].no] = value.count;
        want.delete(id);
      }
      function gapHasWant() {
        const gap = line.slice(match.index + match[0].length, nextStart);
        return WANT_LINE_RE.test(gap);
      }
    });
    // 收集匹配之间的残片（如「愚者×3 abc乱码 女皇缺」中的「abc乱码」）。
    if (matches.length) {
      let cursor = 0;
      const collectGap = (gap) => {
        const residue = String(gap)
          // 「拥有」「想要」是牌单标签，不算未识别内容。
          .replace(/拥有|缺|想要|求|没有|无/g, "")
          .replace(/[\s，、,·・xX×*:：0-9一二两三四五六七八九十张个]+/g, "");
        if (residue) unknown.push(residue);
      };
      for (const match of matches) {
        collectGap(line.slice(cursor, match.index));
        cursor = match.index + match[0].length;
      }
      collectGap(line.slice(cursor));
    }
    if (!lineMatched) unknown.push(line);
  }
  if (!matched) return { counts: [...counts], want: [], unknown: [String(text ?? "").trim()], overflow: [] };
  return { counts: [...counts], want: [...want], unknown, overflow };
}

export function formatCardText(state) {
  const owned = CARDS.filter((card) => (state.counts?.[card.no] ?? 0) > 0)
    .map((card) => `${card.name}×${state.counts[card.no]}`);
  const want = (state.want ?? []).filter((id) => CARD_BY_ID[id]).map((id) => CARD_BY_ID[id].name);
  const lines = [];
  if (owned.length) lines.push(`拥有：${owned.join("、")}`);
  if (want.length) lines.push(`想要：${want.join("、")}`);
  return lines.join("\n");
}
