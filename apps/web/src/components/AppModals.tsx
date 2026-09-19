import { Suspense, lazy } from 'react';
import type { ModelInfo } from '../lib/api';

// 弹窗只在用户触发时才需要，且各自拖着重依赖（SettingsPanel → RoleManager、
// ProviderModal 958 行、两个项目弹窗），全部改为按需加载，从首屏 chunk 中移除。
const CreateProjectModal = lazy(() => import('./CreateProjectModal'));
const ProviderModal = lazy(() => import('./ProviderModal'));
const ProjectSettingsModal = lazy(() => import('./ProjectSettingsModal'));
const SettingsPanel = lazy(() => import('./SettingsPanel'));

export interface AppModalsProps {
  showCreateProject: boolean;
  onCloseCreateProject: () => void;
  onProjectCreated: (projectId: string, sessionId: string) => void;
  modelsData: ModelInfo[];
  modelsLoading: boolean;
  createProjectMut: any;
  setProjectRoleModelsMut: any;

  showSettings: boolean;
  onCloseSettings: () => void;
  sendShortcutMode: 'enter' | 'mod_enter';
  onSendShortcutModeChange: (mode: 'enter' | 'mod_enter') => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  systemNotificationsEnabled: boolean;
  onToggleSystemNotifications: (enabled: boolean) => Promise<void>;
  notificationPermissionStatus: string;
  onOpenProviderModal: () => void;
  installPkgMut: any;
  togglePkgMut: any;
  removePkgMut: any;
  updatePkgMut: any;
  hideRoleLabels: boolean;
  onHideRoleLabelsChange: (value: boolean) => void;
  hiddenCompletedRoles: string[];
  onHiddenCompletedRolesChange: (roles: string[]) => void;

  showProjectSettings: boolean;
  onCloseProjectSettings: () => void;
  projectId: string | null;
  projectPackagesQueryData: any;
  projectPackagesUpdatesQueryData: any;
  projectPackagesUpdatesRefetch: () => void;
  projectPackagesRefetch: () => void;

  showProviderModal: boolean;
  onCloseProviderModal: () => void;
}

/** App 的弹窗聚合：新建项目 / 设置 / 项目设置 / 模型提供商。 */
export default function AppModals(props: AppModalsProps) {
  const {
    showCreateProject, onCloseCreateProject, onProjectCreated,
    modelsData, modelsLoading, createProjectMut, setProjectRoleModelsMut,
    showSettings, onCloseSettings,
    sendShortcutMode, onSendShortcutModeChange, theme, onThemeChange,
    systemNotificationsEnabled, onToggleSystemNotifications, notificationPermissionStatus,
    onOpenProviderModal, installPkgMut, togglePkgMut, removePkgMut, updatePkgMut,
    hideRoleLabels, onHideRoleLabelsChange, hiddenCompletedRoles, onHiddenCompletedRolesChange,
    showProjectSettings, onCloseProjectSettings, projectId,
    projectPackagesQueryData, projectPackagesUpdatesQueryData,
    projectPackagesUpdatesRefetch, projectPackagesRefetch,
    showProviderModal, onCloseProviderModal,
  } = props;

  return (
    <>
      {/* 注意：CreateProjectModal / ProviderModal 原本是无条件挂载（靠 isOpen=false 返回 null），
          那样 lazy 会立即加载、起不到减包作用。改为条件挂载，语义等价（Modal 在 !isOpen 时本就返回 null）。
          每个弹窗各自一层 Suspense：避免某个弹窗首次加载挂起时，把已打开的其它弹窗整块隐藏。 */}
      {showCreateProject && (
        <Suspense fallback={null}>
          <CreateProjectModal
            isOpen={showCreateProject}
            onClose={onCloseCreateProject}
            onCreated={onProjectCreated}
            modelsQueryData={modelsData}
            modelsQueryLoading={modelsLoading}
            createProjectMut={createProjectMut}
            setProjectRoleModelsMut={setProjectRoleModelsMut}
          />
        </Suspense>
      )}

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsPanel
            isOpen={showSettings}
            onClose={onCloseSettings}
            sendShortcutMode={sendShortcutMode}
            onSendShortcutModeChange={onSendShortcutModeChange}
            theme={theme}
            onThemeChange={onThemeChange}
            systemNotificationsEnabled={systemNotificationsEnabled}
            onToggleSystemNotifications={onToggleSystemNotifications}
            notificationPermissionStatus={notificationPermissionStatus}
            onOpenProviderModal={onOpenProviderModal}
            installPkgMut={installPkgMut}
            togglePkgMut={togglePkgMut}
            removePkgMut={removePkgMut}
            updatePkgMut={updatePkgMut}
            hideRoleLabels={hideRoleLabels}
            onHideRoleLabelsChange={onHideRoleLabelsChange}
            hiddenCompletedRoles={hiddenCompletedRoles}
            onHiddenCompletedRolesChange={onHiddenCompletedRolesChange}
          />
        </Suspense>
      )}

      {showProjectSettings && (
        <Suspense fallback={null}>
          <ProjectSettingsModal
            isOpen={showProjectSettings}
            onClose={onCloseProjectSettings}
            projectId={projectId}
            modelsQueryData={modelsData}
            projectPackagesQueryData={projectPackagesQueryData}
            projectPackagesUpdatesQueryData={projectPackagesUpdatesQueryData}
            projectPackagesUpdatesRefetch={projectPackagesUpdatesRefetch}
            projectPackagesRefetch={projectPackagesRefetch}
            installPkgMut={installPkgMut}
            removePkgMut={removePkgMut}
            updatePkgMut={updatePkgMut}
            togglePkgMut={togglePkgMut}
            setProjectRoleModelsMut={setProjectRoleModelsMut}
          />
        </Suspense>
      )}

      {showProviderModal && (
        <Suspense fallback={null}>
          <ProviderModal isOpen={showProviderModal} onClose={onCloseProviderModal} />
        </Suspense>
      )}
    </>
  );
}
