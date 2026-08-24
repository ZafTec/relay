import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router-dom";
import type { AuthAdapter } from "../auth/types";
import { AuthProvider } from "../auth/AuthProvider";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { ProductLayout } from "../components/layout/ProductLayout";
import { ArtifactDetailPage, ArtifactsPage } from "../features/artifacts";
import { SignInPage } from "../features/auth/SignInPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ChangelogPage } from "../features/changelog/ChangelogPage";
import { DocsPage } from "../features/docs/DocsPage";
import { LandingPage } from "../features/landing/LandingPage";
import { NotFoundPage } from "../features/not-found/NotFoundPage";
import { OAuthConsentPage } from "../features/oauth/OAuthConsentPage";
import { OAuthWorkspacePage } from "../features/oauth/OAuthWorkspacePage";
import { ProfilePage } from "../features/profile/ProfilePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { StatusPage } from "../features/status/StatusPage";
import { ToolDetailPage, ToolsPage } from "../features/tools";
import { RouteErrorPage } from "./RouteErrorPage";

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
          { path: "tools", element: <ToolsPage /> },
          { path: "tools/:toolKey", element: <ToolDetailPage /> },
          { path: "artifacts", element: <ArtifactsPage /> },
          { path: "artifacts/:artifactId", element: <ArtifactDetailPage /> },
          { path: "settings", element: <SettingsPage /> },
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
