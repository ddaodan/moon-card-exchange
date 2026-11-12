import fs from "node:fs/promises";
import path from "node:path";

const CACHE = path.resolve(".cache/fonts");
const OUT = path.resolve("web/public/fonts");

const SOURCES = [
  {
    name: "Cinzel",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/Cinzel%5Bwght%5D.ttf",
    file: "cinzel.ttf"
  },
  {
    name: "Noto Serif SC",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    file: "noto-serif-sc.ttf"
  }
];

const CHINESE_PUNCT = "，。、；：？！“”‘’（）《》【】—…·";
const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");

async function collectChars() {
  const roots = [path.resolve("web/src"), path.resolve("shared/src")];
  const chars = new Set([...ASCII, ...CHINESE_PUNCT]);
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(js|html|css)$/.test(entry.name)) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const content = await fs.readFile(full, "utf8");
      for (const char of content) {
        const code = char.codePointAt(0);
        if (code > 127) chars.add(char);
      }
    }
  }
  return [...chars].join("");
}

async function ensureFile(source) {
  await fs.mkdir(CACHE, { recursive: true });
  const target = path.join(CACHE, source.file);
  try {
    await fs.access(target);
    return target;
  } catch {
    /* 继续下载 */
  }
  console.log(`下载 ${source.name}…`);
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${source.name} 下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer);
  return target;
}

async function main() {
  let subsetFont;
  try {
    ({ default: subsetFont } = await import("subset-font"));
  } catch {
    console.error("缺少 subset-font，请先运行 npm install");
    process.exit(1);
  }
  const text = await collectChars();
  console.log(`字体子集字符数：${text.length}`);
  await fs.mkdir(OUT, { recursive: true });
  for (const source of SOURCES) {
    let input;
    try {
      input = await ensureFile(source);
    } catch (error) {
      console.error(error.message);
      console.error(`请手动下载 ${source.url} 并保存为 ${path.join(CACHE, source.file)}，然后重试。`);
      process.exit(1);
    }
    const buffer = await fs.readFile(input);
    const slug = source.name === "Cinzel" ? "cinzel" : "noto-serif-sc";
    for (const weight of [400, 700]) {
      const output = await subsetFont(buffer, text, { targetFormat: "woff2", variationAxes: { wght: weight } });
      const target = path.join(OUT, `${slug}-${weight}.woff2`);
      await fs.writeFile(target, output);
      console.log(`生成 ${path.relative(process.cwd(), target)}（${(output.length / 1024).toFixed(1)}KB）`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
