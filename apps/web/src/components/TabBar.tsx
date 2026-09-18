import { startTransition } from 'react';

export type Tab = 'chat' | 'info' | 'diff' | 'files' | 'doce' | 'terminal';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'info', label: 'Session Info' },
  { key: 'diff', label: 'Git' },
  { key: 'files', label: 'Files' },
  { key: 'doce', label: 'Doce' },
  { key: 'terminal', label: 'Terminal' },
];

const ACTIVE_CLASS = 'border-blue-600 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800';
const INACTIVE_CLASS = 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200';

interface TabBarProps {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  isMobile: boolean;
}

/** 会话标签栏：移动端横向滚动、桌面端常规排布（消除 App 里的双份按钮 JSX）。 */
export default function TabBar({ activeTab, onSelect, isMobile }: TabBarProps) {
  const buttons = TABS.map(({ key, label }) => (
    <button
      key={key}
      onClick={() => startTransition(() => onSelect(key))}
      className={`${isMobile ? 'px-3 py-2 text-xs whitespace-nowrap' : 'px-4 py-2 text-sm'} font-semibold transition border-b-2 rounded-t-lg cursor-pointer ${activeTab === key ? ACTIVE_CLASS : INACTIVE_CLASS}`}
    >
      {label}
    </button>
  ));

  if (!isMobile) return <div className="flex space-x-1">{buttons}</div>;
  return (
    <div className="mt-2 -mx-1 px-1 overflow-x-auto overflow-y-hidden">
      <div className="flex min-w-max space-x-1">{buttons}</div>
    </div>
  );
}
