function normalizeExternalHttpUrl(value) {
  if (typeof value !== "string") return "";

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

module.exports = { normalizeExternalHttpUrl };
