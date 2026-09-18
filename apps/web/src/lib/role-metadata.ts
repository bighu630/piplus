/**
 * 角色元数据的单一来源。
 *
 * 前端所有角色 key / 中文标签 / 可选角色列表都从这里取，避免多处重复实现后漂移。
 * planner 的中文标签在前端统一为「负责人」，不要再写成「规划者」。
 *
 * 注意：后端仍有两处「规划者」措辞未在本次前端去重范围内——
 * `packages/domain/src/extensions/role-manager-tools.ts` 的 labelForRole，
 * 以及 `packages/db/src/init.ts` 的内置模板 name；要全局统一需另外改后端。
 */

/** 全部角色（内置角色，保持固定顺序）。 */
export const ROLE_KEYS: Array<{ key: string; label: string }> = [
  { key: 'planner', label: '负责人' },
  { key: 'worker', label: '执行者' },
  { key: 'reviewer', label: '审查者' },
  { key: 'feature_lead', label: '需求负责人' },
  { key: 'bugfix_lead', label: 'Bug负责人' },
  { key: 'blank', label: '空白' },
];

/** 可配置（可分配模型）的角色，planner 由其独立的模型选择器负责。 */
export const CONFIGURABLE_ROLE_KEYS = ROLE_KEYS.filter((r) => r.key !== 'planner');

/** key -> label 映射（由 ROLE_KEYS 派生）。 */
export const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLE_KEYS.map((r) => [r.key, r.label]),
);

/** 取角色中文标签，未知 key 回退为 key 本身。 */
export function getRoleLabel(key: string): string {
  return ROLE_LABELS[key] ?? key;
}

/**
 * Returns all role keys (built-in + custom) with labels for the role-config tab.
 * Built-in roles keep their order, custom roles are appended alphabetically.
 */
export function getAllRoleKeys(
  templates: Array<{ key: string; name: string; isBuiltin: boolean }> | undefined,
): Array<{ key: string; label: string }> {
  const builtinKeys = new Set(ROLE_KEYS.map((r) => r.key));
  const customTemplates = (templates ?? []).filter((t) => !builtinKeys.has(t.key));
  const seenCustom = new Set<string>();
  const customRoles: Array<{ key: string; label: string }> = [];
  for (const t of customTemplates) {
    if (!seenCustom.has(t.key)) {
      seenCustom.add(t.key);
      customRoles.push({ key: t.key, label: t.name });
    }
  }
  customRoles.sort((a, b) => a.key.localeCompare(b.key));
  return [...ROLE_KEYS, ...customRoles];
}
