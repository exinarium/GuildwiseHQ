import { createBrowserRouter, Navigate, useParams } from 'react-router';
import { useInterests } from './api/queries/interests.ts';
import { useProjects } from './api/queries/projects.ts';
import { RequireAuth } from './components/Layout.tsx';
import { PlatformShell } from './components/platform/PlatformShell.tsx';
import { RouteError } from './components/RouteError.tsx';
import { PageSkeleton } from './components/ui.tsx';
import { getLastProjectKey } from './lib/lastProject.ts';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Agents } from './pages/Agents.tsx';
import { Archive } from './pages/Archive.tsx';
import { Automations } from './pages/Automations.tsx';
import { Backlog } from './pages/Backlog.tsx';
import { BILLING_GATE_PATH } from './pages/BillingGate.tsx';
import { Board } from './pages/Board.tsx';
import { BoardroomList } from './pages/Boardroom.tsx';
import { BoardroomSession } from './pages/BoardroomSession.tsx';
import { Capabilities } from './pages/Capabilities.tsx';
import { CardDetail } from './pages/CardDetail.tsx';
import { CardNew } from './pages/CardNew.tsx';
import { Ceo } from './pages/Ceo.tsx';
import { CeoChat } from './pages/CeoChat.tsx';
import { Chat } from './pages/Chat.tsx';
import { ContactPublic } from './pages/ContactPublic.tsx';
import { Costs } from './pages/Costs.tsx';
import { Desk } from './pages/Desk.tsx';
import { DiscoveryList } from './pages/Discovery.tsx';
import { DiscoverySession } from './pages/DiscoverySession.tsx';
import { DocumentsList, DocumentView } from './pages/Documents.tsx';
import { ForgotPassword } from './pages/ForgotPassword.tsx';
import { Help, PlatformHelp } from './pages/Help.tsx';
import { IntakeNew, IntakeView } from './pages/Intake.tsx';
import { BatchView } from './pages/IntakeBatch.tsx';
import { Integrations, IntegrationsIndex } from './pages/Integrations.tsx';
import { InterestDetail } from './pages/InterestDetail.tsx';
import { Interests } from './pages/Interests.tsx';
import { Ledger } from './pages/Ledger.tsx';
import { Login } from './pages/Login.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { OrgChartPage } from './pages/OrgChart.tsx';
import { OrgDesigner } from './pages/OrgDesigner.tsx';
import { OrgSettings } from './pages/OrgSettings.tsx';
import { Phase } from './pages/Phase.tsx';
import { PlatformTeamDesk } from './pages/PlatformTeamDesk.tsx';
import { ProjectEnvironments } from './pages/ProjectEnvironments.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { Projects } from './pages/Projects.tsx';
import { PlatformApiKeys } from './pages/platform/PlatformApiKeys.tsx';
import { PlatformAudit } from './pages/platform/PlatformAudit.tsx';
import { PlatformBilling } from './pages/platform/PlatformBilling.tsx';
import { PlatformBlog } from './pages/platform/PlatformBlog.tsx';
import { PlatformBlogPost } from './pages/platform/PlatformBlogPost.tsx';
import { PlatformInbound } from './pages/platform/PlatformInbound.tsx';
import { PlatformInvitations } from './pages/platform/PlatformInvitations.tsx';
import { PlatformOrgDetail } from './pages/platform/PlatformOrgDetail.tsx';
import { PlatformOrgs } from './pages/platform/PlatformOrgs.tsx';
import { PlatformRunners } from './pages/platform/PlatformRunners.tsx';
import { PlatformSupport } from './pages/platform/PlatformSupport.tsx';
import { PlatformSupportTicket } from './pages/platform/PlatformSupportTicket.tsx';
import { PlatformTeam } from './pages/platform/PlatformTeam.tsx';
import { PlatformUsers } from './pages/platform/PlatformUsers.tsx';
import { Releases } from './pages/Releases.tsx';
import { ResearchTab } from './pages/ResearchTab.tsx';
import { ResetPassword } from './pages/ResetPassword.tsx';
import { Settings } from './pages/Settings.tsx';
import { Signup } from './pages/Signup.tsx';
import { Vaults } from './pages/Vaults.tsx';
import { VerifyEmail } from './pages/VerifyEmail.tsx';
import { WorkflowBuilderPage } from './pages/WorkflowBuilderPage.tsx';
import { Workstations } from './pages/Workstations.tsx';

function Home() {
  const projects = useProjects();
  if (projects.isPending) return <PageSkeleton label="Loading" />;
  const last = getLastProjectKey();
  const key = projects.data?.find((p) => p.key === last)?.key ?? projects.data?.[0]?.key;
  return <Navigate to={key ? `/p/${key}/board` : '/projects'} replace />;
}

/**
 * The old per-project pages of a feed project (`/p/KEY/feed`, and the board of its hidden project) now live on the
 * interest behind the key; any other key goes to the projects page.
 */
function InterestRedirect({ tab }: { tab?: string }) {
  const { projectKey = '' } = useParams();
  const list = useInterests();
  const archived = useInterests({ archived: true });
  if (list.isPending || archived.isPending) return <PageSkeleton label="Loading" />;
  const found = [...(list.data?.interests ?? []), ...(archived.data?.interests ?? [])].find(
    (i) => i.projectKey === projectKey,
  );
  return <Navigate to={found ? `/interests/${found.id}${tab ? `?tab=${tab}` : ''}` : '/projects'} replace />;
}

export const routes = [
  { path: '/login', element: <Login />, errorElement: <RouteError /> },
  { path: '/forgot-password', element: <ForgotPassword />, errorElement: <RouteError /> },
  { path: '/reset-password/:token', element: <ResetPassword />, errorElement: <RouteError /> },
  { path: '/signup', element: <Signup />, errorElement: <RouteError /> },
  { path: '/verify-email/:token', element: <VerifyEmail />, errorElement: <RouteError /> },
  { path: '/contact', element: <ContactPublic />, errorElement: <RouteError /> },
  { path: '/invite/:token', element: <AcceptInvite />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Home /> },
      { path: BILLING_GATE_PATH, element: null },
      { path: '/p/:projectKey/board', element: <Board /> },
      { path: '/p/:projectKey/archive', element: <Archive /> },
      { path: '/p/:projectKey/backlog', element: <Backlog /> },
      { path: '/p/:projectKey/feed', element: <InterestRedirect tab="digest" /> },
      { path: '/p/:projectKey/research', element: <ResearchTab /> },
      { path: '/p/:projectKey/phases/:number', element: <Phase /> },
      { path: '/p/:projectKey/environments', element: <ProjectEnvironments /> },
      { path: '/automations', element: <Automations /> },
      { path: '/schedules', element: <Navigate to="/automations" replace /> },
      { path: '/interests', element: <Interests /> },
      { path: '/interests/:id', element: <InterestDetail /> },
      { path: '/cards/new', element: <CardNew /> },
      { path: '/cards/:ref', element: <CardDetail /> },
      { path: '/projects', element: <Projects /> },
      { path: '/projects/:id/settings', element: <ProjectSettings /> },
      { path: '/agents', element: <Agents /> },
      { path: '/hr', element: <Agents /> },
      { path: '/metrics', element: <Metrics /> },
      { path: '/org', element: <OrgDesigner /> },
      { path: '/org/workflows/:draftId', element: <WorkflowBuilderPage /> },
      { path: '/org-chart', element: <OrgChartPage /> },
      { path: '/org/ceo', element: <Ceo /> },
      { path: '/costs', element: <Costs /> },
      { path: '/workstations', element: <Workstations /> },
      { path: '/workstations/:id/integrations', element: <Integrations /> },
      { path: '/integrations', element: <IntegrationsIndex /> },
      { path: '/settings', element: <Settings /> },
      { path: '/settings/vaults', element: <Vaults /> },
      { path: '/settings/capabilities', element: <Capabilities /> },
      { path: '/settings/org', element: <OrgSettings /> },
      { path: '/admin', element: <Navigate to="/settings/org" replace /> },
      { path: '/desk', element: <Desk /> },
      { path: '/releases', element: <Releases /> },
      { path: '/deploys', element: <Navigate to="/releases" replace /> },
      { path: '/platform-team', element: <PlatformTeamDesk /> },
      { path: '/help', element: <Help /> },
      { path: '/help/glossary', element: <Help /> },
      { path: '/help/contact', element: <Help /> },
      { path: '/help/requests', element: <Help /> },
      { path: '/help/requests/:id', element: <Help /> },
      { path: '/help/blog', element: <Help /> },
      { path: '/help/blog/:slug', element: <Help /> },
      { path: '/help/:slug', element: <Help /> },
      { path: '/ledger', element: <Ledger /> },
      { path: '/chat/:threadId', element: <Chat /> },
      { path: '/ceo-chat', element: <CeoChat /> },
      { path: '/ceo-chat/:threadId', element: <CeoChat /> },
      { path: '/discovery', element: <DiscoveryList /> },
      { path: '/discovery/:id', element: <DiscoverySession /> },
      { path: '/boardroom', element: <BoardroomList /> },
      { path: '/boardroom/:id', element: <BoardroomSession /> },
      { path: '/documents', element: <DocumentsList /> },
      { path: '/documents/:id', element: <DocumentView /> },
      { path: '/intake', element: <IntakeNew /> },
      { path: '/intake/batches/:id', element: <BatchView /> },
      { path: '/intake/:id', element: <IntakeView /> },
    ],
  },
  {
    element: <RequireAuth platform />,
    errorElement: <RouteError />,
    children: [
      {
        element: <PlatformShell />,
        children: [
          { path: '/platform', element: <PlatformOrgs /> },
          { path: '/platform/orgs/:id', element: <PlatformOrgDetail /> },
          { path: '/platform/invitations', element: <PlatformInvitations /> },
          { path: '/platform/users', element: <PlatformUsers /> },
          { path: '/platform/billing', element: <PlatformBilling /> },
          { path: '/platform/support', element: <PlatformSupport /> },
          { path: '/platform/support/:id', element: <PlatformSupportTicket /> },
          { path: '/platform/blog', element: <PlatformBlog /> },
          { path: '/platform/blog/:id', element: <PlatformBlogPost /> },
          { path: '/platform/api-keys', element: <PlatformApiKeys /> },
          { path: '/platform/runners', element: <PlatformRunners /> },
          { path: '/platform/team', element: <PlatformTeam /> },
          { path: '/platform/inbound', element: <PlatformInbound /> },
          { path: '/platform/audit', element: <PlatformAudit /> },
          { path: '/platform/help', element: <PlatformHelp /> },
          { path: '/platform/help/glossary', element: <PlatformHelp /> },
          { path: '/platform/help/blog', element: <PlatformHelp /> },
          { path: '/platform/help/blog/:slug', element: <PlatformHelp /> },
          { path: '/platform/help/:slug', element: <PlatformHelp /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const createRouter = () => createBrowserRouter(routes);
