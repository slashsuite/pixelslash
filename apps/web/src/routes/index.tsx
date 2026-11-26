import { createFileRoute, redirect } from "@tanstack/react-router";
import { Button, CenteredLayout, Stack } from "@slashsuite/ui-react";
import { Page } from "#/components/ui";
import { getViewer } from "#/server/fns";
import { getSignInOptions } from "#/server/sign-in";
import { titled } from "#/lib/page-title";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getViewer()) throw redirect({ to: "/orgs" });
  },
  loader: () => getSignInOptions(),
  head: () => titled(),
  component: SignIn,
});

function SignIn() {
  const { google } = Route.useLoaderData();
  return (
    <Page>
      <CenteredLayout title="PixelSlash" description="Visual review for every build.">
        <Stack gap="sm">
          <Button href="/auth/github">Sign in with GitHub</Button>
          {google && (
            <Button href="/auth/google" variant="outline">
              Sign in with Google
            </Button>
          )}
        </Stack>
      </CenteredLayout>
    </Page>
  );
}
