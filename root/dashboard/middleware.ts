import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const url = req.nextUrl;

  // Allow Next.js internals & public assets
  if (
    url.pathname.startsWith("/_next") ||
    url.pathname.startsWith("/favicon") ||
    url.pathname.startsWith("/robots") ||
    url.pathname.startsWith("/sitemap")
  ) {
    return NextResponse.next();
  }

  const passkey = process.env.SITE_PASSKEY!;
  const fromHeader = req.headers.get("x-passkey");
  const fromQuery  = url.searchParams.get("key");
  const fromCookie = req.cookies.get("site_passkey")?.value;

  const provided = fromHeader || fromQuery || fromCookie;

  if (provided !== passkey) {
    // Serve the app so the PasskeyGate can render, but mark as locked
    const res = NextResponse.next();
    res.headers.set("x-locked", "1");
    return res;
  }

  // If ?key=... was used, persist it to cookie
  if (fromQuery === passkey) {
    const res = NextResponse.next();
    res.cookies.set("site_passkey", passkey, {
      httpOnly: false, // must be readable by client JS for fetch header helper (optional)
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/health).*)"],
};
