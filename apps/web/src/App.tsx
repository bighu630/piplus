import { lazy, Suspense } from 'react';
import Sidebar from './components/Sidebar';
import AppHeader from './components/AppHeader';
import AppModals from './components/AppModals';
import AskQuestionNotifier from './components/AskQuestionNotifier';
import ConnectionLostBanner from './components/ConnectionLostBanner';
import ModelsNotConfiguredBanner from './components/ModelsNotConfiguredBanner';
import EmptySessionPlaceholder from './components/EmptySessionPlaceholder';
import TabChat from './components/TabChat';
import TabSessionInfo from './components/TabSessionInfo';
import TabGitDiff from './components/TabGitDiff';
import TabFiles from './components/TabFiles';
import { LoginScreen } from './components/LoginScreen';
import { useAppShell } from './lib/use-app-shell';

const TabTerminal = lazy(() => import('./components/TabTerminal'));

/**
 * 应用外壳：只组合 useAppShell() 与布局 JSX。
 * 所有 hook（含各专项 hook）都在登录 early return 之前调用，见 App.test.ts。
 */
export default function App() {
  const app = useAppShell();
  const { isLoggedIn, authStatusQuery, loginMutation, modelsStatusQuery } = app;

  if (authStatusQuery.isPending) return null;

  if (!isLoggedIn) {
    return (
      <LoginScreen
        busy={loginMutation.isPending}
        error={loginMutation.isError ? (loginMutation.error as Error)?.message || '登录失败' : null}
        modelStatus={modelsStatusQuery.data ? { ok: modelsStatusQuery.data.ok, count: modelsStatusQuery.data.count } : null}
        onSubmit={app.handleLogin}
      />
    );
  }

  const {
    isMobile,
    selectedSessionId,
    selectedProjectId,
    activeTab,
    isSidebarVisible,
    isContentVisible,
    resolvedTheme,
    wsConnected,
    modelsNotConfigured,
  } = app;

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] min-h-0 w-full overflow-hidden overscroll-none bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased">
      <div className={`${isSidebarVisible ? 'flex' : 'hidden'} w-full min-w-0 flex-1 md:w-auto md:flex-none`}>
        <Sidebar {...app.sidebar} />
      </div>

      <div className={`${isContentVisible ? 'flex' : 'hidden'} w-full flex-1 min-w-0 flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-900 relative`}>
        {!wsConnected && <ConnectionLostBanner />}
        <AppHeader {...app.header} />
        {modelsNotConfigured && <ModelsNotConfiguredBanner onAddModel={app.openProviderModal} />}

        <div className="flex-1 overflow-hidden relative">
          {selectedSessionId ? (
            <>
              {activeTab === 'chat' && <TabChat {...app.tabChat} />}
              {activeTab === 'info' && (
                <TabSessionInfo selectedSessionId={selectedSessionId} selectedProjectId={selectedProjectId} />
              )}
              {activeTab === 'diff' && <TabGitDiff selectedSessionId={selectedSessionId} activeTab={activeTab} />}
              {activeTab === 'files' && (
                <TabFiles selectedSessionId={selectedSessionId} viewKey="files" projectId={selectedProjectId} />
              )}
              {activeTab === 'doce' && (
                <TabFiles
                  selectedSessionId={selectedSessionId}
                  rootPathFilter={['doce', 'docs', 'doc']}
                  panelTitle="Doce"
                  defaultExpanded={true}
                  viewKey="doce"
                  projectId={selectedProjectId}
                />
              )}
              {/* Terminal tab — keep-alive via display:none */}
              <div style={{ display: activeTab === 'terminal' ? 'block' : 'none' }} className="h-full">
                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-slate-400">Terminal 加载中…</div>}>
                  <TabTerminal
                    key={selectedSessionId}
                    ref={app.terminalRef}
                    sessionId={selectedSessionId}
                    theme={resolvedTheme}
                    visible={activeTab === 'terminal'}
                    onTerminalMessage={app.handleTerminalMessage}
                  />
                </Suspense>
              </div>
            </>
          ) : (
            <EmptySessionPlaceholder />
          )}
        </div>
      </div>

      <AppModals {...app.modals} />

      {/* ask_question 通知：系统通知 + 应用内 toast + 标题前缀；侧边栏琥珀标记由 Sidebar 消费同一 map */}
      <AskQuestionNotifier
        activeSessionId={selectedSessionId}
        onNavigateSession={app.handleNavigateToSession}
      />
    </div>
  );
}
