import { PanelLeft } from 'lucide-react';
import TabBar, { type Tab } from './TabBar';
import SessionTitleEditor, { type SessionTitleEditorProps } from './SessionTitleEditor';

interface AppHeaderProps extends SessionTitleEditorProps {
  /** 是否已有会话信息（决定标题区是否渲染） */
  hasSession: boolean;
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  onOpenSidebar: () => void;
}

/** 顶栏：移动端带「打开目录树」按钮 + 标题 + 可横向滚动的标签栏。 */
export default function AppHeader({
  hasSession,
  activeTab,
  onSelectTab,
  onOpenSidebar,
  isMobile,
  ...titleEditor
}: AppHeaderProps) {
  return (
    <header className={`border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 shrink-0 select-none ${isMobile ? 'px-4 py-2' : 'px-6 py-2 flex flex-wrap items-center justify-between'}`}>
      {isMobile ? (
        <>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                onClick={onOpenSidebar}
                className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer shrink-0"
                title="打开目录树"
                aria-label="打开目录树"
              >
                <PanelLeft className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              </button>
              {hasSession && <SessionTitleEditor isMobile {...titleEditor} />}
            </div>
          </div>
          <TabBar activeTab={activeTab} onSelect={onSelectTab} isMobile />
        </>
      ) : (
        <>
          {hasSession && <SessionTitleEditor isMobile={false} {...titleEditor} />}
          <TabBar activeTab={activeTab} onSelect={onSelectTab} isMobile={false} />
        </>
      )}
    </header>
  );
}
