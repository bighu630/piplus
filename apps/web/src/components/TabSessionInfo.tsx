import React, { useState } from 'react';
import type { SessionInfoDTO, ProjectTodoDTO } from '@piplus/shared';
import {
  Activity,
  Cpu,
  Clock,
  CheckCircle,
  Tag,
  Trash2,
} from 'lucide-react';

interface TabSessionInfoProps {
  sessionInfo: SessionInfoDTO | null;
  isLoading: boolean;
  projectId: string | null;
  todos: ProjectTodoDTO[];
  todosLoading: boolean;
  onCreateTodo: (text: string, onSuccess: () => void) => void;
  onToggleTodo: (todoId: string, done: boolean) => void;
  onDeleteTodo: (todoId: string) => void;
  createTodoPending: boolean;
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

export default function TabSessionInfo({ sessionInfo, isLoading, projectId, todos, todosLoading, onCreateTodo, onToggleTodo, onDeleteTodo, createTodoPending }: TabSessionInfoProps) {
  const [todoInput, setTodoInput] = useState('');
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
    <div className="h-full overflow-y-auto bg-slate-50 dark:bg-slate-900/10 p-6 space-y-6">
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
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

          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">创建时间</span>
              <Clock className="w-3.5 h-3.5" />
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {new Date(s.created_at).toLocaleString()}
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800 border border-slate-150 dark:border-slate-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-bold uppercase tracking-wider">最后运行</span>
              <Clock className="w-3.5 h-3.5" />
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : '尚未运行'}
            </div>
          </div>
        </div>
      </div>

      {/* Project Todo */}
      {projectId && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xs space-y-4">
          <div className="flex items-center space-x-2 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 px-3 py-1 rounded-full text-xs font-semibold select-none w-fit">
            <CheckCircle className="w-3.5 h-3.5" />
            <span>项目 Todo</span>
          </div>

          {/* Add form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = todoInput.trim();
              if (text) {
                onCreateTodo(text, () => setTodoInput(''));
              }
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={todoInput}
              onChange={(e) => setTodoInput(e.target.value)}
              placeholder="添加新任务…"
              maxLength={500}
              disabled={createTodoPending}
              className="flex-1 px-3 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400/50 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={createTodoPending}
              className="px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {createTodoPending ? '添加中…' : '添加'}
            </button>
          </form>

          {/* Todo list */}
          {todosLoading ? (
            <div className="text-center py-4 text-xs text-slate-400">加载中…</div>
          ) : todos.length === 0 ? (
            <div className="text-center py-4 text-xs text-slate-400">暂无任务</div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {todos.map((todo) => (
                <div
                  key={todo.id}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg ${
                    todo.done
                      ? 'bg-slate-50 dark:bg-slate-800/50'
                      : 'bg-white dark:bg-slate-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={() => onToggleTodo(todo.id, !todo.done)}
                    className="w-4 h-4 rounded border-slate-300 text-amber-500 focus:ring-amber-400/50 shrink-0"
                  />
                  <span
                    className={`flex-1 text-sm ${
                      todo.done
                        ? 'line-through text-slate-400 dark:text-slate-500'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {todo.text}
                  </span>
                  <button
                    onClick={() => onDeleteTodo(todo.id)}
                    className="text-slate-400 hover:text-red-500 transition-colors shrink-0"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
  );
}
