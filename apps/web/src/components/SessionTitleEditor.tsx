import React from 'react';
import { Pencil } from 'lucide-react';

export interface SessionTitleEditorProps {
  title: string;
  isPlannerRoot: boolean;
  isMobile: boolean;
  editing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onStartEdit: () => void;
  onCancel: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const INPUT_CLASS = 'text-sm font-bold font-sans leading-none px-1 py-0.5 border border-blue-500 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 outline-none';

/** 会话标题：移动端与桌面端仅宽度 / hover 显示策略不同（消除 App 里的双份 JSX）。 */
export default function SessionTitleEditor({
  title,
  isPlannerRoot,
  isMobile,
  editing,
  editValue,
  onEditValueChange,
  onStartEdit,
  onCancel,
  onKeyDown,
  inputRef,
}: SessionTitleEditorProps) {
  const input = (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      onChange={(e) => onEditValueChange(e.target.value)}
      onBlur={onCancel}
      onKeyDown={onKeyDown}
      className={`${INPUT_CLASS} ${isMobile ? 'w-48' : 'w-64'}`}
      autoFocus
    />
  );

  if (isMobile) {
    return (
      <div className={`flex items-center gap-2 py-1 min-w-0 ${!isPlannerRoot ? 'group/title' : ''}`}>
        {editing ? input : (
          <>
            <h1 className="text-slate-800 dark:text-slate-100 font-bold text-sm font-sans leading-none truncate">{title}</h1>
            {!isPlannerRoot && (
              <button
                onClick={onStartEdit}
                className="opacity-100 transition-opacity p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer shrink-0"
                title="编辑标题"
              >
                <Pencil className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center space-x-3 py-1 ${!isPlannerRoot ? 'group/title' : ''}`}>
      {editing ? input : (
        <>
          <h1 className="text-slate-800 dark:text-slate-100 font-bold text-sm mr-2 font-sans leading-none">{title}</h1>
          {!isPlannerRoot && (
            <button
              onClick={onStartEdit}
              className="opacity-0 group-hover/title:opacity-100 transition-opacity p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
              title="编辑标题"
            >
              <Pencil className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
