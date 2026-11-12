import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve("web/dist");
const LIMIT_TOTAL = 50 * 1024 * 1024;
const LIMIT_INDEX = 1024 * 1024;
const LIMIT_DATA_URL = 10 * 1024;

const problems = [];
const warnings = [];

if (!fs.existsSync(DIST)) {
  console.error("找不到 web/dist，请先运行 npm run build");
  process.exit(1);
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

const files = walk(DIST);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
if (htmlFiles.length !== 1) problems.push(`根目录应只有一个 index.html，实际 ${htmlFiles.length} 个 HTML`);
const indexFile = path.join(DIST, "index.html");
if (!fs.existsSync(indexFile)) problems.push("缺少 web/dist/index.html");

let total = 0;
for (const file of files) total += fs.statSync(file).size;
if (total >= LIMIT_TOTAL) problems.push(`总大小 ${(total / 1048576).toFixed(2)}MB 超过 50MB`);

if (fs.existsSync(indexFile)) {
  const size = fs.statSync(indexFile).size;
  if (size > LIMIT_INDEX) problems.push(`index.html 为 ${(size / 1024).toFixed(0)}KB，超过 1MB`);
  const html = fs.readFileSync(indexFile, "utf8");
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    problems.push(`存在根路径资源引用：${match[1]}`);
  }
  for (const match of html.matchAll(/data:[^"'()\s]{10000,}/g)) {
    warnings.push(`index.html 中存在长度 ${match[0].length} 的 data URL`);
  }
}

const textFiles = files.filter((file) => /\.(html|js|css|json|txt)$/.test(file));
for (const file of textFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)]]+/g)) {
    const url = match[0];
    const allowed =
      url.startsWith("https://www.bilibili.com") ||
      url.startsWith("https://s1.hdslb.com") ||
      url.startsWith("https://api.") ||
      url.startsWith("https://enka.network") ||
      url.startsWith("https://localhost");
    if (!allowed) warnings.push(`${path.relative(DIST, file)} 引用了外部地址 ${url}`);
  }
  for (const match of text.matchAll(/data:[a-z/+.-]+;base64,([A-Za-z0-9+/=]+)/g)) {
    if (match[1].length > LIMIT_DATA_URL) {
      problems.push(`${path.relative(DIST, file)} 包含超过 10KB 的 data URL`);
    }
  }
}

const fontsDir = path.join(DIST, "fonts");
if (fs.existsSync(fontsDir)) {
  const fonts = fs.readdirSync(fontsDir).filter((name) => name.endsWith(".woff2"));
  if (fonts.length < 4) warnings.push(`字体子集只有 ${fonts.length} 个文件，预期 4 个`);
} else {
  warnings.push("web/dist/fonts 不存在，将使用系统字体");
}

console.log(`检查了 ${files.length} 个文件，总大小 ${(total / 1048576).toFixed(2)}MB`);
if (warnings.length) {
  console.log("提示：");
  warnings.forEach((item) => console.log(`  - ${item}`));
}
if (problems.length) {
  console.error("检查未通过：");
  problems.forEach((item) => console.error(`  - ${item}`));
  process.exit(1);
}
console.log("Toy 打包检查通过");
