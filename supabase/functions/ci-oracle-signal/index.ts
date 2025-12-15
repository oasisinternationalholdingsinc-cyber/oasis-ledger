// supabase/functions/ci-oracle-signal/index.ts
//
// CI-ORACLE SIGNAL FUNCTION
// -------------------------
// Purpose:
//   - Let any module (FORGE, ALCHEMY, SENTINEL, ORACLE UI, etc.) update
//     the single ci_orb_state row.
//   - Optionally trigger an "alert" flag.
//   - Allow GET to read current state, POST to update it.
//
// Request (POST JSON):
//   {
//     "mode": "nur" | "ruh",        // optional
//     "source": "alchemy" | "forge" | "sentinel" | "oracle-ui" | string,
//     "activity": "Drafting resolution for OIH",  // optional
//     "alert": true | false         // optional – for Sentinel pulse
//   }
//
// Response JSON:
//   { ok: true, state: { ...ci_orb_state row }, applied: { ... } }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("[ci-oracle-signal] Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

type OrbMode = "nur" | "ruh";

serve(async (req: Request): Promise<Response> => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("ci_orb_state")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("[ci-oracle-signal] GET error", error);
        return json({ ok: false, error: error.message }, 500);
      }

      if (!data) {
        return json(
          {
            ok: false,
            error: "No ci_orb_state row found. Did you seed it?",
          },
          404,
        );
      }

      return json({ ok: true, state: data });
    }

    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        mode?: OrbMode | null;
        source?: string | null;
        activity?: string | null;
        alert?: boolean | null;
      };

      const rawMode = body.mode ?? null;
      const source = (body.source ?? "system") as string;
      const activity = (body.activity ?? null) as string | null;
      const alert = Boolean(body.alert ?? false);

      let mode: OrbMode | null = null;
      if (rawMode !== null) {
        if (rawMode !== "nur" && rawMode !== "ruh") {
          return json(
            {
              ok: false,
              error: 'Invalid mode. Allowed values: "nur" | "ruh".',
            },
            400,
          );
        }
        mode = rawMode;
      }

      const { data: current, error: fetchError } = await supabase
        .from("ci_orb_state")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchError) {
        console.error("[ci-oracle-signal] fetch current error", fetchError);
        return json({ ok: false, error: fetchError.message }, 500);
      }

      if (!current) {
        return json(
          {
            ok: false,
            error: "No ci_orb_state row found. Did you seed it?",
          },
          404,
        );
      }

      const updates: Record<string, unknown> = {};
      if (mode !== null) updates.mode = mode;
      if (source) updates.source = source;
      if (activity !== null) updates.activity = activity;
      if (typeof alert === "boolean") updates.alert = alert;

      let updatedState = current;

      if (Object.keys(updates).length > 0) {
        const { data, error: updateError } = await supabase
          .from("ci_orb_state")
          .update(updates)
          .eq("id", current.id)
          .select("*")
          .single();

        if (updateError) {
          console.error("[ci-oracle-signal] update error", updateError);
          return json({ ok: false, error: updateError.message }, 500);
        }

        updatedState = data;
      }

      // Later we can also insert into ci_orb_events from here if you want

      return json({
        ok: true,
        state: updatedState,
        applied: {
          mode: mode ?? updatedState.mode,
          source,
          activity,
          alert,
        },
      });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("[ci-oracle-signal] unhandled error", err);
    return json({ ok: false, error: "Internal error" }, 500);
  }
});
