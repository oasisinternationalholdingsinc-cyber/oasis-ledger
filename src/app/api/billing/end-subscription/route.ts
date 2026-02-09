import { NextResponse } from "next/server";
import { readJson, serviceSupabase } from "../_util";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const { subscription_id, reason } = body ?? {};

    if (!subscription_id || !reason) {
      return NextResponse.json({ ok: false, error: "MISSING_FIELDS" }, { status: 400 });
    }

    const supabase = serviceSupabase();
    const { data, error } = await supabase.functions.invoke("billing-end-subscription", {
      body: { subscription_id, reason },
    });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json(data ?? { ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "UNKNOWN_FAILURE" },
      { status: 500 }
    );
  }
}
