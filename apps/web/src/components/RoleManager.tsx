import React, { useState } from 'react';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type { RoleTemplateDTO } from '../lib/api';
import { ROLE_ICON_NAMES, renderRoleIcon, defaultRoleIcon } from '../lib/role-icons';

interface RoleManagerProps {
  roleTemplatesQuery: UseQueryResult<RoleTemplateDTO[]>;
  updateRoleTemplateMut: UseMutationResult<RoleTemplateDTO, Error, { id: string; basePrompt?: string; name?: string; description?: string; icon?: string }, unknown>;
  createRoleTemplateMut: UseMutationResult<RoleTemplateDTO, Error, { key: string; version: string; basePrompt?: string; name?: string; description?: string; icon?: string }, unknown>;
  deleteRoleTemplateMut: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
}

function formatRelativeTime(dateStr: string): string {
  if (!dateStr || isNaN(new Date(dateStr).getTime())) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return '刚刚';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 0) return '今天';
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay}天前`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}周前`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}个月前`;
  const diffYear = Math.floor(diffDay / 365);
  return `${diffYear}年前`;
}

function groupByKey(templates: RoleTemplateDTO[]): Map<string, RoleTemplateDTO[]> {
  const map = new Map<string, RoleTemplateDTO[]>();
  for (const t of templates) {
    if (!map.has(t.key)) map.set(t.key, []);
    map.get(t.key)!.push(t);
  }
  // Sort each group by version descending
  for (const [, list] of map) {
    list.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  }
  return map;
}

export default function RoleManager({
  roleTemplatesQuery,
  updateRoleTemplateMut,
  createRoleTemplateMut,
  deleteRoleTemplateMut,
}: RoleManagerProps) {
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState('');
  const [editingDescription, setEditingDescription] = useState('');
  const [editingName, setEditingName] = useState('');
  const [editingIcon, setEditingIcon] = useState('');
  const [showNewRoleForm, setShowNewRoleForm] = useState(false);
  const [newRoleKey, setNewRoleKey] = useState('');
  const [newRoleVersion, setNewRoleVersion] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleBasePrompt, setNewRoleBasePrompt] = useState('');
  const [newRoleIcon, setNewRoleIcon] = useState(defaultRoleIcon());
  const [showIconPicker, setShowIconPicker] = useState<string | null>(null);
  const [showNewVersionForm, setShowNewVersionForm] = useState<string | null>(null);
  const [expandedBasePromptId, setExpandedBasePromptId] = useState<string | null>(null);
  const [newVersionValue, setNewVersionValue] = useState('');
  const [newVersionName, setNewVersionName] = useState('');
  const [newVersionDesc, setNewVersionDesc] = useState('');

  // Local form errors
  const [newRoleError, setNewRoleError] = useState<string | null>(null);
  const [newVersionError, setNewVersionError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const resetNewRoleForm = () => {
    setNewRoleKey('');
    setNewRoleVersion('');
    setNewRoleName('');
    setNewRoleDescription('');
    setNewRoleBasePrompt('');
    setNewRoleIcon(defaultRoleIcon());
    setNewRoleError(null);
  };

  const resetNewVersionForm = () => {
    setShowNewVersionForm(null);
    setNewVersionValue('');
    setNewVersionName('');
    setNewVersionDesc('');
    setNewVersionError(null);
  };

  return (
    <div className="space-y-4">
      {/* 新建角色按钮 */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">角色模板</span>
        <button
          onClick={() => {
            setShowNewRoleForm(true);
            setNewRoleError(null);
          }}
          className="px-3 py-1.5 text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer"
        >
          + 新建角色
        </button>
      </div>

      {/* 新建角色表单 */}
      {showNewRoleForm && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2">
          <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1">新建角色</div>
          {newRoleError && (
            <div className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-2 py-1.5">
              {newRoleError}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">
                Key（角色标识）<span className="text-red-500">*</span>
              </label>
              <input
                value={newRoleKey}
                onChange={(e) => setNewRoleKey(e.target.value)}
                placeholder="my_custom_role"
                className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">
                版本 <span className="text-red-500">*</span>
              </label>
              <input
                value={newRoleVersion}
                onChange={(e) => setNewRoleVersion(e.target.value)}
                placeholder="1.0"
                className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">名称</label>
            <input
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="角色名称"
              className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
            />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">描述</label>
            <input
              value={newRoleDescription}
              onChange={(e) => setNewRoleDescription(e.target.value)}
              placeholder="角色简短描述，会显示在工具注册中"
              className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">系统提示词 (Base Prompt)</label>
              <textarea
                value={newRoleBasePrompt}
                onChange={(e) => setNewRoleBasePrompt(e.target.value)}
                placeholder="Enter the role's system prompt..."
                className="w-full min-h-[160px] px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition resize-y"
              />
            </div>
            <div className="flex flex-col items-center gap-1">
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
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowNewRoleForm(false); resetNewRoleForm(); }}
              className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
            >
              取消
            </button>
            <button
              onClick={async () => {
                setNewRoleError(null);
                if (!newRoleKey || !newRoleVersion) {
                  setNewRoleError('Key 和版本为必填');
                  return;
                }
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
                  resetNewRoleForm();
                } catch (err) {
                  setNewRoleError(err instanceof Error ? err.message : '创建失败');
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
          {Array.from(groupByKey(roleTemplatesQuery.data ?? [])).map(([key, templates]) => {
            const latestTemplate = templates[0]; // already sorted desc by version
            const isExpanded = expandedRole === key;
            return (
              <div key={key} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3">
                {/* RoleCard header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="shrink-0">{renderRoleIcon(latestTemplate.icon, 'w-5 h-5 text-slate-600 dark:text-slate-300')}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{latestTemplate.name || key}</span>
                        {latestTemplate.isBuiltin ? (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">内置</span>
                        ) : (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">自定义</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{key}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                      {templates.length} 版本 · {formatRelativeTime(latestTemplate.updated_at)}
                    </span>
                    <button
                      onClick={() => setExpandedRole(isExpanded ? null : key)}
                      className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer whitespace-nowrap"
                    >
                      {isExpanded ? '收起' : '展开'}
                    </button>
                  </div>
                </div>

                {/* Expanded version list */}
                {isExpanded && (
                  <div className="mt-3 space-y-2 border-t border-slate-200 dark:border-slate-700 pt-3">
                    {templates.map((tpl, idx) => {
                      const isLatest = idx === 0;
                      const relativeTime = formatRelativeTime(tpl.updated_at);
                      return (
                        <div
                          key={tpl.id}
                          className={`rounded-lg border ${
                            isLatest
                              ? 'border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/10'
                              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
                          } p-2.5`}
                        >
                          {/* Version header */}
                          <div className={`flex items-center justify-between mb-1.5 ${isLatest ? 'border-l-2 border-blue-500 pl-2 -ml-2.5' : 'pl-2 -ml-2.5'}`}>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                版本 {tpl.version}
                              </span>
                              {isLatest && (
                                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">最新</span>
                              )}
                              {tpl.isBuiltin && (
                                <span className="text-[9px] text-slate-400 dark:text-slate-500">(内置)</span>
                              )}
                              <span className="text-[10px] text-slate-400 dark:text-slate-500">{relativeTime}</span>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              {!tpl.isBuiltin && showNewVersionForm === tpl.id ? null : (
                                <button
                                  onClick={() => {
                                    resetNewVersionForm();
                                    setShowNewVersionForm(tpl.id);
                                    // Increment version as default suggestion
                                    const nextVer = String(Number(tpl.version) + 1);
                                    setNewVersionValue(nextVer);
                                  }}
                                  className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer"
                                  title="以此版本为基础创建新版本"
                                >
                                  新建版本
                                </button>
                              )}
                              {tpl.isBuiltin ? (
                                <button
                                  onClick={() => {
                                    setEditingTemplateId(tpl.id);
                                    setEditingPrompt(tpl.basePrompt);
                                    setEditingDescription(tpl.description || '');
                                    setEditingName(tpl.name || '');
                                    setEditingIcon(tpl.icon || defaultRoleIcon());
                                    setEditError(null);
                                  }}
                                  className="text-[10px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300 cursor-pointer"
                                >
                                  查看
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    setEditingTemplateId(tpl.id);
                                    setEditingPrompt(tpl.basePrompt);
                                    setEditingDescription(tpl.description || '');
                                    setEditingName(tpl.name || '');
                                    setEditingIcon(tpl.icon || defaultRoleIcon());
                                    setEditError(null);
                                  }}
                                  className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 cursor-pointer"
                                >
                                  编辑
                                </button>
                              )}
                              {!tpl.isBuiltin && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`确定删除角色模板「${tpl.key} v${tpl.version}」?`)) return;
                                    try {
                                      await deleteRoleTemplateMut.mutateAsync(tpl.id);
                                    } catch (err) {
                                      setEditError(err instanceof Error ? err.message : '删除失败');
                                    }
                                  }}
                                  className="text-[10px] text-red-500 hover:text-red-600 cursor-pointer"
                                >
                                  删除
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Edit mode */}
                          {editingTemplateId === tpl.id ? (
                            <div className="space-y-2">
                              {editError && (
                                <div className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-2 py-1.5">
                                  {editError}
                                </div>
                              )}
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">名称</label>
                                <input
                                  type="text"
                                  value={editingName}
                                  onChange={(e) => setEditingName(e.target.value)}
                                  placeholder="角色显示名称"
                                  className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">描述</label>
                                <input
                                  type="text"
                                  value={editingDescription}
                                  onChange={(e) => setEditingDescription(e.target.value)}
                                  placeholder="角色简短描述，会显示在工具注册中"
                                  className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                />
                              </div>
                              <div>
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
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 block">系统提示词 (Base Prompt)</label>
                                <textarea
                                  value={editingPrompt}
                                  onChange={(e) => setEditingPrompt(e.target.value)}
                                  readOnly={tpl.isBuiltin}
                                  placeholder={tpl.isBuiltin ? '查看模式（内置版本不可编辑）' : ''}
                                  className={`w-full min-h-[160px] px-3 py-2 text-xs font-mono border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition resize-y ${tpl.isBuiltin ? 'opacity-70 cursor-not-allowed' : ''}`}
                                />
                              </div>
                              <div className="flex justify-end gap-2 mt-1">
                                <button
                                  onClick={() => { setEditingTemplateId(null); setEditingPrompt(''); setEditingDescription(''); setEditingName(''); setEditingIcon(''); setEditError(null); }}
                                  className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
                                >
                                  取消
                                </button>
                                {!tpl.isBuiltin && (
                                  <button
                                    onClick={async () => {
                                      setEditError(null);
                                      try {
                                        await updateRoleTemplateMut.mutateAsync({
                                          id: tpl.id,
                                          basePrompt: editingPrompt,
                                          name: editingName || undefined,
                                          description: editingDescription,
                                          icon: editingIcon || undefined,
                                        });
                                        setEditingTemplateId(null);
                                        setEditingPrompt('');
                                        setEditingDescription('');
                                        setEditingName('');
                                        setEditingIcon('');
                                      } catch (err) {
                                        setEditError(err instanceof Error ? err.message : '保存失败');
                                      }
                                    }}
                                    disabled={updateRoleTemplateMut.isPending}
                                    className="px-2 py-1 text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded cursor-pointer disabled:opacity-50"
                                  >
                                    {updateRoleTemplateMut.isPending ? '保存中…' : '保存'}
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : (
                            /* View mode */
                            <div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">{tpl.description || '（无描述）'}</div>
                              <div className={`${expandedBasePromptId === tpl.id ? '' : 'max-h-24'} overflow-y-auto text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap font-mono bg-white dark:bg-slate-900 rounded-lg p-2 border border-slate-200 dark:border-slate-700`}>
                                {expandedBasePromptId === tpl.id ? tpl.basePrompt : tpl.basePrompt.slice(0, 500)}{tpl.basePrompt.length > 500 && expandedBasePromptId !== tpl.id ? '...' : ''}
                              </div>
                              {tpl.basePrompt.length > 500 && (
                                <button
                                  onClick={() => setExpandedBasePromptId(expandedBasePromptId === tpl.id ? null : tpl.id)}
                                  className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 mt-1 cursor-pointer"
                                >
                                  {expandedBasePromptId === tpl.id ? '收起' : '展开全部'}
                                </button>
                              )}
                            </div>
                          )}

                          {/* Inline new version form */}
                          {showNewVersionForm === tpl.id && (
                            <div className="mt-2 border-t border-slate-200 dark:border-slate-700 pt-2">
                              <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1">基于此版本创建新版本</div>
                              {newVersionError && (
                                <div className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-2 py-1.5 mb-1.5">
                                  {newVersionError}
                                </div>
                              )}
                              <div className="grid grid-cols-3 gap-2 mb-1.5">
                                <div>
                                  <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">
                                    新版本号 <span className="text-red-500">*</span>
                                  </label>
                                  <input
                                    value={newVersionValue}
                                    onChange={(e) => setNewVersionValue(e.target.value)}
                                    placeholder="1.1"
                                    className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">名称（可选）</label>
                                  <input
                                    value={newVersionName}
                                    onChange={(e) => setNewVersionName(e.target.value)}
                                    placeholder={tpl.name}
                                    className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] text-slate-500 dark:text-slate-400 block mb-0.5">描述（可选）</label>
                                  <input
                                    value={newVersionDesc}
                                    onChange={(e) => setNewVersionDesc(e.target.value)}
                                    placeholder={tpl.description || '角色简短描述'}
                                    className="w-full px-2 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition"
                                  />
                                </div>
                              </div>
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={resetNewVersionForm}
                                  className="px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
                                >
                                  取消
                                </button>
                                <button
                                  onClick={async () => {
                                    setNewVersionError(null);
                                    if (!newVersionValue) {
                                      setNewVersionError('版本号不能为空');
                                      return;
                                    }
                                    try {
                                      await createRoleTemplateMut.mutateAsync({
                                        key: tpl.key,
                                        version: newVersionValue,
                                        basePrompt: tpl.basePrompt,
                                        name: newVersionName || tpl.name,
                                        description: newVersionDesc || tpl.description,
                                      });
                                      resetNewVersionForm();
                                    } catch (err) {
                                      setNewVersionError(err instanceof Error ? err.message : '创建失败');
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
