/** Local lifecycle state is kept outside Project so synced identities and hashes stay stable. */
export const PROJECT_TRASH_STORE = 'projectTrash';
export const PROJECT_TRASH_MESSAGE = '该项目已移入回收站，请返回“我的项目 → 回收站”恢复后再继续';
export type ProjectTombstone = { id: string; trashedAt: string };
