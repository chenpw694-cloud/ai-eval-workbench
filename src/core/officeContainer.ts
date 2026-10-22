import { unzipSync } from 'fflate';

const MiB = 1024 * 1024;
/** Inspect all ZIP entries before handing an Office container to its parser. */
export function inspectOffice(bytes: Uint8Array, required: string, extract: string[] = []): Record<string, Uint8Array> {
  if (bytes.length > 20 * MiB || bytes.length < 22) throw new Error('Office 文件无效或超过 20 MB，请拆分后重试。');
  const seen = new Set<string>(); let total = 0;
  try {
    const entries = unzipSync(bytes, { filter(entry) {
      if (seen.has(entry.name) || entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error('Office 压缩包包含重复或无效路径。');
      seen.add(entry.name); total += entry.originalSize;
      if (seen.size > 10000 || entry.originalSize > 40 * MiB || total > 100 * MiB) throw new Error('Office 文件展开后过大，请减少图片或拆分题库。');
      return extract.includes(entry.name);
    } });
    if (!seen.has('[Content_Types].xml') || !seen.has(required)) throw new Error('文件不是所选的 Office 格式，请使用真正的 .xlsx 或 .docx 文件。');
    return entries;
  } catch (error) {
    if (error instanceof Error && /Office/.test(error.message)) throw error;
    throw new Error('Office 文件无法解压，可能已损坏、加密，或格式不受支持。');
  }
}
