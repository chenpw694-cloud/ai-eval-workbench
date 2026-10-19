import type { Severity } from '../core/scoring';
import scheme from '../../schemes/ecommerce-t2i/scheme.json';

export type Page = 'overview' | 'scheme' | 'tasks' | 'quality' | 'compare' | 'dashboard' | 'report' | 'sync';
export type Tag = { code: string; name: string; dimension: string; severity: Severity };
export const tags = scheme.tags as Tag[];
export const dimensions = scheme.dimensions;
export const products = [
  { id: 'self', name: '自家产品', role: '自家 · 模拟', letter: 'S', color: 'violet', done: 50, total: 50, usable: 78, demo: true },
  { id: 'p1', name: '竞品 A', role: '直接竞品', letter: 'A', color: 'blue', done: 42, total: 50, usable: 72, demo: false },
  { id: 'p2', name: '竞品 B', role: '标杆竞品', letter: 'B', color: 'orange', done: 38, total: 50, usable: 81, demo: false },
  { id: 'p3', name: '竞品 C', role: '替代竞品', letter: 'C', color: 'green', done: 46, total: 50, usable: 66, demo: false }
];
export const scenes = ['白底主图', '场景图', '详情图', '营销海报'];
export const categories = ['美妆', '服饰', '数码产品', '厨房用具'];
const requests = [
  '帮我做一张这瓶精华液的场景图，放在浅米色台面上，背景简洁自然，有窗边柔光。瓶身与参考图一致，商品居中。',
  '给这款白色蓝牙耳机做一张白底主图，正面展示，突出充电盒和耳机的精细结构。',
  '做一张这款不粘锅的促销海报，写上“新品首发 限时 8 折”，放在厨房场景里。',
  '给这款纯棉衬衫做一张产品详情图，展示面料纹理与领口做工，画面干净清晰。'
];
export const questions = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1,
  scene: ['场景图', '白底主图', '营销海报', '详情图'][i % 4],
  category: ['美妆', '数码产品', '厨房用具', '服饰'][i % 4],
  difficulty: i < 30 ? '基础' : i < 45 ? '进阶' : '困难',
  title: ['精华液 · 自然光场景展示', '蓝牙耳机 · 白底商品展示', '不粘锅 · 促销氛围图', '纯棉衬衫 · 材质细节'][i % 4],
  request: requests[i % 4],
  status: i < 42 ? '已完成' : i === 42 ? '进行中' : '待评测'
}));
export type EvaluationRecord = { questionId: number; productId: string; selectedTags: string[]; bestImage: number; notes: string; seconds: number; total: number; usable: number; failed: boolean; status: 'draft' | 'submitted'; updatedAt: string };
