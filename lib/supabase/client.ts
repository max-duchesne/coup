import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

/**
 * Browser-side Supabase client. Reads/writes the auth session via cookies
 * (set by the proxy in `proxy.ts`) so that the same session is visible to
 * Server Components, Route Handlers, and Server Actions.
 *
 * `createBrowserClient` already memoizes a singleton internally, so calling
 * this on every render is cheap.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
