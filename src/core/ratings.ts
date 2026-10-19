import type { DimensionRatings, Scheme, TagAssignment } from './model.ts';
export const ratedDimensions = ['A', 'B', 'C', 'D', 'F', 'G'] as const;
export const questionDimensions = ['A', 'B', 'C', 'F', 'G'];
export const imageRatingDimensions = ['A', 'B', 'C', 'F'];
export const isAnchorMode = (scheme: Scheme) => scheme.rating?.mode === 'anchors';
const descriptions: Record<string, string[]> = {
  A: ['商品、卖点或上架要求严重错误，无法使用', '商品关键信息明显偏差，仅能参考，需重新生成', '基本符合电商场景，需较大修改后使用', '商品与卖点准确，微调排版或细节即可使用', '商品、卖点、版式和上架要求均满足，可直接使用'],
  B: ['未理解核心需求，主体或任务错误', '关键指令未遵循，需重新生成', '主要意图正确，重要元素或约束需较大调整', '核心指令均遵循，少量细节需微调', '主体、属性、场景、风格和构图均准确遵循'],
  C: ['明显畸形、模糊或不真实，无法使用', '结构或质感问题严重，仅能参考', '基本成图，真实感、清晰度或美感需较大修改', '画面质量良好，仅有轻微瑕疵', '结构、细节、光影与商业美感俱佳，可直接使用'],
  D: ['无法完成编辑目标', '编辑困难，或严重破坏原图，需重新生成', '部分达成编辑目标，需要较大修正', '编辑目标基本达成，仅需微调且主体保持完整', '准确完成编辑，其他内容稳定保留'],
  F: ['发现侵权或其他严重风险，不可使用', '存在明显误导或合规问题，需重新生成', '存在待核实风险，需较大修改后再审查', '未见重大风险，轻微表达需修正', '按本题检查要点未发现风险；仍需单独检查商用授权'],
  G: ['本次操作无法完成', '操作困难或中断，勉强完成', '需要摸索或重复操作，流程需明显改善', '有少量不便，不影响完成本次任务', '本次操作顺畅，反馈清晰，无需摸索'],
};
/** Suggested extension, not the original course's label conversion rule. */
export const defaultAnchors = () => Object.fromEntries(Object.entries(descriptions).map(([id, rows]) => [id, rows.map((description, index) => ({ score: index + 1, description }))]));
export function ratingSchemeErrors(scheme: Scheme): string[] {
  const config = scheme.rating;
  if (config === undefined) return [];
  if (!config || !['tags', 'anchors'].includes(config.mode)) return ['评分方式无效'];
  if (!isAnchorMode(scheme)) return [];
  if (!config.anchors || typeof config.anchors !== 'object' || Array.isArray(config.anchors)) return ['锚点评分缺少评分标准'];
  return ratedDimensions.flatMap(id => {
    const rows = config.anchors![id];
    return !Array.isArray(rows) || rows.length !== 5 || [1,2,3,4,5].some(score => rows.filter(row => row && row.score === score && typeof row.description === 'string' && row.description.trim() && row.description.length <= 2000).length !== 1) ? [`${id} 维度需配置完整且不重复的 1–5 分锚点`] : [];
  });
}
export function ratingErrors(scheme: Scheme, ratings: unknown, dimensions: string[], required: boolean): string[] {
  if (ratings === undefined) return required && isAnchorMode(scheme) ? dimensions.map(id => `${id} 维度尚未按锚点打分并填写依据`) : [];
  if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) return ['锚点评分结构无效'];
  const entries = Object.entries(ratings);
  if (!isAnchorMode(scheme) && entries.length) return ['标签换算方案不能混入直接评分'];
  const errors = entries.flatMap(([id, row]) => !dimensions.includes(id) || !row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['score','reason'].includes(key)) || !Number.isInteger(row.score) || row.score < 1 || row.score > 5 || typeof row.reason !== 'string' || row.reason.length > 10000 || (required && !row.reason.trim()) ? [`${id} 维度分数或评分依据无效`] : []);
  if (required && isAnchorMode(scheme)) for (const id of dimensions) if (!(id in ratings)) errors.push(`${id} 维度尚未按锚点打分并填写依据`);
  return errors;
}
export function recordDimensionScore(scheme: Scheme, record: { tags: TagAssignment[]; ratings?: DimensionRatings }, dimension: string): number | null {
  if (isAnchorMode(scheme)) {
    const value = record.ratings?.[dimension];
    return value && !ratingErrors(scheme, { [dimension]: value }, [dimension], true).length ? value.score : null;
  }
  return Math.min(5, ...record.tags.filter(tag => scheme.tags.find(def => def.code === tag.code)?.dimension === dimension).map(tag => ({P0:1,P1:2,P2:3,P3:4})[tag.severity]));
}
