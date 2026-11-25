import { ErrorPage, type LinkAdapterProps, LinkProvider, NotFound } from "@slashsuite/ui-react";
import {
  createRouter as createTanStackRouter,
  type ErrorComponentProps,
  Link,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Page } from "#/components/ui";
import { reportBrowserError } from "#/lib/sentry-browser";
import { routeTree } from "./routeTree.gen";

const SERVER_ONLY = /^\/(auth|api|images)\//;

/**
 * Every ui-react link takes a plain `href` and is drawn here, through the router's `<Link>` (the
 * `href` wins over `to="."`). A link marked `data-in-place` (a tab that only changes the search)
 * replaces the history entry and keeps the scroll, as the tabs always did.
 */
function RouterLink(props: LinkAdapterProps) {
  // A server route (sign-in, the API, a signed image, a download) has no page to render: the
  // browser loads it, not the router.
  if ("download" in props || SERVER_ONLY.test(props.href)) return <a {...props} />;
  const inPlace = "data-in-place" in props;
  return <Link to="." {...props} {...(inPlace ? { replace: true, resetScroll: false } : {})} />;
}

function Links({ children }: { children: ReactNode }) {
  return <LinkProvider link={RouterLink}>{children}</LinkProvider>;
}

/** The page a route's error lands on: also reported to Sentry, when this deployment has a DSN (PS-227). */
function RouteError({ error, reset }: ErrorComponentProps) {
  useEffect(() => reportBrowserError(error), [error]);
  return (
    <Page>
      <ErrorPage onRetry={reset} />
    </Page>
  );
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: () => (
      <Page>
        <NotFound />
      </Page>
    ),
    defaultErrorComponent: RouteError,
    InnerWrap: Links,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
