export function formatToolInput(input: unknown, maxLength = 300): string {
  try {
    const s = JSON.stringify(input);
    if (!s) return "";
    return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
  } catch {
    return "";
  }
}
