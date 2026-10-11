// Reduce a JSON value to its structure: key names and types, never values.
// Arrays are summarised by merging the shapes of up to `sample` items.
export function shapeOf(value, depth = 0, sample = 20) {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    let merged;
    for (const item of value.slice(0, sample)) merged = mergeShapes(merged, shapeOf(item, depth + 1, sample));
    return { "[]": merged ?? "empty" };
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = shapeOf(value[key], depth + 1, sample);
    return out;
  }
  return typeof value;
}

export function mergeShapes(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (isObj(a) && isObj(b)) {
    if ("[]" in a && "[]" in b) return { "[]": mergeShapes(a["[]"], b["[]"]) };
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = mergeShapes(a[k], v);
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const types = new Set([...asList(a), ...asList(b)].map((t) => (typeof t === "string" ? t : JSON.stringify(t))));
  return [...types].sort().join("|");
}

// /api/contacts/8f3a.../notes?page=2&q=smith -> /api/contacts/:id/notes?page&q
// Ids, numbers and anything that looks like personal data in the path are replaced.
export function templatePath(rawUrl) {
  const url = new URL(rawUrl);
  const path = url.pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":n";
      if (/^[0-9a-f-]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg)) return ":id";
      if (/@|%40|^\+?\d[\d\s-]{6,}$/.test(decodeURIComponent(seg))) return ":pii";
      return seg;
    })
    .join("/");
  const params = [...new Set(url.searchParams.keys())].sort();
  return url.host + path + (params.length ? "?" + params.join("&") : "");
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const asList = (v) => (typeof v === "string" ? v.split("|") : [v]);
