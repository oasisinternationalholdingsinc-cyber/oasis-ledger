// supabase/functions/delete-minute-book-entry/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function errMessage(e: unknown, fallback = "Unexpected error") {
  if (e instanceof Error) return e.message || fallback;
  return String(e || fallback);
}

function uniqPaths(xs: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      xs
        .map((x) => String(x || "").trim())
        .filter(Boolean),
    ),
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const requestId = crypto.randomUUID();

  try {
    if (req.method !== "POST") {
      return json(405, {
        ok: false,
        error: "Method not allowed",
        request_id: requestId,
      });
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(401, {
        ok: false,
        error: "Missing Authorization Bearer token",
        request_id: requestId,
      });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return json(401, {
        ok: false,
        error: "Empty bearer token",
        request_id: requestId,
      });
    }

    const body = await req.json().catch(() => ({}));
    const entryId = String(body?.entry_id || "").trim();
    const reason =
      body?.reason == null ? null : String(body.reason || "").trim() || null;

    if (!entryId) {
      return json(400, {
        ok: false,
        error: "Missing entry_id",
        request_id: requestId,
      });
    }

    // User-scoped client: validate operator + call DB-only RPC under user context
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // Service-role client: storage + protected reads/writes
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser(token);

    if (userErr || !user) {
      return json(401, {
        ok: false,
        error: userErr?.message || "Invalid session",
        request_id: requestId,
      });
    }

    // Load entry
    const { data: entry, error: entryErr } = await serviceClient
      .from("minute_book_entries")
      .select("id, entity_key, title, storage_path, source, source_record_id")
      .eq("id", entryId)
      .maybeSingle();

    if (entryErr) {
      return json(500, {
        ok: false,
        error: entryErr.message,
        request_id: requestId,
      });
    }

    if (!entry) {
      return json(404, {
        ok: false,
        error: "Minute Book entry not found",
        request_id: requestId,
      });
    }

    // Load linked docs
    const { data: docs, error: docsErr } = await serviceClient
      .from("supporting_documents")
      .select("id, file_path, thumbnail_path, file_name")
      .eq("entry_id", entryId);

    if (docsErr) {
      return json(500, {
        ok: false,
        error: docsErr.message,
        request_id: requestId,
      });
    }

    // Collect paths from both minute_book_entries.storage_path and supporting_documents
    const storagePaths = uniqPaths([
      entry.storage_path,
      ...(docs || []).flatMap((d: any) => [d.file_path, d.thumbnail_path]),
    ]);

    const bucket = "minute_book";

    let removedCount = 0;
    let removedPaths: string[] = [];
    let storageWarning: string | null = null;

    if (storagePaths.length > 0) {
      const { data: removed, error: removeErr } = await serviceClient.storage
        .from(bucket)
        .remove(storagePaths);

      // Be tolerant of stale paths. Missing objects should not block row cleanup.
      if (removeErr) {
        const msg = removeErr.message || "";
        const looksMissing =
          /not[\s-]*found/i.test(msg) ||
          /no such object/i.test(msg) ||
          /The resource was not found/i.test(msg);

        if (!looksMissing) {
          return json(500, {
            ok: false,
            error: `Storage remove failed: ${msg}`,
            request_id: requestId,
            bucket,
            paths_attempted: storagePaths,
          });
        }

        storageWarning = msg;
      } else {
        removedPaths = Array.isArray(removed)
          ? removed
              .map((r: any) => String(r?.name || "").trim())
              .filter(Boolean)
          : [];
        removedCount = removedPaths.length;
      }
    }

    // Call DB-only cleanup RPC under user context so auth.uid() works there
    const { data: rpcData, error: rpcErr } = await userClient.rpc(
      "delete_minute_book_entry_rows_only",
      {
        p_entry_id: entryId,
        p_reason: reason,
      },
    );

    if (rpcErr) {
      return json(500, {
        ok: false,
        error: rpcErr.message,
        request_id: requestId,
        storage_removed_count: removedCount,
        storage_removed_paths: removedPaths,
        storage_warning: storageWarning,
      });
    }

    const rpcRes = (rpcData ?? {}) as Record<string, unknown>;
    if (!rpcRes?.ok) {
      return json(500, {
        ok: false,
        error: "DB cleanup RPC returned no ok=true",
        request_id: requestId,
        rpc_result: rpcRes,
        storage_removed_count: removedCount,
        storage_removed_paths: removedPaths,
        storage_warning: storageWarning,
      });
    }

    // Audit log (best-effort; do not fail the delete if audit insert has an issue)
    try {
      await serviceClient.from("audit_log").insert({
        actor: user.id,
        action: "minute_book_entry_deleted",
        entity_type: "minute_book_entries",
        entity_id: entryId,
        metadata: {
          request_id: requestId,
          reason,
          bucket,
          entity_key: entry.entity_key,
          title: entry.title,
          source: entry.source,
          source_record_id: entry.source_record_id,
          storage_paths_attempted: storagePaths,
          storage_removed_count: removedCount,
          storage_removed_paths: removedPaths,
          storage_warning: storageWarning,
        },
      });
    } catch {
      // best-effort only
    }

    return json(200, {
      ok: true,
      request_id: requestId,
      entry_id: entryId,
      entity_key: entry.entity_key,
      title: entry.title,
      bucket,
      deleted_storage_objects: removedCount,
      deleted_storage_paths: removedPaths,
      deleted_entry_rows: rpcRes.deleted_entry_rows ?? null,
      deleted_supporting_rows: rpcRes.deleted_supporting_rows ?? null,
      reason,
      storage_warning: storageWarning,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: errMessage(e),
      request_id: requestId,
    });
  }
});