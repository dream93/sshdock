const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeExternalHttpUrl, normalizeLinkOpenMode } = require("../src/external-link.cjs");

test("允许 HTTP 和 HTTPS 链接", () => {
  assert.equal(normalizeExternalHttpUrl("https://example.com/path?q=1"), "https://example.com/path?q=1");
  assert.equal(normalizeExternalHttpUrl("http://example.com"), "http://example.com/");
});

test("拒绝非网页协议和无效链接", () => {
  assert.equal(normalizeExternalHttpUrl("file:///etc/passwd"), "");
  assert.equal(normalizeExternalHttpUrl("javascript:alert(1)"), "");
  assert.equal(normalizeExternalHttpUrl("not a url"), "");
  assert.equal(normalizeExternalHttpUrl(null), "");
});

test("链接打开方式默认使用系统浏览器", () => {
  assert.equal(normalizeLinkOpenMode("internal"), "internal");
  assert.equal(normalizeLinkOpenMode("external"), "external");
  assert.equal(normalizeLinkOpenMode("unknown"), "external");
  assert.equal(normalizeLinkOpenMode(null), "external");
});
