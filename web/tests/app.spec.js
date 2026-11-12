import { expect, test } from "@playwright/test";

const CARD_NAMES = { fool: "愚者", empress: "女皇" };

async function openBox(page) {
  await page.goto("/");
  await page.goto("/#/box");
  // 未登记访客先看到落地页，需要点“开始登记交换”才进入向导。
  const cta = page.getByRole("button", { name: "开始登记交换" });
  // 已登记时落地页隐藏但仍挂在 DOM 里，所以等 attached，再用可见性区分两种状态。
  await page.locator("#mg-uid").or(cta).first().waitFor({ state: "attached" });
  if (await cta.isVisible()) await cta.click();
  await expect(page.getByText("整理你的牌匣")).toBeVisible();
}

// 通过真实 UI 走完向导：UID → 牌匣 → 想要 → 时间与同意 → 提交并确认恢复码。
async function submitDraft(page, uid, own = "fool") {
  await openBox(page);
  const next = page.getByRole("button", { name: "下一步" });
  const name = CARD_NAMES[own];
  const item = page.locator(`.mg-item[data-id="${own}"]`);
  await item.getByRole("button", { name: `增加${name}数量` }).click();
  await item.getByRole("button", { name: `增加${name}数量` }).click();
  await next.click();
  await next.click();
  // UID 挪到了最后的提交步。
  await page.locator("#mg-uid").fill(uid);
  await page.getByRole("button", { name: "随时可约" }).click();
  await page.getByLabel(/同意在匹配成功后/).check();
  const submit = page.getByRole("button", { name: /提交登记并开始匹配|更新登记并继续匹配/ });
  await expect(submit).toBeVisible();
  await submit.click();
  const dialog = page.getByRole("dialog", { name: /登记成功/ });
  await expect(dialog).toBeVisible();
  const token = (await dialog.locator(".mg-code").innerText()).replace(/[^0-9A-HJKLMNPQRSTVWXYZ]/g, "");
  expect(token).toHaveLength(32);
  await dialog.getByRole("button", { name: "已保存，去匹配页" }).click();
  await expect(page.getByRole("heading", { name: "月下相遇" })).toBeVisible();
  return token;
}

async function importToken(page, token) {
  // 「我的登记」已并入登记页：从首页的「找回登记」入口导入。
  await page.goto("/#/box");
  // 已登记用户回牌匣页时向导保持展开，先返回首页露出恢复入口。
  const back = page.getByRole("button", { name: "返回首页" });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole("button", { name: "已有恢复码？找回登记" }).click();
  // 恢复码分组输入：把 32 位码按 4 位一组填进 8 个格子。
  const cells = page.locator(".mg-code-cell");
  for (let index = 0; index < 8; index += 1) {
    await cells.nth(index).fill(token.slice(index * 4, index * 4 + 4));
  }
  await page.getByRole("button", { name: "导入并恢复", exact: true }).click();
  await expect(page.getByText("找回成功，登记已恢复")).toBeVisible();
}

// 注入假 Toy SDK：window.toy 在页面脚本之前存在，platform 会把页面视为 Toy 环境。
// 云存储数据放 sessionStorage，reload 后仍可读，用来模拟跨设备找回。
async function installFakeToy(page, { support = {} } = {}) {
  await page.addInitScript((supported) => {
    window.__toyCalls = [];
    const cloud = new Map(Object.entries(JSON.parse(sessionStorage.getItem("__toyCloud") ?? "{}")));
    const saveCloud = () => sessionStorage.setItem("__toyCloud", JSON.stringify(Object.fromEntries(cloud)));
    window.toy = {
      isSupport(ability) {
        window.__toyCalls.push(["isSupport", ability]);
        return Promise.resolve(Boolean(supported[ability]));
      },
      saveImageToAlbum(req) {
        window.__toyCalls.push(["saveImageToAlbum", { base64Length: (req.base64Data ?? "").length, hintMsg: req.hintMsg ?? "" }]);
        return Promise.resolve({ localPath: "/tmp/card.png" });
      },
      getCloudStorage(keys) {
        window.__toyCalls.push(["getCloudStorage", keys ?? null]);
        const result = {};
        for (const key of keys ?? [...cloud.keys()]) {
          if (cloud.has(key)) result[key] = cloud.get(key);
        }
        return Promise.resolve(result);
      },
      setCloudStorage(items) {
        window.__toyCalls.push(["setCloudStorage", { ...items }]);
        for (const [key, value] of Object.entries(items)) cloud.set(key, value);
        saveCloud();
        return Promise.resolve();
      },
      removeCloudStorage(keys) {
        window.__toyCalls.push(["removeCloudStorage", keys]);
        for (const key of keys) cloud.delete(key);
        saveCloud();
        return Promise.resolve();
      },
      getQrCode() {
        window.__toyCalls.push(["getQrCode"]);
        return Promise.resolve({ base64: "data:image/png;base64,FAKEQRCODE", url: "https://www.bilibili.com/toy/fake/index.html" });
      },
      share() {
        window.__toyCalls.push(["share"]);
        return Promise.resolve();
      }
    };
  }, support);
}

test.describe("牌匣", () => {
  test("落地页展示交换教程动画，点击开始进入登记", async ({ page }) => {
    await page.goto("/");
    await page.goto("/#/box");
    const tutorial = page.getByRole("img", { name: /^交换教程/ });
    await expect(tutorial).toBeVisible();
    await expect(tutorial.locator(".mg-tut-scene")).toHaveCount(4);
    await expect(tutorial.getByText("登记你的牌匣")).toBeVisible();
    await expect(page.getByText("交换是怎么进行的？")).toHaveCount(0);
    await page.getByRole("button", { name: "开始登记交换" }).click();
    await expect(page.getByText("整理你的牌匣")).toBeVisible();
    await expect(page.locator(".mg-item")).toHaveCount(22);
    // 刷新后回到首页，而不是直接展开登记向导。
    await page.reload();
    await expect(page.getByRole("img", { name: /^交换教程/ })).toBeVisible();
    await expect(page.getByText("整理你的牌匣")).toBeHidden();
    await expect(page.getByRole("button", { name: "开始登记交换" })).toBeVisible();
  });

  test("按钮录入数量并显示可交换张数", async ({ page }) => {
    await openBox(page);
    const item = page.locator('.mg-item[data-id="moon"]');
    await item.getByRole("button", { name: "增加月亮数量" }).click();
    await item.getByRole("button", { name: "增加月亮数量" }).click();
    await expect(item.locator(".mg-seal")).toContainText("可换 1");
    await item.getByRole("button", { name: "减少月亮数量" }).click();
    await expect(item.locator(".mg-seal")).toBeHidden();
  });

  test("粘贴识别支持覆盖与合并", async ({ page }) => {
    await openBox(page);
    // 默认草稿想要所有缺牌，先取消女皇，让识别产生“标记想要”变更。
    await page.locator('.mg-item[data-id="empress"]').getByRole("button", { name: "正在寻找" }).click();
    await page.getByRole("button", { name: "粘贴识别" }).click();
    await page.locator("#mg-paste-text").fill("愚者×3 女皇缺");
    await page.getByRole("button", { name: "识别清单" }).click();
    // 默认“想要全部缺牌”也会被覆盖为仅剩解析结果，所以变更不止 2 处。
    await expect(page.getByText(/识别到 \d+ 处变更/)).toBeVisible();
    await expect(page.getByText("愚者 0 → 3")).toBeVisible();
    await expect(page.getByText("女皇 标记想要")).toBeVisible();
    await page.getByRole("button", { name: "覆盖", exact: true }).click();
    await expect(page.locator('.mg-item[data-id="fool"] .mg-seal')).toContainText("可换 2");
    await expect(page.locator('.mg-item[data-id="empress"]')).toHaveClass(/is-want/);
  });

  test("复制我的牌单", async ({ page }) => {
    await openBox(page);
    await page.locator('.mg-item[data-id="moon"]').getByRole("button", { name: "增加月亮数量" }).click();
    await page.getByRole("button", { name: "复制我的牌单" }).click();
    await expect(page.locator(".mg-toast")).toContainText("牌单已复制");
  });

  test("每一步缺什么会当场说明", async ({ page }) => {
    await openBox(page);
    const next = page.getByRole("button", { name: "下一步" });
    await next.click();
    await next.click();
    await next.click();
    await expect(page.getByText(/至少录入 1 张可交换的牌/)).toBeVisible();
  });

  test("想要步展示缺牌，全部收集后显示空态说明", async ({ page }) => {
    await openBox(page);
    const next = page.getByRole("button", { name: "下一步" });
    const moon = page.locator('.mg-item[data-id="moon"]');
    await moon.getByRole("button", { name: "增加月亮数量" }).click();
    await moon.getByRole("button", { name: "增加月亮数量" }).click();
    await next.click();
    // 回归防护：进入想要步时缺牌卡片必须渲染出来。
    await expect(page.locator(".mg-wantcard")).toHaveCount(21);
    await expect(page.getByText("已选 21 / 缺 21 种")).toBeVisible();
    // 全部收集后再进来，显示解释而不是空白，且无法进入下一步。
    await page.getByRole("button", { name: "上一步" }).click();
    for (const card of await page.locator(".mg-item").all()) {
      await card.scrollIntoViewIfNeeded();
      await card.getByRole("button", { name: /增加/ }).first().click();
    }
    await next.click();
    await expect(page.locator(".mg-empty")).toContainText("都已收集齐");
    await next.click();
    await expect(page.getByText(/至少选择 1 张想要的牌/)).toBeVisible();
  });
});

test.describe("Toy SDK", () => {
  test("登记凭证同步 B站 云端，换设备可自动找回", async ({ page }) => {
    await installFakeToy(page, { support: { setCloudStorage: true, getCloudStorage: true } });
    const token = await submitDraft(page, "601234589");
    // 登记时已把恢复码写入云存储。
    const calls = await page.evaluate(() => window.__toyCalls);
    expect(calls.some(([name, arg]) => name === "setCloudStorage" && arg?.token === token)).toBeTruthy();
    // 清掉本地身份，模拟换设备或清缓存。
    await page.evaluate(() => {
      window.localStorage.removeItem("moon.token");
      window.localStorage.removeItem("moon.draft");
    });
    await page.reload();
    await expect(page.getByText("已通过 B站 云端找回你的登记")).toBeVisible();
    // 找回后同样先看到首页，点“开始登记交换”才展开向导（草稿已回填登记数据）。
    await page.goto("/#/box");
    await expect(page.getByRole("button", { name: "开始登记交换" })).toBeVisible();
    await page.getByRole("button", { name: "开始登记交换" }).click();
    await expect(page.getByText("整理你的牌匣")).toBeVisible();
    const afterReload = await page.evaluate(() => window.__toyCalls);
    expect(afterReload.some(([name, arg]) => name === "getCloudStorage" && arg?.includes("token"))).toBeTruthy();
  });

  test("Toy 环境下名片保存到相册，二维码与分享走 SDK", async ({ page }) => {
    await installFakeToy(page, { support: { saveImageToAlbum: true, getQrCode: true, share: true } });
    await submitDraft(page, "601234589");
    await page.goto("/#/card");
    await expect(page.locator(".mg-poster")).toBeVisible();
    // 二维码被平台生成的替换。
    await expect(page.locator(".mg-qr img").first()).toHaveAttribute("src", /FAKEQRCODE/);
    // App 内分享按钮出现并可调用分享面板。
    await expect(page.getByRole("button", { name: "分享给牌友" })).toBeVisible();
    await page.getByRole("button", { name: "分享给牌友" }).click();
    // 保存走相册而不是浏览器下载。
    await page.getByRole("button", { name: "保存名片图片" }).click();
    await expect(page.getByText("已保存到手机相册")).toBeVisible();
    const calls = await page.evaluate(() => window.__toyCalls);
    const save = calls.find(([name]) => name === "saveImageToAlbum");
    expect(save?.[1]?.base64Length).toBeGreaterThan(10000);
    expect(save?.[1]?.hintMsg).toContain("相册");
    expect(calls.some(([name]) => name === "share")).toBeTruthy();
  });
});

test.describe("登记与匹配", () => {
  test("提交登记显示恢复码并进入匹配页", async ({ page }) => {
    const token = await submitDraft(page, "601234589");
    // 演示库保证同服务器至少有一位互补牌友，登记后立即能看到匹配卡片。
    await expect(page.locator(".mg-match").first()).toBeVisible();
    expect(token).toBeTruthy();
  });

  test("登记后申请交换、互相可见并可标记完成", async ({ page }) => {
    // A：出愚者 2 张；种子数据里没有与它互补的美服登记，所以初始匹配为空。
    const tokenA = await submitDraft(page, "601234589");
    // 模拟另一位旅行者：清掉令牌与草稿，避免用 A 的登记回填 B 的牌匣。
    await page.evaluate(() => {
      window.localStorage.removeItem("moon.token");
      window.localStorage.removeItem("moon.draft");
    });
    // B：出女皇 2 张，要愚者。
    const tokenB = await submitDraft(page, "601234590", "empress");
    // 申请前只能看到昵称与牌面，UID 处于隐藏状态。
    const bMatch = page.locator(".mg-match", { hasText: "月下旅人589" });
    await expect(bMatch).toHaveCount(1);
    await expect(bMatch.getByText("申请交换后可见")).toBeVisible();
    // B 隐藏后 5 秒内可撤销。
    await bMatch.getByRole("button", { name: "隐藏", exact: true }).click();
    const undoToast = page.locator("button.mg-toast", { hasText: "已隐藏 · 点击撤销" });
    await expect(undoToast).toBeVisible();
    await undoToast.click();
    await expect(page.locator(".mg-match", { hasText: "月下旅人589" })).toHaveCount(1);
    await expect(page.getByText("已撤销隐藏")).toBeVisible();
    // 导入 A 的恢复码，以 A 的身份申请交换。
    await importToken(page, tokenA);
    await page.goto("/#/match");
    const aMatch = page.locator(".mg-match", { hasText: "月下旅人590" });
    await expect(aMatch).toHaveCount(1);
    await expect(aMatch.getByText("申请交换后可见")).toBeVisible();
    await aMatch.getByRole("button", { name: "申请交换" }).click();
    await expect(page.getByText("已申请交换")).toBeVisible();
    await expect(aMatch.getByText("正在交换")).toBeVisible();
    await expect(aMatch.getByText("601234590")).toBeVisible();
    // 复制按钮存在（无头环境剪贴板权限不稳定，只验证按钮）。
    await expect(aMatch.getByRole("button", { name: "复制对方 UID" })).toBeVisible();
    // A 标记完成并同步牌匣。
    await aMatch.getByRole("button", { name: "已交换", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "确认已交换？" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "确认已交换" }).click();
    await expect(page.getByText("已标记交换完成")).toBeVisible();
    // A 牌匣变化：愚者 2→1，女皇 0→1（markCompleted 已同步更新本地登记与草稿）。
    await page.goto("/#/box");
    await expect(page.locator('.mg-item[data-id="fool"] .mg-count')).toHaveText("1");
    await expect(page.locator('.mg-item[data-id="empress"] .mg-count')).toHaveText("1");
    // B 的视角：交换中的匹配即使牌匣已变仍会保留，显示对方已标记完成。
    await importToken(page, tokenB);
    await page.goto("/#/match");
    const bMatchAfter = page.locator(".mg-match", { hasText: "月下旅人589" });
    await expect(bMatchAfter).toHaveCount(1);
    await expect(bMatchAfter.getByText("对方已标记交换")).toBeVisible();
  });
});

test.describe("名片", () => {
  test("登记后名片可隐藏 UID", async ({ page }) => {
    await submitDraft(page, "601234589");
    await page.goto("/#/card");
    await expect(page.locator(".mg-poster")).toBeVisible();
    await expect(page.locator(".mg-po-meta")).toContainText("601234589");
    await page.getByLabel(/名片上隐藏 UID/).check();
    await expect(page.locator(".mg-po-meta")).toContainText("601****89");
    await expect(page.locator(".mg-qr img")).toBeVisible();
  });
});

test.describe("控制台", () => {
  test("浏览三个页面没有控制台错误", async ({ page }) => {
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await submitDraft(page, "601234589");
    await page.goto("/#/card");
    await expect(page.locator(".mg-poster")).toBeVisible();
    await page.goto("/#/match");
    await expect(page.locator(".mg-match").first()).toBeVisible();
    await page.goto("/#/box");
    await expect(page.getByText("整理你的牌匣")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
