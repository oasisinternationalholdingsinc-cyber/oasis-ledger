import { NextResponse } from "next/server";
import { readJson, serviceSupabase } from "../_util";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const { entity_id, is_test = false } = body ?? {};

    if (!entity_id) {
      return NextResponse.json({ ok: false, error: "MISSING_ENTITY" }, { status: 400 });
    }

    const supabase = serviceSupabase();
    const { data, error } = await supabase.functions.invoke("axiom-billing-snapshot", {
      body: { entity_id, is_test },
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
