import React from 'react';
import type { SessionInfoDTO } from '@piplus/shared';
import {
  Activity,
  Cpu,
  Clock,
  CheckCircle,
  FileCode,
  Tag,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

interface TabSessionInfoProps {
  sessionInfo: SessionInfoDTO | null;
  isLoading: boolean;
}

function runtimeStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'stopping':
      return '停止中';
    case 'idle':
    default:
      return '空闲';
  }
}

function syncStatusLabel(status: string): string {
  switch (status) {
    case 'syncing':
      return '同步中';
    case 'synced':
      return '已同步';
    case 'error':
      return '同步错误';
    case 'idle':
    default:
      return '待同步';
  }
}

export default function TabSessionInfo({ sessionInfo, isLoading }: TabSessionInfoProps) {
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-900/10">
        <div className="text-xs text-slate-400">加载中…</div>
      </div>
    );
  }

  if (!sessionInfo) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-900/10">
        <div className="text-xs text-slate-400">请选择一个会话</div>
      </div>
    );
  }

  const s = sessionInfo.session;
  const lineageText = sessionInfo.lineage.depth > 0
    ? `子会话 · 深度 ${sessionInfo.lineage.depth}`
    : '顶层会话';
  const description = `${lineageText} · 项目 ${sessionInfo.project.name} · 角色 ${sessionInfo.role_template.name}`;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900/10 p-6 space-y-6">
      {/* Summary Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
        <div className="flex items-center space-x-2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-full text-xs font-semibold select-none w-fit">
          <Activity className="w-3.5 h-3.5" />
          <span>会话概览</span>
        </div>

        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 font-sans tracking-tight">
            {s.title}
          </h2>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-2 leading-relaxed">
            {description}
          </p>
        </div>

        {/* Meta Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">角色模板</span>
              <Activity className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {sessionInfo.role_template.name}
              </span>
              <span className="text-[10px] text-slate-400 ml-2">
                v{encodeURIComponent(sessionInfo.role_template.version)}
              </span>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">当前模型</span>
              <Cpu className="w-3.5 h-3.5" />
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
              {s.current_model ? `${s.current_model.provider} / ${s.current_model.label}` : '未设置'}
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">运行状态</span>
              <Clock className="w-3.5 h-3.5" />
            </div>
            <span
              className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                s.runtime_status === 'running'
                  ? 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-150 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-400'
                  : s.runtime_status === 'stopping'
                    ? 'bg-amber-50 dark:bg-amber-950/20 border border-amber-150 dark:border-amber-900/50 text-amber-700 dark:text-amber-400'
                    : 'bg-slate-150 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }`}
            >
              {runtimeStatusLabel(s.runtime_status)}
            </span>
          </div>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Recent Events */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
              <CheckCircle className="w-4 h-4 text-blue-500" />
              <span>最近事件</span>
            </h3>
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
              {sessionInfo.recent_events.length} 条
            </span>
          </div>

          {sessionInfo.recent_events.length === 0 ? (
            <div className="text-center py-4 text-xs text-slate-400">暂无事件</div>
          ) : (
            <div className="space-y-2">
              {sessionInfo.recent_events.slice(0, 10).map((evt) => (
                <div
                  key={evt.id}
                  className="flex items-start space-x-2.5 p-2 rounded-lg bg-slate-50 dark:bg-slate-800 text-xs"
                >
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0 mt-0.5">
                    {new Date(evt.created_at).toLocaleTimeString()}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300">{evt.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sync Status & Role Info */}
        <div className="space-y-6">
          {/* Sync Status */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
                <RefreshCw className="w-4 h-4 text-indigo-500" />
                <span>同步状态</span>
              </h3>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                  sessionInfo.sync.sync_status === 'error'
                    ? 'bg-red-100 dark:bg-red-950/30 text-red-600 dark:text-red-400'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                }`}
              >
                {syncStatusLabel(sessionInfo.sync.sync_status)}
              </span>
            </div>
            <div className="space-y-2 text-xs text-slate-600 dark:text-slate-400">
              {sessionInfo.sync.last_synced_at && (
                <div className="flex justify-between">
                  <span>最近同步</span>
                  <span className="font-mono">{new Date(sessionInfo.sync.last_synced_at).toLocaleString()}</span>
                </div>
              )}
              {sessionInfo.sync.last_error && (
                <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="break-all">{sessionInfo.sync.last_error}</span>
                </div>
              )}
              {!sessionInfo.sync.last_synced_at && !sessionInfo.sync.last_error && (
                <div className="text-slate-400">暂无同步记录</div>
              )}
            </div>
          </div>

          {/* Role & Prompts */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm tracking-tight flex items-center space-x-1.5">
                <Tag className="w-3.5 h-3.5 text-pink-500" />
                <span>角色与提示词</span>
              </h3>
            </div>
            <div className="space-y-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">角色 Key：</span>
                <span className="font-mono text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                  {sessionInfo.role_template.key}
                </span>
              </div>
              <div>
                <span className="text-slate-400">系统提示词：</span>
                <p className="mt-1 text-slate-600 dark:text-slate-400 line-clamp-4 break-all">
                  {sessionInfo.prompts.role_base_prompt_snapshot || '无'}
                </p>
              </div>
              {sessionInfo.prompts.user_supplied_prompt && (
                <div>
                  <span className="text-slate-400">用户补充提示词：</span>
                  <p className="mt-1 text-slate-600 dark:text-slate-400 line-clamp-3 break-all">
                    {sessionInfo.prompts.user_supplied_prompt}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
