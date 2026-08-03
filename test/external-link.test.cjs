const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeExternalHttpUrl } = require("../src/external-link.cjs");

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
