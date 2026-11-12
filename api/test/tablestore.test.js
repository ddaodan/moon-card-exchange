// 回归测试：tablestore SDK 读回的行结构（主键 name/value、属性 columnName/columnValue）。
// 生产环境曾因属性字段名读错导致所有登记读回只剩主键。
import { describe, expect, it } from "vitest";
import { normalizeListing, rowToObject, toAttributeColumns } from "../src/store/tablestore.js";

describe("tablestore 行解析", () => {
  it("属性列构造为 [{列名: 值}]，SDK 只认每个元素的第一个键", () => {
    expect(toAttributeColumns({ uid: "612345601", level: 55 })).toEqual([
      { uid: "612345601" },
      { level: 55 }
    ]);
  });

  it("属性列用 columnName/columnValue 读出，主键用 name/value", () => {
    const row = rowToObject({
      primaryKey: [{ name: "token_hash", value: "abc123" }],
      attributes: [
        { columnName: "uid", columnValue: "612345601" },
        { columnName: "status", columnValue: "active" },
        { columnName: "level", columnValue: { toNumber: () => 55 } }
      ]
    });
    expect(row).toEqual({
      token_hash: "abc123",
      uid: "612345601",
      status: "active",
      level: 55
    });
  });

  it("normalizeListing 从主键补 id 并转换数字字段", () => {
    const listing = normalizeListing({
      token_hash: "abc123",
      spare_mask: "3",
      want_mask: "12",
      time_mask: "1",
      created_at: "100",
      updated_at: "110",
      expires_at: "999",
      matched_at: ""
    });
    expect(listing.id).toBe("abc123");
    expect(listing.spare_mask).toBe(3);
    expect(listing.expires_at).toBe(999);
    expect(listing.matched_at).toBeNull();
  });

  it("已带 id 的行不会被覆盖", () => {
    expect(normalizeListing({ id: "custom", token_hash: "abc" }).id).toBe("custom");
  });
});
