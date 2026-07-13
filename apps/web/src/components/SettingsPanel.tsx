import React, { useState } from 'react';
import { Settings, RefreshCw, Trash2 } from 'lucide-react';
import Modal from './Modal';
import { useRoleTemplates, useUpdateRoleTemplateMutation, useCreateRoleTemplateMutation, useDeleteRoleTemplateMutation } from '../lib/hooks';

import { ROLE_ICON_NAMES, renderRoleIcon, defaultRoleIcon } from '../lib/role-icons';

interface PkgMut {
  isPending: boolean;
  mutateAsync: (args: any) => Promise<any>;
}

interface PkgData {
  source: string;
  filtered?: boolean;
  scope?: string;
  installedPath?: string;
  displayName?: string;
  type?: string;
}

interface UpdateData {
  source: string;
  displayName?: string;
  type?: string;
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  sendShortcutMode: 'enter' | 'mod_enter';
  onSendShortcutModeChange: (mode: 'enter' | 'mod_enter') => void;
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  systemNotificationsEnabled: boolean;
  onToggleSystemNotifications: (enabled: boolean) => Promise<void>;
  notificationPermissionStatus: string;
  onOpenProviderModal: () => void;
  installPkgMut: PkgMut;
  packagesQuery: { data?: PkgData[]; isLoading?: boolean };
  packagesUpdatesQuery: { data?: UpdateData[]; isFetching: boolean; refetch: () => void };
  togglePkgMut: PkgMut;
  removePkgMut: PkgMut;
  updatePkgMut: PkgMut;
  hideRoleLabels: boolean;
  onHideRoleLabelsChange: (v: boolean) => void;
}

export default function SettingsPanel({
  isOpen,
  onClose,
  sendShortcutMode,
  onSendShortcutModeChange,
  theme,
  onThemeChange,
  systemNotificationsEnabled,
  onToggleSystemNotifications,
  notificationPermissionStatus,
  onOpenProviderModal,
  installPkgMut,
  packagesQuery,
  packagesUpdatesQuery,
  togglePkgMut,
  removePkgMut,
  updatePkgMut,
  hideRoleLabels,
  onHideRoleLabelsChange,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<'general' | 'packages' | 'roles'>('general');
  const [packageSource, setPackageSource] = useState('');
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageSuccess, setPackageSuccess] = useState<string | null>(null);
  const roleTemplatesQuery = useRoleTemplates();
  const updateRoleTemplateMut = useUpdateRoleTemplateMutation();
  const createRoleTemplateMut = useCreateRoleTemplateMutation();
  const deleteRoleTemplateMut = useDeleteRoleTemplateMutation();
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState('');
  const [editingDescription, setEditingDescription] = useState('');
  const [showNewRoleForm, setShowNewRoleForm] = useState(false);
  const [newRoleKey, setNewRoleKey] = useState('');
  const [newRoleVersion, setNewRoleVersion] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleBasePrompt, setNewRoleBasePrompt] = useState('');
  const [editingIcon, setEditingIcon] = useState('');
  const [newRoleIcon, setNewRoleIcon] = useState(defaultRoleIcon());
  const [showIconPicker, setShowIconPicker] = useState<string | null>(null);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="设置" icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />} maxWidthClassName="max-w-xl">
      {/* Tab bar — sticky at top */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 flex border-b border-slate-200 dark:border-slate-700 -mx-1">
        <button onClick={() => setSettingsTab('general')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'general' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>常规</button>
        <button onClick={() => setSettingsTab('packages')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'packages' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>包管理</button>
        <button onClick={() => setSettingsTab('roles')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'roles' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>角色管理</button>
      </div>

      {/* 常规 tab — 包含快捷键、主题、通知、模型 */}
      {settingsTab === 'general' && (
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">发送快捷键</label>
            <div className="flex gap-2">
              <button onClick={() => onSendShortcutModeChange('enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Enter 发送</button>
              <button onClick={() => onSendShortcutModeChange('mod_enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'mod_enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Ctrl/Cmd+Enter 发送</button>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">主题</label>
            <div className="flex gap-2">
              <button onClick={() => onThemeChange('light')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${theme === 'light' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>浅色</button>
              <button onClick={() => onThemeChange('dark')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${theme === 'dark' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>深色</button>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">隐藏 session 树上的角色名</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">开启后，左侧会话树的角色标签将隐藏，鼠标悬停时显示。</div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={hideRoleLabels} onChange={(e) => onHideRoleLabelsChange(e.target.checked)} />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">系统通知</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">开启后，Planner、Feature Lead、Bugfix Lead 完成或出错时发送通知。</div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={systemNotificationsEnabled} onChange={(e) => onToggleSystemNotifications(e.target.checked)} />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
            {notificationPermissionStatus === 'denied' && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">系统通知被浏览器权限拒绝，请在浏览器设置中允许通知后重试。</p>
            )}
            {notificationPermissionStatus === 'default' && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">通知权限未授予，请在弹窗中选择「允许」以启用系统通知。</p>
            )}
            {notificationPermissionStatus === 'unsupported' && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">当前环境不支持系统通知（需要 HTTPS 或 localhost）。</p>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">模型提供商</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">支持 openai-completions、anthropic-messages、google-generative-ai、openai-responses</div>
              </div>
              <button onClick={onOpenProviderModal} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer">管理模型提供商</button>
            </div>
          </div>
        </div>
      )}

      {/* 包管理 tab */}
      {settingsTab === 'packages' && (
        <div className="space-y-4">
          <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
            Pi 包可能包含可执行扩展代码，请只安装可信来源。
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">安装新包</label>
            <div className="flex gap-2">
              <input
                value={packageSource}
                onChange={(e) => setPackageSource(e.target.value)}
                placeholder="npm:@foo/pi-tools / git:github.com/user/repo"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
              />
              <button
                onClick={async () => {
                  if (!packageSource.trim()) return;
                  setPackageError(null);
                  setPackageSuccess(null);
                  try {
                    await installPkgMut.mutateAsync({ source: packageSource.trim() });
                    setPackageSource('');
                    setPackageSuccess('安装成功');
                  } catch (err) {
                    setPackageError(err instanceof Error ? err.message : '安装失败');
                  }
                }}
                disabled={installPkgMut.isPending || !packageSource.trim()}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50 shrink-0"
              >
                {installPkgMut.isPending ? '安装中…' : '安装'}
              </button>
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">当前为全局安装。项目级安装请前往「项目设置 → 扩展管理」。</p>
          </div>

          {packageError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{packageError}</div>
          )}
          {packageSuccess && (
            <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{packageSuccess}</div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">已配置包</div>
              <button
                onClick={() => packagesUpdatesQuery.refetch()}
                disabled={packagesUpdatesQuery.isFetching}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${packagesUpdatesQuery.isFetching ? 'animate-spin' : ''}`} />
                检查更新
              </button>
            </div>
            <div className="space-y-2">
              {(packagesQuery.data ?? []).length === 0 ? (
                <div className="text-xs text-slate-400 dark:text-slate-500 text-center py-4">暂无已配置的包</div>
              ) : (
                (packagesQuery.data ?? []).map((pkg) => (
                  <div key={pkg.source} className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 px-3 py-2">
                    <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!pkg.filtered}
                        onChange={async () => {
                          setPackageError(null);
                          setPackageSuccess(null);
                          try {
                            await togglePkgMut.mutateAsync({ source: pkg.source, filtered: !pkg.filtered });
                          } catch (err) {
                            setPackageError(err instanceof Error ? err.message : '切换失败');
                          }
                        }}
                        disabled={togglePkgMut.isPending}
                        className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{pkg.source}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500">
                          {pkg.scope === 'user' ? '全局' : '项目'}
                          {pkg.installedPath ? ` · ${pkg.installedPath}` : ''}
                        </div>
                      </div>
                    </label>
                    <button
                      onClick={async () => {
                        setPackageError(null);
                        setPackageSuccess(null);
                        try {
                          await removePkgMut.mutateAsync({ source: pkg.source });
                          setPackageSuccess(`已移除：${pkg.source}`);
                        } catch (err) {
                          setPackageError(err instanceof Error ? err.message : '移除失败');
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

          {packagesUpdatesQuery.data && packagesUpdatesQuery.data.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">可用更新</div>
              <div className="space-y-2">
                {packagesUpdatesQuery.data.map((update) => (
                  <div key={update.source} className="flex items-center justify-between rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-amber-800 dark:text-amber-200 truncate">{update.displayName}</div>
                      <div className="text-[10px] text-amber-600 dark:text-amber-400">{update.source} · {update.type === 'npm' ? 'npm 包' : 'git 仓库'}</div>
                    </div>
                    <button
                      onClick={async () => {
                        setPackageError(null);
                        setPackageSuccess(null);
                        try {
                          await updatePkgMut.mutateAsync({ source: update.source });
                          setPackageSuccess(`${update.displayName ?? update.source} 已更新`);
                        } catch (err) {
                          setPackageError(err instanceof Error ? err.message : '更新失败');
                        }
                      }}
                      disabled={updatePkgMut.isPending}
                      className="px-3 py-1.5 text-[11px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      更新
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* 角色管理 tab */}
      {settingsTab === 'roles' && (
        <div className="space-y-4">
          {/* 新建角色按钮 */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">角色模板</span>
            <button
              onClick={() => setShowNewRoleForm(true)}
              className="px-3 py-1.5 text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer"
            >
              + 新建角色
            </button>
          </div>

          {/* 新建角色表单 */}
          {showNewRoleForm && (
            <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2">
              <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1">新建角色</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">Key（角色标识）</label>
                  <input value={newRoleKey} onChange={(e) => setNewRoleKey(e.target.value)} placeholder="my_custom_role" className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition" />
                </div>
                <div>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">版本</label>
                  <input value={newRoleVersion} onChange={(e) => setNewRoleVersion(e.target.value)} placeholder="1.0" className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">名称</label>
                <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="角色名称" className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">描述</label>
                <input value={newRoleDescription} onChange={(e) => setNewRoleDescription(e.target.value)} placeholder="会显示在 spawn_session 工具中" className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">图标</label>
                <div className="relative">
                  <button
                    onClick={() => setShowIconPicker(showIconPicker === 'new' ? null : 'new')}
                    className="w-9 h-9 flex items-center justify-center border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
                  >
                    {renderRoleIcon(newRoleIcon, 'w-5 h-5 text-slate-600 dark:text-slate-300')}
                  </button>
                  {showIconPicker === 'new' && (
                    <div className="absolute z-20 mt-1 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg grid grid-cols-8 gap-1 w-72">
                      {ROLE_ICON_NAMES.map((name) => (
                        <button
                          key={name}
                          onClick={() => { setNewRoleIcon(name); setShowIconPicker(null); }}
                          className={`w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer ${newRoleIcon === name ? 'bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-500' : ''}`}
                        >
                          {renderRoleIcon(name, 'w-4 h-4 text-slate-600 dark:text-slate-300')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">系统提示词 (Base Prompt)</label>
                <textarea value={newRoleBasePrompt} onChange={(e) => setNewRoleBasePrompt(e.target.value)} placeholder="Enter the role's system prompt..." className="w-full h-24 px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowNewRoleForm(false); setNewRoleKey(''); setNewRoleVersion(''); setNewRoleName(''); setNewRoleDescription(''); setNewRoleBasePrompt(''); setNewRoleIcon(defaultRoleIcon()); }} className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer">取消</button>
                <button
                  onClick={async () => {
                    if (!newRoleKey || !newRoleVersion) { alert('Key 和版本为必填'); return; }
                    try {
                      await createRoleTemplateMut.mutateAsync({
                        key: newRoleKey,
                        version: newRoleVersion,
                        basePrompt: newRoleBasePrompt,
                        name: newRoleName || newRoleKey,
                        description: newRoleDescription,
                        icon: newRoleIcon,
                      });
                      setShowNewRoleForm(false);
                      setNewRoleKey('');
                      setNewRoleVersion('');
                      setNewRoleName('');
                      setNewRoleDescription('');
                      setNewRoleBasePrompt('');
                      setNewRoleIcon(defaultRoleIcon());
                    } catch (err) {
                      alert(err instanceof Error ? err.message : '创建失败');
                    }
                  }}
                  disabled={createRoleTemplateMut.isPending}
                  className="px-3 py-1.5 text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
                >
                  {createRoleTemplateMut.isPending ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          )}

          {(roleTemplatesQuery.data ?? []).length === 0 ? (
            <div className="text-xs text-slate-400 dark:text-slate-500 text-center py-4">暂无角色模板</div>
          ) : (
            <div className="space-y-3">
              {/* Group by key */}
              {Array.from(groupByKey(roleTemplatesQuery.data ?? [])).map(([key, templates]) => (
                <div key={key} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="mr-1">{renderRoleIcon(templates[0].icon, 'w-4 h-4')}</span>
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{key}</span>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-2">{templates[0].name}</span>
                    </div>
                    <button
                      onClick={() => setExpandedRole(key === expandedRole ? null : key)}
                      className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer"
                    >
                      {expandedRole === key ? '收起' : `${templates.length} 个版本`}
                    </button>
                  </div>
                  {expandedRole === key && (
                    <div className="space-y-3">
                      {templates.map((tpl) => (
                        <div key={tpl.id} className="border-t border-slate-200 dark:border-slate-700 pt-2">
                          <div className="flex items-center justify-between mb-1">
                            <span>
                              <span className="mr-1">{renderRoleIcon(tpl.icon, 'w-3.5 h-3.5')}</span>
                              <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                版本 {tpl.version}
                                {tpl.isBuiltin && <span className="ml-1 text-[9px] text-amber-500">(内置)</span>}
                              </span>
                            </span>
                            <div className="flex gap-1">
                              <button
                                onClick={async () => {
                                  // Create new version from this template
                                  const newVersion = prompt('请输入新版本号:', String(Number(tpl.version) + 1));
                                  if (!newVersion) return;
                                  try {
                                    await createRoleTemplateMut.mutateAsync({
                                      key: tpl.key,
                                      version: newVersion,
                                      basePrompt: tpl.basePrompt,
                                      name: tpl.name,
                                      description: tpl.description,
                                    });
                                  } catch (err) {
                                    alert(err instanceof Error ? err.message : '创建失败');
                                  }
                                }}
                                className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer"
                                title="以此版本为基础创建新版本"
                              >
                                新建版本
                              </button>
                              {!tpl.isBuiltin && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`确定删除角色模板「${tpl.key} v${tpl.version}」?`)) return;
                                    try {
                                      await deleteRoleTemplateMut.mutateAsync(tpl.id);
                                    } catch (err) {
                                      alert(err instanceof Error ? err.message : '删除失败');
                                    }
                                  }}
                                  className="text-[10px] text-red-500 hover:text-red-600 cursor-pointer"
                                >
                                  删除
                                </button>
                              )}
                            </div>
                          </div>
                          {editingTemplateId === tpl.id ? (
                            <div>
                              <div className="mb-2">
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">描述</label>
                                <input
                                  type="text"
                                  value={editingDescription}
                                  onChange={(e) => setEditingDescription(e.target.value)}
                                  placeholder="角色简短描述，会显示在工具注册中"
                                  className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                />
                              </div>
                              <div className="mb-2">
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">图标</label>
                                <div className="relative">
                                  <button
                                    onClick={() => setShowIconPicker(showIconPicker === tpl.id ? null : tpl.id)}
                                    className="w-9 h-9 flex items-center justify-center border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
                                  >
                                    {renderRoleIcon(editingIcon || defaultRoleIcon(), 'w-5 h-5 text-slate-600 dark:text-slate-300')}
                                  </button>
                                  {showIconPicker === tpl.id && (
                                    <div className="absolute z-20 mt-1 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg grid grid-cols-8 gap-1 w-72">
                                      {ROLE_ICON_NAMES.map((name) => (
                                        <button
                                          key={name}
                                          onClick={() => { setEditingIcon(name); setShowIconPicker(null); }}
                                          className={`w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer ${editingIcon === name ? 'bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-500' : ''}`}
                                        >
                                          {renderRoleIcon(name, 'w-4 h-4 text-slate-600 dark:text-slate-300')}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div className="mb-2">
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">系统提示词 (Base Prompt)</label>
                                <textarea
                                  value={editingPrompt}
                                  onChange={(e) => setEditingPrompt(e.target.value)}
                                  className="w-full h-40 px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                />
                              </div>
                              <div className="flex justify-end gap-2 mt-1">
                                <button onClick={() => { setEditingTemplateId(null); setEditingPrompt(''); setEditingDescription(''); }} className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer">取消</button>
                                <button
                                  onClick={async () => {
                                    try {
                                      await updateRoleTemplateMut.mutateAsync({
                                        id: tpl.id,
                                        basePrompt: editingPrompt,
                                        description: editingDescription,
                                        icon: editingIcon || undefined,
                                      });
                                      setEditingTemplateId(null);
                                      setEditingPrompt('');
                                      setEditingDescription('');
                                      setEditingIcon('');
                                    } catch (err) {
                                      alert(err instanceof Error ? err.message : '保存失败');
                                    }
                                  }}
                                  disabled={updateRoleTemplateMut.isPending}
                                  className="px-2 py-1 text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded cursor-pointer disabled:opacity-50"
                                >
                                  {updateRoleTemplateMut.isPending ? '保存中…' : '保存'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">{tpl.description || '（无描述）'}</div>
                              <div className="max-h-24 overflow-y-auto text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap font-mono bg-white dark:bg-slate-900 rounded-lg p-2 border border-slate-200 dark:border-slate-700">
                                {tpl.basePrompt.slice(0, 500)}{tpl.basePrompt.length > 500 ? '...' : ''}
                              </div>
                              <button
                                onClick={() => { setEditingTemplateId(tpl.id); setEditingPrompt(tpl.basePrompt); setEditingDescription(tpl.description || ''); setEditingIcon(tpl.icon || defaultRoleIcon()); }}
                                className="mt-1 text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer"
                              >
                                编辑
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function groupByKey(templates: Array<{ key: string; version: string; [key: string]: any }>): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const t of templates) {
    if (!map.has(t.key)) map.set(t.key, []);
    map.get(t.key)!.push(t);
  }
  // Sort each group by version descending
  for (const [key, list] of map) {
    list.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  }
  return map;
}
