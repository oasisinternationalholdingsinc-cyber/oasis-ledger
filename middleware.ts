import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function hasAuthCookie(req: NextRequest) {
  const names = [
    "sb-access-token",
    "sb-refresh-token",
    "sb:token",
    "supabase-auth-token",
    // Uncomment ONLY if you are 100% sure this cookie exists:
    // "sb-mumalwdczrmxvbenqmgh-auth-token",
  ];

  return names.some((n) => Boolean(req.cookies.get(n)?.value));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ✅ ROOT ONLY = ceremonial enterprise entrance
  if (pathname !== "/") return NextResponse.next();

  // ✅ Authenticated → Operator Launchpad
  if (hasAuthCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/console-launchpad";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // ✅ Unauthenticated → Login → return to launchpad
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent("/console-launchpad")}`;
  return NextResponse.redirect(url);
}

// ✅ Match ONLY "/" — never touch console, ledger, CI routes, auth, or APIs
export const config = {
  matcher: ["/"],
};
