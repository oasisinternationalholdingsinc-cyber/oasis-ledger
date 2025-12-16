// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const path = req.nextUrl.pathname;

  // ✅ Public routes (no auth required)
  const isPublic =
    path === "/" ||
    path === "/login" ||
    path.startsWith("/login/") ||
    path.startsWith("/auth") ||
    path.startsWith("/public") ||
    path.startsWith("/api") || // keep APIs reachable unless you explicitly want them locked
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml";

  // ✅ Always allow Next static assets
  // (matcher already excludes most, but this is extra-safe)
  const isAsset =
    path.startsWith("/_next") ||
    path.startsWith("/images") ||
    path.startsWith("/fonts");

  if (isPublic || isAsset) return res;

  // 🔒 Everything else requires an authenticated session (cookie-based)
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
