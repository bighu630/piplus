import React, { useState, useCallback, useEffect, useRef } from 'react';
import Modal from './Modal';
import Select from './Select';
import { PlusCircle } from 'lucide-react';
import { useRoleTemplates } from '../lib/hooks';
import { renderRoleIcon } from '../lib/role-icons';
import { THINKING_LEVEL_DISPLAY_LABELS } from '../lib/thinking-levels';
import type { RoleConfigEntry } from '../lib/api';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (projectId: string, sessionId: string) => void;
  modelsQueryData: any;
  modelsQueryLoading: boolean;
  createProjectMut: any;
  setProjectRoleModelsMut: any;
}

const ROLE_CONFIG_KEYS = [
  { key: 'planner', label: '负责人' },
  { key: 'worker', label: '执行者' },
  { key: 'reviewer', label: '审查者' },
  { key: 'feature_lead', label: '需求负责人' },
  { key: 'bugfix_lead', label: 'Bug负责人' },
  { key: 'blank', label: '空白' },
];

const CONFIGURABLE_ROLE_KEYS = ROLE_CONFIG_KEYS.filter((r) => r.key !== 'planner');

/**
 * Returns all role keys (built-in + custom) with labels for the role-config tab.
 * Built-in roles keep their order, custom roles are appended alphabetically.
 */
function getAllRoleKeys(templates: Array<{ key: string; name: string; isBuiltin: boolean }> | undefined): Array<{ key: string; label: string }> {
  const builtinKeys = new Set(ROLE_CONFIG_KEYS.map((r) => r.key));
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
  return [...ROLE_CONFIG_KEYS, ...customRoles];
}

const getModelThinkingLevels = (modelKey: string, modelsQueryData: any): string[] => {
  if (!modelKey || !modelsQueryData) return [];
  const [provider, id] = modelKey.split('/');
  if (!provider || !id) return [];
  const model = modelsQueryData.find((m: any) => m.provider === provider && m.id === id);
  return model?.availableThinkingLevels ?? [];
};

const thinkingLevelOptionsForSelect = (levels: string[]) =>
  levels.map((level) => ({ value: level, label: THINKING_LEVEL_DISPLAY_LABELS[level] ?? level }));

export default function CreateProjectModal({
  isOpen,
  onClose,
  onCreated,
  modelsQueryData,
  modelsQueryLoading,
  createProjectMut,
  setProjectRoleModelsMut,
}: CreateProjectModalProps) {
  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'existing' | 'git_clone'>('existing');
  const [createPath, setCreatePath] = useState('');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [createProjectModelKey, setCreateProjectModelKey] = useState('');
  const [createPlannerThinkingLevel, setCreatePlannerThinkingLevel] = useState('');
  const [createProjectRoleModels, setCreateProjectRoleModels] = useState<Record<string, Array<{ provider: string; id: string; thinkingLevel?: string | null }>>>({});
  const [createRoleConfig, setCreateRoleConfig] = useState<Record<string, RoleConfigEntry>>({});
  const [createGitUserName, setCreateGitUserName] = useState('');
  const [createGitUserEmail, setCreateGitUserEmail] = useState('');
  const [createGitToken, setCreateGitToken] = useState('');
  const roleTemplatesQuery = useRoleTemplates();

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    // 刚打开弹窗：重置为默认值（内置启用内置版本 + 自定义禁用）
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      const defaults: Record<string, RoleConfigEntry> = {};
      for (const r of ROLE_CONFIG_KEYS) defaults[r.key] = { enabled: true, version: '内置' };
      setCreateRoleConfig(defaults);
    }
    // 模板数据到达/刷新时补全缺失的自定义角色（不覆盖用户已编辑项）
    const builtinKeys = new Set(ROLE_CONFIG_KEYS.map((r) => r.key));
    const customTemplates = (roleTemplatesQuery.data ?? []).filter((t) => !builtinKeys.has(t.key));
    if (customTemplates.length > 0) {
      setCreateRoleConfig((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const t of customTemplates) {
          if (!next[t.key]) {
            next[t.key] = { enabled: false };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [isOpen, roleTemplatesQuery.data]);

  const handleCreateProject = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;
    try {
      const result = await createProjectMut.mutateAsync({
        name: createName.trim(),
        mode: createMode,
        path: createMode === 'existing' ? createPath : undefined,
        repoUrl: createMode === 'git_clone' ? createRepoUrl : undefined,
        model: createProjectModelKey ? (() => {
          const [provider, id] = createProjectModelKey.split('/');
          return provider && id
            ? {
                provider,
                id,
                label: createProjectModelKey,
                ...(createPlannerThinkingLevel ? { thinkingLevel: createPlannerThinkingLevel } : {}),
              }
            : null;
        })() : null,
        gitConfig: createGitUserName || createGitUserEmail || createGitToken
          ? { userName: createGitUserName || undefined, userEmail: createGitUserEmail || undefined, token: createGitToken || undefined }
          : undefined,
        roleConfig: createRoleConfig,
      });
      // Save role default models after project creation
      const mergedRoleDefaults: Record<string, any> = {};
      for (const [roleKey, models] of Object.entries(createProjectRoleModels)) {
        if (models.length > 0 && models[0].provider && models[0].id) {
          const entry: any = {
            provider: models[0].provider,
            id: models[0].id,
          };
          if (models[0].thinkingLevel) entry.thinkingLevel = models[0].thinkingLevel;
          if (models.length > 1) {
            entry.candidateModels = models.slice(1).map(m => ({
              provider: m.provider,
              id: m.id,
              ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
            }));
          }
          mergedRoleDefaults[roleKey] = entry;
        }
      }
      if (Object.keys(mergedRoleDefaults).length > 0) {
        try {
          await setProjectRoleModelsMut.mutateAsync({ projectId: result.projectId, models: mergedRoleDefaults });
        } catch { /* non-critical */ }
      }
      onClose();
      setCreateName('');
      setCreatePath('');
      setCreateRepoUrl('');
      setCreateProjectModelKey('');
      setCreatePlannerThinkingLevel('');
      setCreateProjectRoleModels({});
      setCreateRoleConfig({});
      setCreateGitUserName('');
      setCreateGitUserEmail('');
      setCreateGitToken('');
      onCreated(result.projectId, result.sessionId);
    } catch {}
  }, [createName, createMode, createPath, createRepoUrl, createProjectModelKey, createProjectMut, createProjectRoleModels, createRoleConfig, setProjectRoleModelsMut, onClose, onCreated]);

  const handleCreateProjectRoleModelChange = useCallback((roleKey: string, index: number, value: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      while (models.length <= index) {
        models.push({ provider: '', id: '', thinkingLevel: null });
      }
      if (!value) {
        models[index] = { ...models[index], provider: '', id: '' };
      } else {
        const [provider, id] = value.split('/');
        models[index] = { ...models[index], provider, id };
      }
      return { ...prev, [roleKey]: models };
    });
  }, []);

  const handleCreateProjectRoleThinkingLevelChange = useCallback((roleKey: string, index: number, level: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index < models.length) {
        models[index] = { ...models[index], thinkingLevel: level || null };
      }
      return { ...prev, [roleKey]: models };
    });
  }, []);

  const handleCreateProjectAddCandidate = useCallback((roleKey: string) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      models.push({ provider: '', id: '', thinkingLevel: null });
      return { ...prev, [roleKey]: models };
    });
  }, []);

  const handleCreateProjectRemoveCandidate = useCallback((roleKey: string, index: number) => {
    setCreateProjectRoleModels((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index > 0 && index < models.length) {
        models.splice(index, 1);
      }
      return { ...prev, [roleKey]: models };
    });
  }, []);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="新建项目" icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />} maxWidthClassName="max-w-[691px]">
      <form onSubmit={handleCreateProject} className="space-y-4">
        <div>
          <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">项目名称 <span className="text-red-500">*</span></label>
          <input required autoFocus type="text" placeholder="请输入项目名称..." value={createName} onChange={(e) => setCreateName(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">模式</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setCreateMode('existing')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${createMode === 'existing' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>绑定目录</button>
            <button type="button" onClick={() => setCreateMode('git_clone')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${createMode === 'git_clone' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Git Clone</button>
          </div>
        </div>
        {createMode === 'existing' ? (
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">项目路径 <span className="text-red-500">*</span></label>
            <input required type="text" placeholder="/path/to/project" value={createPath} onChange={(e) => setCreatePath(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>
        ) : (
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 仓库地址 <span className="text-red-500">*</span></label>
            <input required type="text" placeholder="https://github.com/user/repo 或 git@github.com:user/repo" pattern="^(https?://.+|git@.+:.+)$" title="请输入有效的 Git 仓库地址，如 https://github.com/user/repo 或 git@github.com:user/repo" value={createRepoUrl} onChange={(e) => setCreateRepoUrl(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>
        )}
        <div>
          <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">负责人模型</label>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Select
                value={createProjectModelKey}
                onChange={(v) => { setCreateProjectModelKey(v); setCreatePlannerThinkingLevel(''); }}
                options={[
                  { value: '', label: '使用默认模型' },
                  ...(modelsQueryData ?? []).map((m: any) => ({
                    value: `${m.provider}/${m.id}`,
                    label: `${m.provider} / ${m.label}`,
                  })),
                ]}
                searchable
                className="w-full"
              />
            </div>
            {(() => {
              const levels = getModelThinkingLevels(createProjectModelKey, modelsQueryData);
              if (!levels.length) return null;
              return (
                <div className="w-36 shrink-0">
                  <Select
                    value={createPlannerThinkingLevel}
                    onChange={setCreatePlannerThinkingLevel}
                    options={[
                      { value: '', label: '未设置' },
                      ...thinkingLevelOptionsForSelect(levels),
                    ]}
                    placeholder="思考层级"
                  />
                </div>
              );
            })()}
          </div>
        </div>
        <details className="group">
          <summary className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 select-none">
            角色设置
          </summary>
          <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
            {getAllRoleKeys(roleTemplatesQuery.data).map((role) => {
              const config = createRoleConfig[role.key] ?? {};
              const roleEnabled = config.enabled !== false;
              const roleVersions = (roleTemplatesQuery.data ?? [])
                .filter((t) => t.key === role.key)
                .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
              const isBuiltin = ROLE_CONFIG_KEYS.some((r) => r.key === role.key);
              return (
                <div key={role.key} className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-3 py-2">
                  <div className="flex items-center gap-3 flex-1">
                    <span className="mr-1">{renderRoleIcon(roleVersions[0]?.icon, 'w-4 h-4')}</span>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 w-24 shrink-0">{role.label}</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 w-16 shrink-0">{role.key}</span>
                    <div className="flex-1 min-w-0 relative">
                      {roleEnabled ? (
                        <select
                          value={config.version ?? ''}
                          onChange={(e) => setCreateRoleConfig((prev) => ({
                            ...prev,
                            [role.key]: { ...prev[role.key], version: e.target.value || undefined },
                          }))}
                          className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                        >
                          {isBuiltin ? (
                            <option value="内置">内置</option>
                          ) : (
                            <>
                              <option value="">使用最新版本</option>
                              {roleVersions.map((v) => (
                                <option key={v.id} value={v.version}>{v.version === '内置' ? '内置' : `v${v.version}`}</option>
                              ))}
                            </>
                          )}
                        </select>
                      ) : (
                        <div className="flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/50 min-h-[30px] px-2">
                          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">角色未启用</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3 shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={roleEnabled}
                      onChange={(e) => setCreateRoleConfig((prev) => ({
                        ...prev,
                        [role.key]: { ...prev[role.key], enabled: e.target.checked },
                      }))}
                    />
                    <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
              );
            })}
          </div>
        </details>
        <details className="group">
          <summary className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 select-none">
            角色默认模型（可选）
          </summary>
          <div className="mt-2 space-y-3 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
            {CONFIGURABLE_ROLE_KEYS.map((role) => {
              const models = createProjectRoleModels[role.key] ?? [];
              const displayModels = models.length === 0 ? [null] : models;
              return (
                <div key={role.key}>
                  {displayModels.map((model, idx) => {
                    const modelKey = model ? `${model.provider}/${model.id}` : '';
                    const levels = getModelThinkingLevels(modelKey, modelsQueryData);
                    return (
                      <div key={idx} className="flex items-center gap-3 mb-2">
                        <span className="text-xs text-slate-600 dark:text-slate-400 w-20 shrink-0">{idx === 0 ? role.label : ''}</span>
                        <div className="flex-1">
                          <Select
                            value={modelKey}
                            onChange={(v) => handleCreateProjectRoleModelChange(role.key, idx, v)}
                            options={[
                              { value: '', label: '继承（使用默认模型）' },
                              ...(modelsQueryData ?? []).map((m: any) => ({
                                value: `${m.provider}/${m.id}`,
                                label: `${m.provider} / ${m.label}`,
                              })),
                            ]}
                            searchable
                            className="w-full"
                          />
                        </div>
                        {levels.length > 0 && (
                          <div className="w-28 shrink-0">
                            <Select
                              value={model?.thinkingLevel ?? ''}
                              onChange={(v) => handleCreateProjectRoleThinkingLevelChange(role.key, idx, v)}
                              options={[
                                { value: '', label: '未设置' },
                                ...thinkingLevelOptionsForSelect(levels),
                              ]}
                              placeholder="思考"
                            />
                          </div>
                        )}
                        {idx === 0 ? (
                          <button
                            type="button"
                            onClick={() => handleCreateProjectAddCandidate(role.key)}
                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded cursor-pointer shrink-0"
                            title="添加候选模型"
                          >+</button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleCreateProjectRemoveCandidate(role.key, idx)}
                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded cursor-pointer shrink-0"
                            title="移除候选模型"
                          >×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </details>
        <details className="group">
          <summary className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 select-none">
            Git 配置（可选）
          </summary>
          <div className="mt-2 space-y-3 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 用户名</label>
              <input type="text" placeholder="git user name" value={createGitUserName} onChange={(e) => setCreateGitUserName(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 邮箱</label>
              <input type="email" placeholder="git user email" value={createGitUserEmail} onChange={(e) => setCreateGitUserEmail(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git Token</label>
              <input type="password" placeholder="personal access token" value={createGitToken} onChange={(e) => setCreateGitToken(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
            </div>
          </div>
        </details>
        <div className="flex space-x-2 pt-3 justify-end border-t border-slate-150 dark:border-slate-800">
          <button type="button" onClick={() => { onClose(); setCreateProjectRoleModels({}); setCreateRoleConfig({}); }} className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer">取消</button>
          <button type="submit" disabled={createProjectMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs hover:shadow-xs transition cursor-pointer disabled:opacity-50">{createProjectMut.isPending ? '创建中…' : '确认创建'}</button>
        </div>
      </form>
    </Modal>
  );
}
