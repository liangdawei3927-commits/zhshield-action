/** 从 unknown 类型的 catch 错误中安全提取 message */
export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
