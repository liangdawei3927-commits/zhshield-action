import { useAppState } from './app-logic';
import type { Page, ProjectInfo } from './app-logic';
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

/** 根据当前页面渲染对应内容区（欢迎页 / 各功能页） */
function PageView({ currentPage, projects, onNavigate, onAddProject }: {
  currentPage: Page;
  projects: ProjectInfo[];
  onNavigate: (page: string) => void;
  onAddProject: () => void;
}) {
  if (projects.length === 0 && currentPage === 'welcome') {
    return <WelcomePage onAddProject={onAddProject} />;
  }
  const projectPath = projects[0]?.path ?? '';
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
  } = useAppState();

  if (!loaded) {
    return <div className="h-screen" style={{ background: 'rgb(var(--zh-bg-tertiary))' }} />;
  }

  const viewProps = {
    currentPage,
    projects,
    onNavigate: (p: string) => setCurrentPage(p as Page),
    onAddProject: openFolderAndAddProject,
  } as const;

  return (
    <div className="flex flex-col h-screen bg-zh-bg font-sans">
      {projects.length === 0 && currentPage === 'welcome' ? (
        <PageView {...viewProps} />
      ) : (
        <>
          <Sidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            projects={projects}
            currentPage={currentPage}
            onNavigate={(p) => setCurrentPage(p as Page)}
            onAddProject={openFolderAndAddProject}
            onRemoveProject={removeProject}
            aiTool={aiTool}
            aiApplying={aiApplying}
            onToggleAiTool={toggleAiTool}
          />
          <TopNav
            currentPage={currentPage}
            onNavigate={(p) => setCurrentPage(p as Page)}
            onOpenSettings={() => setSidebarOpen((v) => !v)}
            projectName={projects[0]?.name}
            sidebarOpen={sidebarOpen}
          />
          <main className="flex-1 overflow-auto bg-zh-bg">
            <PageView {...viewProps} />
          </main>
        </>
      )}
    </div>
  );
}

export default App;
