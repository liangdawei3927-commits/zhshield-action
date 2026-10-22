import { useAppState } from './app-logic';
import type { Page, ProjectInfo } from './app-logic';
import type { AiToolConfigData } from './types/electron';
import { FEATURE_EVOLVE_ENABLED } from './feature-flags';
import { WelcomePage } from './pages/WelcomePage';
import { GuardPage } from './pages/GuardPage';
import { SentinelPage } from './pages/SentinelPage';
import { InspectPage } from './pages/InspectPage';
import { SecurityPage } from './pages/SecurityPage';
import { DependencyPage } from './pages/DependencyPage';
import { TechDebtPage } from './pages/TechDebtPage';
import { GarbagePage } from './pages/GarbagePage';
import { PerformancePage } from './pages/PerformancePage';
import { RefactorPage } from './pages/RefactorPage';
import { BackupPage } from './pages/BackupPage';
import { EvolvePage } from './pages/EvolvePage';
import { ReportsPage } from './pages/ReportsPage';
import { ProfilePage } from './pages/ProfilePage';
import { TopNav } from './components/layout/TopNav';
import { Sidebar } from './components/layout/Sidebar';
import { ScreensaverPage } from './pages/ScreensaverPage';
import { ProjectOnboardingPage } from './components/onboarding/ProjectOnboardingPage';
import { useInactivityTimer } from './hooks/useInactivityTimer';
import { NavigationProvider } from './contexts/NavigationContext';

/** 根据当前页面渲染对应内容区（欢迎页 / 各功能页） */
function PageView({
  currentPage,
  projects,
  activeProjectPath,
  onNavigate,
  onAddProject,
}: {
  currentPage: Page;
  projects: ProjectInfo[];
  activeProjectPath?: string;
  onNavigate: (page: string) => void;
  onAddProject: () => void;
}) {
  if (projects.length === 0 && currentPage === 'welcome') {
    return <WelcomePage onAddProject={onAddProject} />;
  }
  const projectPath = activeProjectPath || projects[0]?.path || '';
  return (
    <ProjectPageView currentPage={currentPage} projectPath={projectPath} onNavigate={onNavigate} />
  );
}

/** 功能页路由：按页面键分发到对应功能页，兜底「项目体检」 */
function ProjectPageView({
  currentPage,
  projectPath,
  onNavigate,
}: {
  currentPage: Page;
  projectPath: string;
  onNavigate: (page: string) => void;
}) {
  switch (currentPage) {
    case 'guard':
      return <GuardPage projectPath={projectPath} />;
    case 'sentinel':
      return <SentinelPage projectPath={projectPath} />;
    case 'inspect':
      return <InspectPage projectPath={projectPath} />;
    case 'security':
      return <SecurityPage projectPath={projectPath} />;
    case 'deps':
      return <DependencyPage projectPath={projectPath} />;
    case 'techdebt':
      return <TechDebtPage projectPath={projectPath} />;
    case 'garbage':
      return <GarbagePage projectPath={projectPath} />;
    case 'performance':
      return <PerformancePage projectPath={projectPath} />;
    case 'refactor':
      return <RefactorPage projectPath={projectPath} />;
    case 'evolve':
      return <EvolveRoute projectPath={projectPath} />;
    case 'reports':
      return <ReportsPage projectPath={projectPath} />;
    case 'backup':
      return <BackupPage projectPath={projectPath} onNavigate={onNavigate} />;
    case 'profile':
      return <ProfilePage projectPath={projectPath} />;
    default:
      // 兜底落到「项目体检」：导航首项，也是全站唯一发起源码检查的入口
      return <InspectPage projectPath={projectPath} />;
  }
}

/** 规则进化路由：功能未达门槛时回退到「项目体检」 */
function EvolveRoute({ projectPath }: { projectPath: string }) {
  // ⛔ 规则进化暂下线：用户规模未达门槛（见 feature-flags.ts）。保持关闭，勿直接改回 EvolvePage
  return FEATURE_EVOLVE_ENABLED ? (
    <EvolvePage projectPath={projectPath} />
  ) : (
    <InspectPage projectPath={projectPath} />
  );
}

function AppLoadingView() {
  return <div className="h-screen" style={{ background: 'rgb(var(--zh-bg-tertiary))' }} />;
}

function AppShell({
  sidebarOpen,
  setSidebarOpen,
  projects,
  currentProjectIndex,
  switchCurrentProject,
  currentPage,
  setCurrentPage,
  openFolderAndAddProject,
  removeProject,
  aiTool,
  aiApplying,
  toggleAiTool,
  activeProject,
  intelligentEnabled,
  setIntelligentEnabled,
  intelligentLoading,
  onOpenProjectProfile,
  viewProps,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  projects: ProjectInfo[];
  currentProjectIndex: number;
  switchCurrentProject: (i: number) => void;
  currentPage: Page;
  setCurrentPage: (p: Page) => void;
  openFolderAndAddProject: () => void;
  removeProject: (path: string) => void;
  aiTool: AiToolConfigData | null;
  aiApplying: boolean;
  toggleAiTool: (enabled: boolean) => Promise<void>;
  activeProject?: ProjectInfo;
  intelligentEnabled: boolean;
  setIntelligentEnabled: (v: boolean) => void;
  intelligentLoading: boolean;
  onOpenProjectProfile: (project: ProjectInfo, index: number) => void;
  viewProps: {
    currentPage: Page;
    projects: ProjectInfo[];
    activeProjectPath?: string;
    onNavigate: (page: string) => void;
    onAddProject: () => void;
  };
}) {
  return (
    <>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        projects={projects}
        currentProjectIndex={currentProjectIndex}
        onSwitchProject={switchCurrentProject}
        currentPage={currentPage}
        onNavigate={(p) => setCurrentPage(p as Page)}
        onAddProject={openFolderAndAddProject}
        onRemoveProject={removeProject}
        onOpenProjectProfile={onOpenProjectProfile}
        aiTool={aiTool}
        aiApplying={aiApplying}
        onToggleAiTool={toggleAiTool}
        intelligentEnabled={intelligentEnabled}
        setIntelligentEnabled={setIntelligentEnabled}
        intelligentLoading={intelligentLoading}
      />
      <TopNav
        currentPage={currentPage}
        onNavigate={(p) => setCurrentPage(p as Page)}
        onOpenSettings={() => setSidebarOpen((v) => !v)}
        projectName={activeProject?.name}
        sidebarOpen={sidebarOpen}
      />
      <main className="flex-1 overflow-auto bg-zh-bg">
        <PageView {...viewProps} />
      </main>
    </>
  );
}

function App() {
  const appState = useAppState();
  const { idle, reset: resetInactivity } = useInactivityTimer(7 * 60 * 1000);
  if (!appState.loaded) return <AppLoadingView />;

  return (
    <NavigationProvider
      navigate={(p) => appState.setCurrentPage(p as Page)}
      currentPage={appState.currentPage}
    >
      <div className="flex flex-col h-screen bg-zh-bg font-sans">
        <MainContent appState={appState} />
        {idle && appState.projects.length > 0 && !appState.onboardingProject && (
          <ScreensaverPage onDismiss={resetInactivity} intelligentEnabled={appState.intelligentEnabled} />
        )}
      </div>
    </NavigationProvider>
  );
}

/** 主内容区：项目引导 / 欢迎页 / 应用壳层三态切换 */
function MainContent({ appState }: { appState: ReturnType<typeof useAppState> }) {
  const {
    currentPage,
    setCurrentPage,
    projects,
    sidebarOpen,
    setSidebarOpen,
    aiTool,
    aiApplying,
    openFolderAndAddProject,
    removeProject,
    toggleAiTool,
    intelligentEnabled,
    setIntelligentEnabled,
    intelligentLoading,
    onboardedPaths,
    onboardingProject,
    setOnboardingProject,
    currentProjectIndex,
    switchCurrentProject,
  } = appState;
  const activeProject = projects[currentProjectIndex] ?? projects[0];
  const handleOpenProjectProfile = (project: ProjectInfo, index: number) => {
    switchCurrentProject(index);
    if (onboardedPaths.has(project.path)) {
      setCurrentPage('profile');
    } else {
      setOnboardingProject(project.name);
    }
  };
  const viewProps = {
    currentPage,
    projects,
    activeProjectPath: activeProject?.path,
    onNavigate: (p: string) => setCurrentPage(p as Page),
    onAddProject: openFolderAndAddProject,
  } as const;

  return onboardingProject ? (
    <OnboardingView projectName={onboardingProject} appState={appState} />
  ) : projects.length === 0 && currentPage === 'welcome' ? (
    <PageView {...viewProps} />
  ) : (
    <AppShell
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      projects={projects}
      currentProjectIndex={currentProjectIndex}
      switchCurrentProject={switchCurrentProject}
      currentPage={currentPage}
      setCurrentPage={setCurrentPage}
      openFolderAndAddProject={openFolderAndAddProject}
      removeProject={removeProject}
      aiTool={aiTool}
      aiApplying={aiApplying}
      toggleAiTool={toggleAiTool}
      activeProject={activeProject}
      intelligentEnabled={intelligentEnabled}
      setIntelligentEnabled={setIntelligentEnabled}
      intelligentLoading={intelligentLoading}
      onOpenProjectProfile={handleOpenProjectProfile}
      viewProps={viewProps}
    />
  );
}

/** 项目引导页：完成后标记已引导并跳转「项目体检」 */
function OnboardingView({
  projectName,
  appState,
}: {
  projectName: string;
  appState: ReturnType<typeof useAppState>;
}) {
  const { projects, markOnboarded, setOnboardingProject, setCurrentPage, intelligentEnabled } =
    appState;
  const handleOnboardingComplete = () => {
    const path = projects.find((p) => p.name === projectName)?.path;
    if (path) markOnboarded(path);
    setOnboardingProject(null);
    setCurrentPage('inspect');
  };
  return (
    <ProjectOnboardingPage
      projectName={projectName}
      projectPath={projects.find((p) => p.name === projectName)?.path ?? ''}
      onComplete={handleOnboardingComplete}
      onClose={() => setOnboardingProject(null)}
      intelligentEnabled={intelligentEnabled}
    />
  );
}

export default App;
