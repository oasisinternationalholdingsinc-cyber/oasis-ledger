import { NextResponse } from "next/server";
import { readJson, serviceSupabase } from "../_util";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const supabase = serviceSupabase();

    // Call Edge export-billing-discovery-package
    const { data, error } = await supabase.functions.invoke("export-billing-discovery-package", {
      body,
    });

    // NOTE: supabase.functions.invoke expects JSON by default.
    // For binary ZIP, we must fetch the Edge endpoint directly.

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ ok: false, error: "MISSING_SUPABASE_URL" }, { status: 500 });
    }

    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-billing-discovery-package`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // service_role pass-through
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      },
      body: JSON.stringify(body ?? {}),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: "EXPORT_FAILED", details: errText || `HTTP_${resp.status}` },
        { status: 500 }
      );
    }

    const buf = await resp.arrayBuffer();
    const zip = new Uint8Array(buf);

    const hash = (body?.hash || "").toString().slice(0, 10) || "billing";
    const filename = `Oasis-Billing-Discovery-${hash}.zip`;

    return new Response(zip, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "UNKNOWN_FAILURE" },
      { status: 500 }
    );
  }
}
