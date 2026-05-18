import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";

/**
 * Refreshes the Supabase auth session on every request and propagates the
 * refreshed cookies to both the upstream request (so Server Components see
 * the new session) and the downstream response (so the browser stores it).
 *
 * Called from the project-root `proxy.ts` (Next.js 16 renamed `middleware`
 * to `proxy`).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // IMPORTANT: getUser() must be called between createServerClient and
  // returning supabaseResponse. It contacts the Supabase auth server and
  // refreshes the access token if needed; without it, expired sessions
  // would silently 401 in Server Components.
  await supabase.auth.getUser();

  return supabaseResponse;
}
