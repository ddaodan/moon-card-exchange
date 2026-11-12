import { describe, expect, it } from "vitest";
import { CARD_COUNT, parseCardText, formatCardText } from "../src/index.js";

describe("parseCardText", () => {
  it("识别模板示例：月亮x3 太阳2 星星缺", () => {
    const result = parseCardText("月亮x3 太阳2 星星缺");
    expect(result.counts[17]).toBe(3);
    expect(result.counts[18]).toBe(2);
    expect(result.want).toEqual(["star"]);
    expect(result.unknown).toEqual([]);
  });

  it("支持别名、×号、中文数量和想要关键词", () => {
    const result = parseCardText("魔术师×2、吊人三张；教皇2；星星想要；缺死神");
    expect(result.counts[0]).toBe(2);
    expect(result.counts[11]).toBe(3);
    expect(result.counts[4]).toBe(2);
    expect(result.want.sort()).toEqual(["death", "star"]);
  });

  it("识别 BWIKI 目录的「编号·牌名」格式，不把编号当数量", () => {
    const result = parseCardText("十六·塔2 十八·月亮x3；二十二·愚者缺");
    expect(result.counts[15]).toBe(2);
    expect(result.counts[17]).toBe(3);
    expect(result.want).toEqual(["fool"]);
    expect(result.unknown).toEqual([]);
  });

  it("缺字行中的牌记为想要", () => {
    const result = parseCardText("缺 女皇 世界");
    expect(result.want.sort()).toEqual(["empress", "world"]);
  });

  it("无法识别时返回 unknown", () => {
    const result = parseCardText("随便写点东西");
    expect(result.counts.every((n) => n === 0)).toBe(true);
    expect(result.unknown).toEqual(["随便写点东西"]);
  });
});

describe("formatCardText", () => {
  it("生成的文字可被原样解析回来", () => {
    const counts = new Array(CARD_COUNT).fill(0);
    counts[17] = 3;
    counts[18] = 2;
    const state = { counts, want: ["star", "tower"] };
    const text = formatCardText(state);
    const parsed = parseCardText(text);
    expect(parsed.counts).toEqual(counts);
    expect(parsed.want.sort()).toEqual(["star", "tower"]);
    expect(parsed.unknown).toEqual([]);
  });
});
