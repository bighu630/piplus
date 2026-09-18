import type { ModelInfo } from '../lib/api';
import CreateProjectModal from './CreateProjectModal';
import ProviderModal from './ProviderModal';
import ProjectSettingsModal from './ProjectSettingsModal';
import SettingsPanel from './SettingsPanel';

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
      <CreateProjectModal
        isOpen={showCreateProject}
        onClose={onCloseCreateProject}
        onCreated={onProjectCreated}
        modelsQueryData={modelsData}
        modelsQueryLoading={modelsLoading}
        createProjectMut={createProjectMut}
        setProjectRoleModelsMut={setProjectRoleModelsMut}
      />

      {showSettings && (
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
      )}

      {showProjectSettings && (
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
      )}

      <ProviderModal isOpen={showProviderModal} onClose={onCloseProviderModal} />
    </>
  );
}
