import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every request except:
     *   - _next/static, _next/image (Next internals)
     *   - favicon.ico
     *   - common static asset extensions
     * Auth routes (/auth/*, /login) MUST be included so the proxy can
     * write the session cookie after sign-in.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
