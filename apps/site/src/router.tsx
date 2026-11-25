import { ErrorPage, LinkProvider, NotFound } from "@slashsuite/ui-react";
import {
  createRouter as createTanStackRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SLASHSLASH } from "./content/moved.ts";
import { routeTree } from "./routeTree.gen";

function RouteError({ reset }: ErrorComponentProps) {
  return <ErrorPage onRetry={reset} />;
}

/** The status pages' "Back to home" goes to slashslash.build, where this site's pages now live. */
function Home({ children }: { children: ReactNode }) {
  return <LinkProvider home={SLASHSLASH}>{children}</LinkProvider>;
}

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: () => <NotFound />,
    defaultErrorComponent: RouteError,
    InnerWrap: Home,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
