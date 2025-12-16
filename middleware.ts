// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
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
            // write cookies onto the response (this is the key)
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const path = request.nextUrl.pathname;

  // ✅ public routes
  const isPublic =
    path === "/" ||
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/public") ||
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/sitemap.xml";

  // ✅ ignore Next internals + api
  if (
    isPublic ||
    path.startsWith("/_next") ||
    path.startsWith("/api") ||
    path.startsWith("/favicon.ico")
  ) {
    return response;
  }

  const { data } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);

    // IMPORTANT: use the same `response` variable so cookie writes still work
    response = NextResponse.redirect(url);
    return response;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
