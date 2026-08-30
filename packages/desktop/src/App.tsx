import { useAppState } from './app-logic';
import type { Page, ProjectInfo } from './app-logic';
import type { AiToolConfigData } from './types/electron';
import { WelcomePage } from './pages/WelcomePage';
import { DashboardPage } from './pages/DashboardPage';
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

/** 根据当前页面渲染对应内容区（欢迎页 / 各功能页） */
function PageView({ currentPage, projects, activeProjectPath, onNavigate, onAddProject }: {
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
  switch (currentPage) {
    case 'dashboard':
      return <DashboardPage projectPath={projectPath} />;
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
      return <EvolvePage projectPath={projectPath} />;
    case 'reports':
      return <ReportsPage projectPath={projectPath} />;
    case 'backup':
      return <BackupPage projectPath={projectPath} onNavigate={onNavigate} />;
    case 'profile':
      return <ProfilePage projectPath={projectPath} />;
    case 'scoring':
      return <DashboardPage projectPath={projectPath} />;
    default:
      return <DashboardPage projectPath={projectPath} />;
  }
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
  const {
    currentPage,
    setCurrentPage,
    projects,
    sidebarOpen,
    setSidebarOpen,
    loaded,
    aiTool,
    aiApplying,
    openFolderAndAddProject,
    removeProject,
    toggleAiTool,
    intelligentEnabled,
    setIntelligentEnabled,
    intelligentLoading,
    onboardingProject,
    setOnboardingProject,
    currentProjectIndex,
    switchCurrentProject,
  } = useAppState();
  const { idle, reset: resetInactivity } = useInactivityTimer(7 * 60 * 1000);
  if (!loaded) return <AppLoadingView />;
  const activeProject = projects[currentProjectIndex] ?? projects[0];
  const handleOnboardingComplete = () => {
    setOnboardingProject(null);
    setCurrentPage('dashboard');
  };
  const viewProps = {
    currentPage,
    projects,
    activeProjectPath: activeProject?.path,
    onNavigate: (p: string) => setCurrentPage(p as Page),
    onAddProject: openFolderAndAddProject,
  } as const;

  return (
    <div className="flex flex-col h-screen bg-zh-bg font-sans">
      {projects.length === 0 && currentPage === 'welcome' ? (
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
          viewProps={viewProps}
        />
      )}

      {idle && projects.length > 0 && <ScreensaverPage onDismiss={resetInactivity} />}

      {onboardingProject && (
        <ProjectOnboardingPage
          projectName={onboardingProject}
          projectPath={projects.find((p) => p.name === onboardingProject)?.path ?? ''}
          onComplete={handleOnboardingComplete}
        />
      )}
    </div>
  );
}

export default App;
