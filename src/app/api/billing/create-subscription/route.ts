import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      entity_id,
      plan_key,
      reason,
      is_test = false,
    } = body ?? {};

    if (!entity_id || !plan_key || !reason) {
      return NextResponse.json(
        { ok: false, error: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    // 🔐 Server-side authority client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );

    // Optional: verify operator session exists (defensive)
    const cookieStore = cookies();
    if (!cookieStore.get("sb-access-token")) {
      return NextResponse.json(
        { ok: false, error: "NO_OPERATOR_SESSION" },
        { status: 401 }
      );
    }

    // 🔁 Call the Edge Function as service_role
    const { data, error } = await supabase.functions.invoke(
      "billing-create-subscription",
      {
        body: {
          entity_id,
          plan_key,
          reason,
          is_test,
        },
      }
    );

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "UNKNOWN_FAILURE" },
      { status: 500 }
    );
  }
}
