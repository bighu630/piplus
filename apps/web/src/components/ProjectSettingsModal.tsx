import React, { useState, useCallback, useEffect } from 'react';
import Modal from './Modal';
import Select from './Select';
import { Settings, RefreshCw, Trash2 } from 'lucide-react';
import { useProjectRoleModels, useProjectGitConfig, useUpdateProjectGitConfigMutation, useDeleteProjectGitConfigMutation, useProjectRoleConfig, useSetProjectRoleConfigMutation, useRoleTemplates } from '../lib/hooks';
import type { RoleConfigEntry } from '../lib/api';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  modelsQueryData: any;
  packagesQueryData: any;
  projectPackagesQueryData: any;
  projectPackagesUpdatesQueryData: any;
  projectPackagesUpdatesRefetch: () => void;
  projectPackagesRefetch: () => void;
  installPkgMut: any;
  removePkgMut: any;
  updatePkgMut: any;
  togglePkgMut: any;
  setProjectRoleModelsMut: any;
}

import { ROLE_ICON_NAMES, renderRoleIcon } from '../lib/role-icons';

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

const THINKING_LABELS: Record<string, string> = {
  off: '思考：关',
  minimal: '思考：最低',
  low: '思考：低',
  medium: '思考：中',
  high: '思考：高',
  xhigh: '思考：最高',
};

export default function ProjectSettingsModal({
  isOpen,
  onClose,
  projectId,
  modelsQueryData,
  packagesQueryData,
  projectPackagesQueryData,
  projectPackagesUpdatesQueryData,
  projectPackagesUpdatesRefetch,
  projectPackagesRefetch,
  installPkgMut,
  removePkgMut,
  updatePkgMut,
  togglePkgMut,
  setProjectRoleModelsMut,
}: ProjectSettingsModalProps) {
  const [projectSettingsTab, setProjectSettingsTab] = useState<'roles' | 'packages' | 'git' | 'role-config'>('roles');
  const [editRoleModelsList, setEditRoleModelsList] = useState<Record<string, Array<{ provider: string; id: string; thinkingLevel?: string | null }>>>({});
  const [projectPackageSource, setProjectPackageSource] = useState('');
  const [projectPackageError, setProjectPackageError] = useState<string | null>(null);
  const [projectPackageSuccess, setProjectPackageSuccess] = useState<string | null>(null);
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [gitSaveSuccess, setGitSaveSuccess] = useState<string | null>(null);
  const [gitSaveError, setGitSaveError] = useState<string | null>(null);
  const [editRoleConfig, setEditRoleConfig] = useState<Record<string, RoleConfigEntry>>({});
  const roleTemplatesQuery = useRoleTemplates();
  const projectRoleConfigQuery = useProjectRoleConfig(isOpen ? projectId : null);
  const setProjectRoleConfigMut = useSetProjectRoleConfigMutation();

  const projectGitConfigQuery = useProjectGitConfig(isOpen ? projectId : null);
  const updateProjectGitConfigMut = useUpdateProjectGitConfigMutation();
  const deleteProjectGitConfigMut = useDeleteProjectGitConfigMutation();

  const projectRoleModelsQuery = useProjectRoleModels(isOpen ? projectId : null);

  const getModelThinkingLevels = useCallback((modelKey: string): string[] => {
    if (!modelKey || !modelsQueryData) return [];
    const [provider, id] = modelKey.split('/');
    if (!provider || !id) return [];
    const model = modelsQueryData.find((m: any) => m.provider === provider && m.id === id);
    if (!model) return [];
    if (!model.reasoning) return ['off'];
    if (!model.thinkingLevelMap) return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    return Object.keys(model.thinkingLevelMap);
  }, [modelsQueryData]);

  const thinkingLevelOptionsForSelect = useCallback((levels: string[]) =>
    levels.map((level) => ({
      value: level,
      label: THINKING_LABELS[level] ?? level,
    })),
  []);

  // Populate editRoleModels when the modal opens and data arrives
  // Includes built-in roles + custom roles from templates
  useEffect(() => {
    if (isOpen && projectRoleModelsQuery.data) {
      const initial: Record<string, Array<{ provider: string; id: string; thinkingLevel?: string | null }>> = {};
      const modelRoles = (getAllRoleKeys(roleTemplatesQuery.data) as Array<{ key: string; label: string }>).filter((r) => r.key !== 'planner');
      for (const role of modelRoles) {
        const model = projectRoleModelsQuery.data[role.key];
        if (model) {
          const models: Array<{ provider: string; id: string; thinkingLevel?: string | null }> = [
            { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel ?? null },
          ];
          if (Array.isArray((model as any).candidateModels)) {
            for (const cm of (model as any).candidateModels) {
              models.push({ provider: cm.provider, id: cm.id, thinkingLevel: cm.thinkingLevel ?? null });
            }
          }
          initial[role.key] = models;
        } else {
          initial[role.key] = [];
        }
      }
      setEditRoleModelsList(initial);
    }
  }, [isOpen, projectRoleModelsQuery.data, roleTemplatesQuery.data]);

  // Populate git config when modal opens
  useEffect(() => {
    if (isOpen && projectGitConfigQuery.data) {
      setGitUserName(projectGitConfigQuery.data.userName ?? '');
      setGitUserEmail(projectGitConfigQuery.data.userEmail ?? '');
      setGitToken('');
      setGitSaveSuccess(null);
      setGitSaveError(null);
    }
  }, [isOpen, projectGitConfigQuery.data]);

  // Populate role config when modal opens
  // Built-in roles default to enabled, custom roles default to disabled
  useEffect(() => {
    if (isOpen && projectRoleConfigQuery.data) {
      const apiConfig = projectRoleConfigQuery.data as Record<string, RoleConfigEntry | null>;
      const merged: Record<string, RoleConfigEntry> = {};

      // Built-in roles: default enabled if not in project config
      for (const r of ROLE_CONFIG_KEYS) {
        merged[r.key] = apiConfig[r.key] ?? { enabled: true };
      }

      // Custom roles from templates: default disabled if not in project config
      const builtinKeys = new Set(ROLE_CONFIG_KEYS.map((r) => r.key));
      for (const t of roleTemplatesQuery.data ?? []) {
        if (!builtinKeys.has(t.key) && !merged[t.key]) {
          merged[t.key] = apiConfig[t.key] ?? { enabled: false };
        }
      }

      setEditRoleConfig(merged);
    }
  }, [isOpen, projectRoleConfigQuery.data, roleTemplatesQuery.data]);

  const wrappedOnClose = useCallback(() => {
    setEditRoleModelsList({});
    setEditRoleConfig({});
    setProjectPackageError(null);
    setProjectPackageSuccess(null);
    setProjectPackageSource('');
    setGitUserName('');
    setGitUserEmail('');
    setGitToken('');
    setGitSaveSuccess(null);
    setGitSaveError(null);
    onClose();
  }, [onClose]);

  const handleSaveProjectRoleModels = useCallback(async () => {
    if (!projectId) return;
    const models: Record<string, any> = {};
    for (const [roleKey, modelList] of Object.entries(editRoleModelsList)) {
      if (modelList.length > 0 && modelList[0].provider && modelList[0].id) {
        const entry: any = {
          provider: modelList[0].provider,
          id: modelList[0].id,
        };
        if (modelList[0].thinkingLevel) entry.thinkingLevel = modelList[0].thinkingLevel;
        if (modelList.length > 1) {
          entry.candidateModels = modelList.slice(1).map(m => ({
            provider: m.provider,
            id: m.id,
            ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
          }));
        }
        models[roleKey] = entry;
      } else {
        models[roleKey] = null;
      }
    }
    await setProjectRoleModelsMut.mutateAsync({ projectId, models });
    wrappedOnClose();
  }, [projectId, editRoleModelsList, setProjectRoleModelsMut, wrappedOnClose]);

  const handleEditRoleModelChange = useCallback((roleKey: string, index: number, value: string) => {
    setEditRoleModelsList((prev) => {
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

  const handleEditRoleThinkingLevelChange = useCallback((roleKey: string, index: number, level: string) => {
    setEditRoleModelsList((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index < models.length) {
        models[index] = { ...models[index], thinkingLevel: level || null };
      }
      return { ...prev, [roleKey]: models };
    });
  }, []);

  const handleEditAddCandidate = useCallback((roleKey: string) => {
    setEditRoleModelsList((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      models.push({ provider: '', id: '', thinkingLevel: null });
      return { ...prev, [roleKey]: models };
    });
  }, []);

  const handleEditRemoveCandidate = useCallback((roleKey: string, index: number) => {
    setEditRoleModelsList((prev) => {
      const models = [...(prev[roleKey] ?? [])];
      if (index > 0 && index < models.length) {
        models.splice(index, 1);
      }
      return { ...prev, [roleKey]: models };
    });
  }, []);

  return (
    <Modal isOpen={isOpen} onClose={wrappedOnClose} title="项目设置" icon={<Settings className="w-4 h-4" />} maxWidthClassName="max-w-xl">
      {/* Tab bar — sticky at top */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 flex border-b border-slate-200 dark:border-slate-700 -mx-1">
        <button onClick={() => setProjectSettingsTab('roles')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${projectSettingsTab === 'roles' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>角色模型</button>
        <button onClick={() => setProjectSettingsTab('packages')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${projectSettingsTab === 'packages' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>扩展管理</button>
        <button onClick={() => setProjectSettingsTab('git')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${projectSettingsTab === 'git' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>Git 设置</button>
        <button onClick={() => setProjectSettingsTab('role-config')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${projectSettingsTab === 'role-config' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>角色配置</button>
      </div>

      {/* 角色模型 tab */}
      {projectSettingsTab === 'roles' && (
        <div className="space-y-4">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">角色默认模型</div>
          {(getAllRoleKeys(roleTemplatesQuery.data) as Array<{ key: string; label: string }>).filter((r) => r.key !== 'planner').map((role) => {
            const models = editRoleModelsList[role.key] ?? [];
            const displayModels = models.length === 0 ? [null] : models;
            return (
              <div key={role.key}>
                {displayModels.map((model, idx) => {
                  const modelKey = model ? `${model.provider}/${model.id}` : '';
                  const levels = getModelThinkingLevels(modelKey);
                  return (
                    <div key={idx} className="flex items-center gap-3 mb-2">
                      <span className="text-xs text-slate-600 dark:text-slate-400 w-20 shrink-0">{idx === 0 ? role.label : ''}</span>
                      <div className="flex-1">
                        <Select
                          value={modelKey}
                          onChange={(v) => handleEditRoleModelChange(role.key, idx, v)}
                          options={[
                            { value: '', label: '继承（使用父级模型）' },
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
                            onChange={(v) => handleEditRoleThinkingLevelChange(role.key, idx, v)}
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
                          onClick={() => handleEditAddCandidate(role.key)}
                          className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded cursor-pointer shrink-0"
                          title="添加候选模型"
                        >+</button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleEditRemoveCandidate(role.key, idx)}
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
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button onClick={wrappedOnClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer">取消</button>
            <button onClick={handleSaveProjectRoleModels} disabled={setProjectRoleModelsMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50">
              {setProjectRoleModelsMut.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* 扩展管理 tab */}
      {projectSettingsTab === 'packages' && (
        <div className="space-y-4">
          <div className="text-[11px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg px-3 py-2">
            项目级扩展仅对当前项目生效。
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">安装新扩展</label>
            <div className="flex gap-2">
              <input
                value={projectPackageSource}
                onChange={(e) => setProjectPackageSource(e.target.value)}
                placeholder="npm:@foo/pi-tools / git:github.com/user/repo"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
              />
              <button
                onClick={async () => {
                  if (!projectPackageSource.trim() || !projectId) return;
                  setProjectPackageError(null);
                  setProjectPackageSuccess(null);
                  try {
                    await installPkgMut.mutateAsync({ source: projectPackageSource.trim(), local: true, projectId });
                    setProjectPackageSource('');
                    setProjectPackageSuccess('安装成功');
                  } catch (err) {
                    setProjectPackageError(err instanceof Error ? err.message : '安装失败');
                  }
                }}
                disabled={installPkgMut.isPending || !projectPackageSource.trim() || !projectId}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50 shrink-0"
              >
                {installPkgMut.isPending ? '安装中…' : '安装'}
              </button>
            </div>
          </div>

          {projectPackageError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{projectPackageError}</div>
          )}
          {projectPackageSuccess && (
            <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{projectPackageSuccess}</div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">已安装扩展</div>
              <button
                onClick={() => projectPackagesUpdatesRefetch()}
                disabled={false}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3`} />
                检查更新
              </button>
            </div>
            <div className="space-y-2">
              {(projectPackagesQueryData ?? []).length === 0 ? (
                <div className="text-xs text-slate-400 dark:text-slate-500 text-center py-4">暂无已安装的扩展</div>
              ) : (
                (projectPackagesQueryData ?? []).map((pkg: any) => (
                  <div key={pkg.source} className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-3 py-2">
                    <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!pkg.filtered}
                        onChange={async () => {
                          setProjectPackageError(null);
                          setProjectPackageSuccess(null);
                          try {
                            await togglePkgMut.mutateAsync({ source: pkg.source, filtered: !pkg.filtered, local: true, projectId: projectId! });
                          } catch (err) {
                            setProjectPackageError(err instanceof Error ? err.message : '切换失败');
                          }
                        }}
                        disabled={togglePkgMut.isPending}
                        className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{pkg.source}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500">
                          项目级
                          {pkg.installedPath ? ` · ${pkg.installedPath}` : ''}
                        </div>
                      </div>
                    </label>
                    <button
                      onClick={async () => {
                        setProjectPackageError(null);
                        setProjectPackageSuccess(null);
                        try {
                          await removePkgMut.mutateAsync({ source: pkg.source, local: true, projectId: projectId! });
                          setProjectPackageSuccess(`已移除：${pkg.source}`);
                        } catch (err) {
                          setProjectPackageError(err instanceof Error ? err.message : '移除失败');
                        }
                      }}
                      disabled={removePkgMut.isPending}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition cursor-pointer disabled:opacity-50 shrink-0"
                      title="移除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {projectPackagesUpdatesQueryData && projectPackagesUpdatesQueryData.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">可用更新</div>
              <div className="space-y-2">
                {projectPackagesUpdatesQueryData.map((update: any) => (
                  <div key={update.source} className="flex items-center justify-between rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-amber-800 dark:text-amber-200 truncate">{update.displayName}</div>
                      <div className="text-[10px] text-amber-600 dark:text-amber-400">{update.source} · {update.type === 'npm' ? 'npm 包' : 'git 仓库'}</div>
                    </div>
                    <button
                      onClick={async () => {
                        setProjectPackageError(null);
                        setProjectPackageSuccess(null);
                        try {
                          await updatePkgMut.mutateAsync({ source: update.source, projectId: projectId! });
                          setProjectPackageSuccess(`已更新：${update.displayName}`);
                          projectPackagesUpdatesRefetch();
                          projectPackagesRefetch();
                        } catch (err) {
                          setProjectPackageError(err instanceof Error ? err.message : '更新失败');
                        }
                      }}
                      disabled={updatePkgMut.isPending}
                      className="px-3 py-1 text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 rounded-lg transition cursor-pointer disabled:opacity-50"
                    >
                      更新
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end pt-2">
                <button
                  onClick={async () => {
                    setProjectPackageError(null);
                    setProjectPackageSuccess(null);
                    try {
                      await updatePkgMut.mutateAsync({ projectId: projectId! });
                      setProjectPackageSuccess('所有扩展已更新');
                      projectPackagesUpdatesRefetch();
                      projectPackagesRefetch();
                    } catch (err) {
                      setProjectPackageError(err instanceof Error ? err.message : '更新失败');
                    }
                  }}
                  disabled={updatePkgMut.isPending}
                  className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
                >
                  {updatePkgMut.isPending ? '更新中…' : '更新全部'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Git 设置 tab */}
      {projectSettingsTab === 'git' && (
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 用户名</label>
            <input type="text" placeholder="git user name" value={gitUserName} onChange={(e) => setGitUserName(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git 邮箱</label>
            <input type="email" placeholder="git user email" value={gitUserEmail} onChange={(e) => setGitUserEmail(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Git Token</label>
            <input type="password" placeholder="personal access token" value={gitToken} onChange={(e) => setGitToken(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400" />
          </div>

          {gitSaveError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{gitSaveError}</div>
          )}
          {gitSaveSuccess && (
            <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{gitSaveSuccess}</div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              onClick={async () => {
                if (!projectId) return;
                setGitSaveError(null);
                setGitSaveSuccess(null);
                try {
                  await deleteProjectGitConfigMut.mutateAsync(projectId);
                  setGitUserName('');
                  setGitUserEmail('');
                  setGitToken('');
                  setGitSaveSuccess('Git 配置已清除');
                } catch (err) {
                  setGitSaveError(err instanceof Error ? err.message : '清除失败');
                }
              }}
              disabled={deleteProjectGitConfigMut.isPending}
              className="px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition cursor-pointer disabled:opacity-50"
            >
              {deleteProjectGitConfigMut.isPending ? '清除中…' : '清除配置'}
            </button>
            <button
              onClick={async () => {
                if (!projectId) return;
                setGitSaveError(null);
                setGitSaveSuccess(null);
                try {
                  await updateProjectGitConfigMut.mutateAsync({
                    projectId,
                    config: {
                      userName: gitUserName || undefined,
                      userEmail: gitUserEmail || undefined,
                      token: gitToken || undefined,
                    },
                  });
                  setGitToken('');
                  setGitSaveSuccess('Git 配置已保存');
                } catch (err) {
                  setGitSaveError(err instanceof Error ? err.message : '保存失败');
                }
              }}
              disabled={updateProjectGitConfigMut.isPending}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
            >
              {updateProjectGitConfigMut.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* 角色配置 tab */}
      {projectSettingsTab === 'role-config' && (
        <div className="space-y-4">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">角色启用与版本</div>
          {getAllRoleKeys(roleTemplatesQuery.data).map((role) => {
            const config = editRoleConfig[role.key] ?? {};
            const roleVersions = (roleTemplatesQuery.data ?? [])
              .filter((t) => t.key === role.key)
              .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
            return (
              <div key={role.key} className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-3 py-2">
                <div className="flex items-center gap-3 flex-1">
                  <span className="mr-1">{renderRoleIcon(roleVersions[0]?.icon, 'w-4 h-4')}</span>
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 w-24 shrink-0">{role.label}</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 w-16 shrink-0">{role.key}</span>
                  <div className="flex-1 min-w-0">
                    {(roleVersions.length > 0) ? (
                      <select
                        value={config.version ?? roleVersions[0]?.version ?? ''}
                        onChange={(e) => setEditRoleConfig((prev) => ({
                          ...prev,
                          [role.key]: { ...prev[role.key], version: e.target.value || undefined },
                        }))}
                        className="w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                      >
                        <option value="">最新版本</option>
                        {roleVersions.map((v) => (
                          <option key={v.id} value={v.version}>
                            {v.version === '内置' ? '内置' : `v${v.version}`}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[10px] text-slate-400">无可用版本</span>
                    )}
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-3 shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={config.enabled !== false}
                    onChange={(e) => setEditRoleConfig((prev) => ({
                      ...prev,
                      [role.key]: { ...prev[role.key], enabled: e.target.checked },
                    }))}
                  />
                  <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            );
          })}
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button onClick={wrappedOnClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer">取消</button>
            <button
              onClick={async () => {
                if (!projectId) return;
                try {
                  await setProjectRoleConfigMut.mutateAsync({ projectId, config: editRoleConfig });
                  wrappedOnClose();
                } catch (err) {
                  alert(err instanceof Error ? err.message : '保存失败');
                }
              }}
              disabled={setProjectRoleConfigMut.isPending}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
            >
              {setProjectRoleConfigMut.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
