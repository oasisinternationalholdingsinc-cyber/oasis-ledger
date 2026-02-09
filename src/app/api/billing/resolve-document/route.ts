import { NextResponse } from "next/server";
import { readJson, serviceSupabase } from "../_util";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const supabase = serviceSupabase();

    // Your Edge Function name is resolve-billing-document
    const { data, error } = await supabase.functions.invoke("resolve-billing-document", {
      body,
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
