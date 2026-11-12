/**
 * The session trace is a diagnostic log, not the debate: capping a tool output
 * there does not truncate anything an agent said (spec D6).
 */

export const TRACE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function capTraceOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= TRACE_OUTPUT_LIMIT_BYTES) return output;

  let end = TRACE_OUTPUT_LIMIT_BYTES;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a code point start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;

  const kept = bytes.subarray(0, end).toString("utf8");
  return `${kept}\n[... ${bytes.length - end} bytes omitted]`;
}
