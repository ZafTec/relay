import { lazy, Suspense, type ReactNode } from "react";
import {
  createBrowserRouter,
  createMemoryRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import type { AuthAdapter } from "../auth/types";
import { AuthProvider } from "../auth/AuthProvider";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { ProductLayout } from "../components/layout/ProductLayout";
import { LoadingPageState } from "../components/ui/PageState";
import { Skeleton } from "../components/ui/Skeleton";
import { SignInPage } from "../features/auth/SignInPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ChangelogEntryPage } from "../features/changelog/ChangelogEntryPage";
import { ChangelogPage } from "../features/changelog/ChangelogPage";
import { DocsPage } from "../features/docs/DocsPage";
import { LandingPage } from "../features/landing/LandingPage";
import { NotFoundPage } from "../features/not-found/NotFoundPage";
import { OAuthConsentPage } from "../features/oauth/OAuthConsentPage";
import { OAuthWorkspacePage } from "../features/oauth/OAuthWorkspacePage";
import { ProfilePage } from "../features/profile/ProfilePage";
import { StatusPage } from "../features/status/StatusPage";
import { RouteErrorPage } from "./RouteErrorPage";

const ToolsPage = lazy(() => import("../features/tools").then((module) => ({
  default: module.ToolsPage,
})));
const ToolDetailPage = lazy(() => import("../features/tools").then((module) => ({
  default: module.ToolDetailPage,
})));
const RunsPage = lazy(() => import("../features/runs").then((module) => ({
  default: module.RunsPage,
})));
const RunDetailPage = lazy(() => import("../features/runs").then((module) => ({
  default: module.RunDetailPage,
})));
const ArtifactsPage = lazy(() => import("../features/artifacts").then((module) => ({
  default: module.ArtifactsPage,
})));
const ArtifactDetailPage = lazy(() => import("../features/artifacts").then((module) => ({
  default: module.ArtifactDetailPage,
})));
const UsagePage = lazy(() => import("../features/usage").then((module) => ({
  default: module.UsagePage,
})));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((module) => ({
  default: module.SettingsPage,
})));
const AdminChangelogRouteBoundary = lazy(() => import("../features/admin-changelog").then((module) => ({
  default: module.AdminChangelogRouteBoundary,
})));
const AdminLayout = lazy(() => import("../features/admin-changelog").then((module) => ({
  default: module.AdminLayout,
})));
const AdminChangelogListPage = lazy(() => import("../features/admin-changelog").then((module) => ({
  default: module.AdminChangelogListPage,
})));
const AdminChangelogEditorPage = lazy(() => import("../features/admin-changelog").then((module) => ({
  default: module.AdminChangelogEditorPage,
})));
const AdminChangelogPreviewPage = lazy(() => import("../features/admin-changelog").then((module) => ({
  default: module.AdminChangelogPreviewPage,
})));

function productRoute(content: ReactNode, loadingLabel: string) {
  return (
    <Suspense
      fallback={(
        <div className="product-route-loading">
          <Skeleton label={loadingLabel} lines={5} />
        </div>
      )}
    >
      {content}
    </Suspense>
  );
}

function protectedLazyRoute(content: ReactNode, loadingLabel: string) {
  return (
    <Suspense fallback={<LoadingPageState label={loadingLabel} />}>
      {content}
    </Suspense>
  );
}

export const relayRoutes = [
  {
    path: "/",
    element: <LandingPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: "/sign-in",
    element: <SignInPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: "/changelog",
    element: <ChangelogPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: "/changelog/:slug",
    element: <ChangelogEntryPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: "/docs",
    element: <DocsPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: "/status",
    element: <StatusPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: "/dashboard",
        element: <ProductLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "tools", element: productRoute(<ToolsPage />, "Loading tools") },
          {
            path: "tools/:toolKey",
            element: productRoute(<ToolDetailPage />, "Loading tool contract"),
          },
          { path: "runs", element: productRoute(<RunsPage />, "Loading runs") },
          {
            path: "runs/:runId",
            element: productRoute(<RunDetailPage />, "Loading run details"),
          },
          {
            path: "artifacts",
            element: productRoute(<ArtifactsPage />, "Loading artifacts"),
          },
          {
            path: "artifacts/:artifactId",
            element: productRoute(<ArtifactDetailPage />, "Loading artifact details"),
          },
          { path: "usage", element: productRoute(<UsagePage />, "Loading usage") },
          {
            path: "settings",
            element: productRoute(<SettingsPage />, "Loading workspace settings"),
          },
        ],
      },
      {
        path: "/admin",
        element: protectedLazyRoute(
          <AdminChangelogRouteBoundary />,
          "Checking admin access",
        ),
        children: [
          {
            element: protectedLazyRoute(<AdminLayout />, "Loading admin console"),
            children: [
              { index: true, element: <Navigate to="changelog" replace /> },
              {
                path: "changelog",
                element: productRoute(
                  <AdminChangelogListPage />,
                  "Loading changelog releases",
                ),
              },
              {
                path: "changelog/new",
                element: productRoute(
                  <AdminChangelogEditorPage createNew />,
                  "Loading release editor",
                ),
              },
              {
                path: "changelog/:releaseId",
                element: productRoute(
                  <AdminChangelogEditorPage />,
                  "Loading release editor",
                ),
              },
              {
                path: "changelog/:releaseId/preview",
                element: productRoute(
                  <AdminChangelogPreviewPage />,
                  "Loading release preview",
                ),
              },
            ],
          },
        ],
      },
      {
        path: "/profile",
        element: <ProfilePage />,
      },
      {
        path: "/oauth/consent",
        element: <OAuthConsentPage />,
      },
      {
        path: "/oauth/workspace",
        element: <OAuthWorkspacePage />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
];

export function createRelayMemoryRouter(initialEntries: string[]) {
  return createMemoryRouter(relayRoutes, { initialEntries });
}

const browserRouter = createBrowserRouter(relayRoutes);

interface AppProps {
  adapter?: AuthAdapter;
  router?: typeof browserRouter;
}

export function App({ adapter, router = browserRouter }: AppProps) {
  return (
    <AuthProvider adapter={adapter}>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
