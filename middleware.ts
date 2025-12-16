// middleware.ts
import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 🔓 allow everything except protected APIs
  if (!path.startsWith("/api/secure")) {
    return NextResponse.next();
  }

  // 🔒 API auth handled inside route handlers (Supabase server client)
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/secure/:path*"],
};
