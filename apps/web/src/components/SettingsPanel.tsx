import React, { useEffect, useState } from 'react';
import { Settings, RefreshCw, Trash2, Sun, Monitor, Moon } from 'lucide-react';
import Modal from './Modal';
import Select from './Select';
import { useModels, usePackages, usePackageUpdates, useRoleTemplates, useUpdateRoleTemplateMutation, useCreateRoleTemplateMutation, useDeleteRoleTemplateMutation, useSettings, useUpdateSettingsMutation } from '../lib/hooks';

import RoleManager from './RoleManager';

interface PkgMut {
  isPending: boolean;
  mutateAsync: (args: any) => Promise<any>;
}


interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  sendShortcutMode: 'enter' | 'mod_enter';
  onSendShortcutModeChange: (mode: 'enter' | 'mod_enter') => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  systemNotificationsEnabled: boolean;
  onToggleSystemNotifications: (enabled: boolean) => Promise<void>;
  notificationPermissionStatus: string;
  onOpenProviderModal: () => void;
  installPkgMut: PkgMut;
  togglePkgMut: PkgMut;
  removePkgMut: PkgMut;
  updatePkgMut: PkgMut;
  hideRoleLabels: boolean;
  onHideRoleLabelsChange: (v: boolean) => void;
  hiddenCompletedRoles: string[];
  onHiddenCompletedRolesChange: (roles: string[]) => void;
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
  togglePkgMut,
  removePkgMut,
  updatePkgMut,
  hideRoleLabels,
  onHideRoleLabelsChange,
  hiddenCompletedRoles,
  onHiddenCompletedRolesChange,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<'general' | 'packages' | 'roles'>('general');
  const [packageSource, setPackageSource] = useState('');
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageSuccess, setPackageSuccess] = useState<string | null>(null);
  const packagesQuery = usePackages();
  const packagesUpdatesQuery = usePackageUpdates();
  const roleTemplatesQuery = useRoleTemplates();
  const updateRoleTemplateMut = useUpdateRoleTemplateMutation();
  const createRoleTemplateMut = useCreateRoleTemplateMutation();
  const deleteRoleTemplateMut = useDeleteRoleTemplateMutation();
  const settingsQuery = useSettings();
  const updateSettingsMut = useUpdateSettingsMutation();
  const [subagentTimeout, setSubagentTimeout] = useState('');
  const [subagentTimeoutTouched, setSubagentTimeoutTouched] = useState(false);
  const [subagentTimeoutSaved, setSubagentTimeoutSaved] = useState(false);
  const [subagentTimeoutError, setSubagentTimeoutError] = useState<string | null>(null);

  const modelsQuery = useModels();
  const visionModels = (modelsQuery.data ?? []).filter((m) => Array.isArray(m.input) && m.input.includes('image'));
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModel, setVisionModel] = useState('');
  const [visionFallbackModel, setVisionFallbackModel] = useState('');
  const [visionTouched, setVisionTouched] = useState(false);
  const [visionSaved, setVisionSaved] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);

  // Sync input from server value when settings arrive (string → number).
  // 仅当输入框未被用户触碰时同步，避免覆盖用户正在编辑的值。
  useEffect(() => {
    if (subagentTimeoutTouched) return;
    const raw = settingsQuery.data?.subagent_timeout_minutes;
    if (raw !== undefined && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      setSubagentTimeout(String(Number(raw)));
    }
  }, [settingsQuery.data, subagentTimeoutTouched]);

  // Sync vision settings from server when they arrive (only if untouched).
  useEffect(() => {
    if (visionTouched) return;
    setVisionEnabled(settingsQuery.data?.vision_enabled === 'true');
    setVisionModel(settingsQuery.data?.vision_model ?? '');
    setVisionFallbackModel(settingsQuery.data?.vision_fallback_model ?? '');
  }, [settingsQuery.data, visionTouched]);


  return (
    <Modal isOpen={isOpen} onClose={onClose} title="设置" icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />} maxWidthClassName="max-w-[720px]">
      {/* Tab bar — sticky at top */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 flex border-b border-slate-200 dark:border-slate-700 -mx-1">
        <button onClick={() => setSettingsTab('general')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'general' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>常规</button>
        <button onClick={() => setSettingsTab('packages')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'packages' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>包管理</button>
        <button onClick={() => setSettingsTab('roles')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'roles' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>角色管理</button>
      </div>

      {/* 常规 tab — 包含快捷键、主题、通知、模型 */}
      {settingsTab === 'general' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-6 items-start">
            <div className="flex-1 min-w-[240px]">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">发送快捷键</label>
              <div className="flex gap-2">
                <button onClick={() => onSendShortcutModeChange('enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Enter 发送</button>
                <button onClick={() => onSendShortcutModeChange('mod_enter')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer ${sendShortcutMode === 'mod_enter' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>Ctrl/Cmd+Enter 发送</button>
              </div>
            </div>
            <div className="flex-1 min-w-[240px]">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">主题</label>
              <div className="flex gap-2">
                <button onClick={() => onThemeChange('light')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'light' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Sun size={14} />浅色</button>
                <button onClick={() => onThemeChange('dark')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'dark' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Moon size={14} />深色</button>
                <button onClick={() => onThemeChange('system')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'system' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Monitor size={14} />跟随系统</button>
              </div>
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
            <div>
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">子代理超时</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">spawn_session 等待子代理返回的最长时间。0 = 永不超时，一直等到子代理结束。</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                value={subagentTimeout}
                onChange={(e) => {
                  setSubagentTimeout(e.target.value);
                  setSubagentTimeoutTouched(true);
                  setSubagentTimeoutError(null);
                  setSubagentTimeoutSaved(false);
                }}
                placeholder="分钟"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition placeholder:text-slate-400"
              />
              <button
                onClick={async () => {
                  setSubagentTimeoutError(null);
                  setSubagentTimeoutSaved(false);
                  try {
                    await updateSettingsMut.mutateAsync({ subagent_timeout_minutes: Number(subagentTimeout) });
                    setSubagentTimeoutSaved(true);
                    setSubagentTimeoutTouched(false);
                  } catch (err) {
                    setSubagentTimeoutError(err instanceof Error ? err.message : '保存失败');
                  }
                }}
                disabled={updateSettingsMut.isPending || !/^\d+$/.test(subagentTimeout)}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50 shrink-0"
              >
                {updateSettingsMut.isPending ? '保存中…' : '保存'}
              </button>
            </div>
            {subagentTimeoutError && (
              <p className="text-[11px] text-red-600 dark:text-red-400">{subagentTimeoutError}</p>
            )}
            {subagentTimeoutSaved && (
              <p className="text-[11px] text-green-700 dark:text-green-400">已保存</p>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">使用多模态模型识别图片</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800">实验性</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  开启后，非多模态模型会话中发送的图片将由配置的多模态模型识别为文字描述后转发给当前模型（图片本身不发送）。识别失败时消息会被拒绝并显示错误说明。实验性功能，识别质量依赖所选模型。
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input type="checkbox" className="sr-only peer" checked={visionEnabled} onChange={(e) => { setVisionEnabled(e.target.checked); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }} />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {visionEnabled && (
              <div className="space-y-2 pt-1">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">多模态识别模型（主）</label>
                  <div className="relative" style={{ minWidth: 200 }}>
                    <Select
                      value={visionModel}
                      onChange={(v) => { setVisionModel(v); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }}
                      options={visionModels.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.label}` }))}
                      placeholder={visionModels.length ? '选择支持图片的模型' : '暂无可用的多模态模型'}
                      searchable
                      dropdownMaxHeight="max-h-72"
                      dropdownMinWidth="260px"
                      className="w-full"
                    />
                  </div>
                  {!visionModel && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">必须选择主模型，功能才能生效。</p>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">备选模型（可选）</label>
                  <div className="relative" style={{ minWidth: 200 }}>
                    <Select
                      value={visionFallbackModel}
                      onChange={(v) => { setVisionFallbackModel(v); setVisionTouched(true); setVisionError(null); setVisionSaved(false); }}
                      options={visionModels.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.label}` }))}
                      placeholder="不启用回退"
                      searchable
                      dropdownMaxHeight="max-h-72"
                      dropdownMinWidth="260px"
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 保存行在 visionEnabled 块之外：取消勾选后仍可保存关闭状态 */}
            {visionTouched && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={async () => {
                    setVisionError(null);
                    setVisionSaved(false);
                    try {
                      await updateSettingsMut.mutateAsync({
                        vision_enabled: String(visionEnabled),
                        vision_model: visionModel,
                        vision_fallback_model: visionFallbackModel,
                      });
                      setVisionSaved(true);
                      setVisionTouched(false);
                    } catch (err) {
                      setVisionError(err instanceof Error ? err.message : '保存失败');
                    }
                  }}
                  disabled={visionEnabled && !visionModel}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  保存
                </button>
                {visionSaved && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">已保存</span>}
                {visionError && <span className="text-[11px] text-red-600 dark:text-red-400">{visionError}</span>}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">按角色隐藏已完成会话</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">勾选的角色，其已完成（归档）的会话将在侧边栏中隐藏。（取消勾选则显示。）</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {(roleTemplatesQuery.data ?? [])
                .filter((tpl, idx, arr) => arr.findIndex(t => t.key === tpl.key) === idx) // deduplicate by key
                .sort((a, b) => a.key.localeCompare(b.key))
                .map(tpl => (
                  <label key={tpl.key} className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hiddenCompletedRoles.includes(tpl.key)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onHiddenCompletedRolesChange([...hiddenCompletedRoles, tpl.key]);
                        } else {
                          onHiddenCompletedRolesChange(hiddenCompletedRoles.filter(k => k !== tpl.key));
                        }
                      }}
                      className="w-3.5 h-3.5 accent-slate-600 rounded cursor-pointer dark:bg-slate-700 dark:border-slate-600"
                    />
                    <span className="text-xs text-slate-700 dark:text-slate-300">{tpl.name || tpl.key}</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">({tpl.key})</span>
                  </label>
                ))}
            </div>
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
        <RoleManager
          roleTemplatesQuery={roleTemplatesQuery}
          updateRoleTemplateMut={updateRoleTemplateMut}
          createRoleTemplateMut={createRoleTemplateMut}
          deleteRoleTemplateMut={deleteRoleTemplateMut}
        />
      )}
    </Modal>
  );
}

