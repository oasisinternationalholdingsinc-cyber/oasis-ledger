import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function hasAuthCookie(req: NextRequest) {
  const names = [
    "sb-access-token",
    "sb-refresh-token",
    "sb:token",
    "supabase-auth-token",
    // Keep this commented unless you KNOW you have it:
    // "sb-mumalwdczrmxvbenqmgh-auth-token",
  ];

  return names.some((n) => Boolean(req.cookies.get(n)?.value));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ✅ ONLY root is the enterprise "entrance router"
  if (pathname !== "/") return NextResponse.next();

  // ✅ Authenticated → console launchpad
  if (hasAuthCookie(req)) {
    const url = req.nextUrl.clone();
    url.pathname = "/console";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // ✅ Not authenticated → login (next=/console)
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent("/console")}`;
  return NextResponse.redirect(url);
}

// ✅ Match ONLY "/" to avoid touching (os), console, login, api, etc.
export const config = {
  matcher: ["/"],
};
