import { createClient } from "@/lib/supabase/client";

/**
 * Backwards-compatibility shim for existing client-side imports.
 *
 * New code should import `createClient` from `@/lib/supabase/client` (browser)
 * or `@/lib/supabase/server` (Server Components / Actions / Route Handlers).
 * This singleton is preserved so that the lobby/game pages keep working
 * during the auth refactor (Step 1) before the identity pass (Step 2).
 *
 * Safe to call from client code only — `createBrowserClient` already
 * memoizes a singleton internally, so re-creating per import is cheap.
 */
export const supabase = createClient();
