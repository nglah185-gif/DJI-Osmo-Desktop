const UNKNOWN = "UNKNOWN";

function unknown(value) {
  return value === undefined || value === null || value === "" ? UNKNOWN : value;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return UNKNOWN;
  const number = Number(value);
  return Number.isFinite(number) ? number : UNKNOWN;
}

function parseRational(value) {
  if (typeof value !== "string" || !value.includes("/")) return UNKNOWN;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return UNKNOWN;
  return { numerator, denominator, value: numerator / denominator };
}

function parseRotation(value) {
  const rotation = parseNumber(value);
  return rotation === UNKNOWN ? UNKNOWN : rotation;
}

function normalizeMetadata(tags) {
  if (!tags || typeof tags !== "object") return {};
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, String(value)]));
}

module.exports = { UNKNOWN, unknown, parseNumber, parseRational, parseRotation, normalizeMetadata };
