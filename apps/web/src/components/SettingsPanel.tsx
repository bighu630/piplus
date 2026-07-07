import React, { useState } from 'react';
import { Settings, RefreshCw, Trash2 } from 'lucide-react';
import Modal from './Modal';

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
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<'general' | 'packages'>('general');
  const [packageSource, setPackageSource] = useState('');
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageSuccess, setPackageSuccess] = useState<string | null>(null);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="设置" icon={<Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />} maxWidthClassName="max-w-xl">
      {/* Tab bar — sticky at top */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 flex border-b border-slate-200 dark:border-slate-700 -mx-1">
        <button onClick={() => setSettingsTab('general')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'general' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>常规</button>
        <button onClick={() => setSettingsTab('packages')} className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${settingsTab === 'packages' ? 'border-blue-600 text-blue-700 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}>包管理</button>
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
    </Modal>
  );
}
