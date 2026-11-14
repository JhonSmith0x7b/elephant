"use client";

import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient({
  sessionOptions: { refetchInterval: 60 * 60, refetchOnWindowFocus: true },
});

/** Receive renewal cookies via HTTP, including for still-valid older sessions. */
export default function SessionRefresh() {
  authClient.useSession();
  return null;
}
