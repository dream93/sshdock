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

function normalizeLinkOpenMode(value) {
  return value === "internal" ? "internal" : "external";
}

module.exports = { normalizeExternalHttpUrl, normalizeLinkOpenMode };
