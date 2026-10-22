import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
export const MAX_HANDOFF_BYTES = 256 * 1024 * 1024;
const HEADER = 'eval-studio-handoff.json';
type SourceFile = { name: string; blob: Blob };
type Entry = { path: string; name: string; size: number; sha256: string; role: 'data' | 'preview' | 'readme' };
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(value => value.toString(16).padStart(2, '0')).join('');
const safeName = (name: unknown): name is string => typeof name === 'string' && !!name && name.length <= 160 && !/[\\/\u0000-\u001F]/.test(name) && name !== '.' && !name.includes('..');

/** A readable envelope. Inner project manifests and media ZIPs stay byte-for-byte intact. */
export async function buildHandoff(files: SourceFile[], preview?: Blob): Promise<Blob> {
  if (!files.length || files.length > 260 || new Set(files.map(file => file.name)).size !== files.length || files.some(file => !safeName(file.name))) throw new Error('交接文件清单无效或重复，无法打包。');
  if (files.reduce((n, file) => n + file.blob.size, 0) + (preview?.size ?? 0) > MAX_HANDOFF_BYTES - 1024 * 1024) throw new Error('单个交接包上限为 256 MB，请使用下方的原清单和 ZIP 分包下载。');
  const sources: (SourceFile & { role: Entry['role'] })[] = files.map(file => ({ ...file, role: 'data' }));
  if (preview) sources.push({ name: '评测明细.xlsx', blob: preview, role: 'preview' });
  sources.push({ name: '交接说明.txt', role: 'readme', blob: new Blob(['Eval Studio 团队交接包\n\n接收者：在工作台选择整个 ZIP，预览后确认导入，无需解压或寻找 JSON。\n\n查看者：解压后打开“评测明细.xlsx”（如有）查看本次评分；files 文件夹是完整项目与图片，请保留。Excel 只是阅读副本，修改 Excel 不会更改包内的正式评分。请在工作台更正评分后重新导出。\n\n独立评审任务包请在“独立评审空间”导入；独立判断返回包请在“自家对比 GSB”或“质量控制”收回。归档包请在“版本归档”校验。\n'], { type: 'text/plain;charset=utf-8' }) });
  const entries: Entry[] = [], zipped: Record<string, Uint8Array> = {};
  for (const file of sources) { const path = file.role === 'data' ? `files/${file.name}` : file.name, bytes = new Uint8Array(await file.blob.arrayBuffer()); zipped[path] = bytes; entries.push({ path, name: file.name, size: bytes.length, sha256: await sha(bytes), role: file.role }); }
  zipped[HEADER] = strToU8(JSON.stringify({ format: 'eval-studio-readable-handoff', schemaVersion: 1, files: entries }));
  return new Blob([zipSync(zipped, { level: 0 })], { type: 'application/zip' });
}

export async function unpackHandoff(files: File[]): Promise<File[]> {
  if (files.length !== 1 || !/\.zip$/i.test(files[0].name)) return files;
  if (files[0].size > MAX_HANDOFF_BYTES) throw new Error('单个 ZIP 超过 256 MB，请使用原清单和 ZIP 分包导入。');
  const bytes = new Uint8Array(await files[0].arrayBuffer());
  const names = new Set<string>(); let total = 0;
  let header: Record<string, Uint8Array>;
  try { header = unzipSync(bytes, { filter(entry) {
    if (names.has(entry.name) || entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error('交接包包含重复或不安全路径。');
    names.add(entry.name); total += entry.originalSize;
    if (names.size > 300 || total > MAX_HANDOFF_BYTES || entry.name === HEADER && entry.originalSize > 1024 * 1024) throw new Error('交接包展开后过大或文件过多。');
    return entry.name === HEADER;
  } }); } catch (error) { throw new Error(error instanceof Error ? `ZIP 无法读取：${error.message}` : 'ZIP 已损坏或无法读取。'); }
  if (!header[HEADER]) return files; // An ordinary legacy media part still follows its existing checks.
  let manifest: { format: string; schemaVersion: number; files: Entry[] };
  try { manifest = JSON.parse(strFromU8(header[HEADER])); } catch { throw new Error('交接包说明损坏，请重新导出。'); }
  if (manifest.format !== 'eval-studio-readable-handoff' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 262 || manifest.files.length + 1 !== names.size) throw new Error('不是受支持的团队交接包，或文件清单不完整。');
  const listed = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || !safeName(entry.name) || !['data','preview','readme'].includes(entry.role) || entry.path !== (entry.role === 'data' ? `files/${entry.name}` : entry.name) || listed.has(entry.path) || !names.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_HANDOFF_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('交接包的文件路径、大小或校验信息无效。');
    listed.add(entry.path);
  }
  const entries = unzipSync(bytes, { filter(entry) { return listed.has(entry.name); } });
  const result: File[] = [];
  for (const entry of manifest.files) {
    const content = entries[entry.path];
    if (!content || content.length !== entry.size || await sha(content) !== entry.sha256) throw new Error(`交接包文件缺失或已被修改：${entry.name}。请使用原始 ZIP。`);
    if (entry.role === 'data') result.push(new File([content], entry.name));
  }
  if (!result.length) throw new Error('交接包中没有可导入的工作台数据。');
  return result;
}
