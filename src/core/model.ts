import type { Severity } from './scoring.ts';

export type DimensionId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type ProductRole = 'self' | 'direct' | 'benchmark' | 'alternative';
export type Member = { id: string; name: string };
export type Product = {
  id: string; name: string; version: string; role: ProductRole; demo: boolean;
  ownerId: string; totalCost: number | null;
  commercialUse: 'unreviewed' | 'allowed' | 'unclear' | 'forbidden';
  commercialEvidence: string;
};
export type Question = {
  id: string; title: string; scene: string; category: string; difficulty: string;
  request: string; acceptance: string[]; referenceNames: string[];
  fields: Record<string, string>;
};
export type TagDefinition = { code: string; name: string; dimension: string; severity: Severity };
export type TagAssignment = { code: string; severity: Severity };
export type DimensionRating = { score: number; reason: string };
export type DimensionRatings = Record<string, DimensionRating>;
export type Scheme = {
  rating?: { mode: 'tags' | 'anchors'; anchors?: Record<string, { score: number; description: string }[]> };
  id: string; name: string; version: string;
  jointReview?: import('./joint.ts').JointPolicy;
  dimensions: { id: string; name: string; weight: number; method: string }[];
  tags: TagDefinition[];
  policies: {
    failedNoOutput: 'unresolved' | 'score-one' | 'exclude';
    rankingTies: 'unresolved' | 'dense';
    zeroUsableCost: 'unresolved' | 'score-one';
  };
};
export type Project = {
  id: string; name: string; background: string; period: string;
  members: Member[]; products: Product[]; questions: Question[];
  scheme: Scheme; rulesConfirmed: boolean; expectedQuestionCount: number;
  status: 'draft' | 'active'; revision: number; createdAt: string; updatedAt: string;
  schemeHash: string; questionsHash: string;
  sourceSnapshot?: { packageId: string; revision: number };
};
export type Asset = {
  id: string; projectId: string; questionId: string; productId: string | null;
  role: 'reference' | 'output'; name: string; mime: string; size: number;
  sha256: string; blob: Blob; createdAt: string;
};
export type AssetMetadata = Omit<Asset, 'blob'>;
export type MediaCheck = { mediaId: string; usable: boolean | null; infringement: boolean | null };
export type Evaluation = {
  id: string; projectId: string; questionId: string; productId: string;
  reviewerId: string; revision: number; parentId: string | null;
  status: 'draft' | 'submitted'; mediaIds: string[]; bestMediaId: string | null;
  mediaChecks: MediaCheck[]; tags: TagAssignment[]; ratings?: DimensionRatings;
  seconds: number | null; failed: boolean; failureReason: string; notes: string;
  schemeHash: string; questionsHash: string; createdAt: string;
};
export type Walkthrough = {
  id: string; projectId: string; productId: string;
  task: 'background' | 'color' | 'expand'; status: 'draft' | 'submitted';
  completed: boolean; steps: number | null; tags: TagAssignment[]; ratings?: DimensionRatings; notes: string;
};
export type Experience = { productId: string; score: number | null; notes: string };
export type ProjectBundle = {
  project: Project; evaluations: Evaluation[]; assets: AssetMetadata[];
  walkthroughs: Walkthrough[]; experiences: Experience[];
  quality?: import('./quality.ts').QualityState;
};
export type StageAudit = {
  id: string; projectId: string; packageId: string; importedAt: string; manifestHash?: string;
  senderId: string; kind: 'assignment' | 'submission' | 'baseline';
  counts: Record<string, number>; decisions: Record<string, 'local' | 'incoming'>;
  resolverId: string; reason: string; conflicts: unknown[];
  incoming: ProjectBundle; before: ProjectBundle | null;
};
export type Metric = { value: number | null; complete: boolean; n: number; expected: number; reasons: string[] };
export type ProductResult = {
  productId: string; dimensions: Record<DimensionId, Metric>;
  total: number | null; submitted: number; expected: number;
  usableRate: number | null; meanSeconds: number | null; costPerUsable: number | null;
  generated: number; usable: number; infringementRate: number | null;
  eligibility: 'eligible' | 'vetoed' | 'pending' | 'simulated';
  vetoReasons: string[]; missing: string[];
};
