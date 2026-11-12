export const CARDS = [
  // 顺序与编号以 BWIKI「月谕圣牌」页面（游戏内月谕之匣）为准：魔法师第 1 张，愚者第 22 张。
  { id: "magician", no: 0, numeral: "一", name: "魔法师", aliases: ["魔术师"], color: "#ab6b91" },
  { id: "high-priestess", no: 1, numeral: "二", name: "女祭司", aliases: [], color: "#5e917d" },
  { id: "empress", no: 2, numeral: "三", name: "女皇", aliases: [], color: "#ceb57b" },
  { id: "emperor", no: 3, numeral: "四", name: "皇帝", aliases: [], color: "#467fa4" },
  { id: "hierophant", no: 4, numeral: "五", name: "圣职者", aliases: ["教皇"], color: "#5caeb1" },
  { id: "lovers", no: 5, numeral: "六", name: "恋人", aliases: [], color: "#8b485e" },
  { id: "chariot", no: 6, numeral: "七", name: "战车", aliases: [], color: "#cbab6d" },
  { id: "strength", no: 7, numeral: "八", name: "力量", aliases: [], color: "#b67948" },
  { id: "hermit", no: 8, numeral: "九", name: "隐者", aliases: [], color: "#8e9963" },
  { id: "wheel", no: 9, numeral: "十", name: "命运之轮", aliases: ["命运"], color: "#594b69" },
  { id: "justice", no: 10, numeral: "十一", name: "正义", aliases: [], color: "#719ccd" },
  { id: "hanged-man", no: 11, numeral: "十二", name: "倒吊人", aliases: ["吊人"], color: "#9d66a9" },
  { id: "death", no: 12, numeral: "十三", name: "死神", aliases: ["死亡"], color: "#955d5e" },
  { id: "temperance", no: 13, numeral: "十四", name: "节制", aliases: [], color: "#ae966d" },
  { id: "devil", no: 14, numeral: "十五", name: "魔鬼", aliases: ["恶魔"], color: "#85469c" },
  { id: "tower", no: 15, numeral: "十六", name: "塔", aliases: ["高塔"], color: "#69569e" },
  { id: "star", no: 16, numeral: "十七", name: "星", aliases: ["星星", "星辰"], color: "#5776bd" },
  { id: "moon", no: 17, numeral: "十八", name: "月亮", aliases: [], color: "#85bfc9" },
  { id: "sun", no: 18, numeral: "十九", name: "太阳", aliases: [], color: "#c6c963" },
  { id: "judgement", no: 19, numeral: "二十", name: "审判", aliases: [], color: "#5082c0" },
  { id: "world", no: 20, numeral: "二十一", name: "世界", aliases: [], color: "#9c9078" },
  { id: "fool", no: 21, numeral: "二十二", name: "愚者", aliases: [], color: "#659bcc" }
];

export const CARD_COUNT = CARDS.length;
export const CARD_BY_ID = Object.fromEntries(CARDS.map((card) => [card.id, card]));
export const CARD_INDEX = Object.fromEntries(CARDS.map((card) => [card.id, card.no]));
