// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  // IMPORTANT: always mutate and return the same response instance
  let response = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const path = request.nextUrl.pathname;

  // ───────────────────────────────────────────────────────────
  // ✅ PUBLIC ROUTES (no auth required)
  // ───────────────────────────────────────────────────────────
  const isPublic =
    path === "/" ||
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/public") ||
    path.startsWith("/forgot-password") ||
    path.startsWith("/reset-password") ||
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml";

  // Ignore Next internals + API routes
  if (
    isPublic ||
    path.startsWith("/_next") ||
    path.startsWith("/api")
  ) {
    return response;
  }

  // ───────────────────────────────────────────────────────────
  // 🔐 AUTH CHECK
  // ───────────────────────────────────────────────────────────
  const { data } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);

    // IMPORTANT: still return the same response variable
    response = NextResponse.redirect(url);
    return response;
  }

  return response;
}

// Apply to everything except static assets
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
