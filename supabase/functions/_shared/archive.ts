// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export type ArchiveLane = "rot" | "sandbox";

export type SealResult = {
  ok: boolean;
  ledger_id: string;
  entity_id: string;
  entity_key: string; // entities.slug casted to entity_key_enum
  is_test: boolean;

  // Verified artifact (the one portals should verify)
  storage_bucket: string;
  storage_path: string;
  file_hash: string;

  verified_document_id?: string;
  status?: string;
};

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export function json(x: unknown, status = 200) {
  return new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Extract caller uid (preferred) from Authorization: Bearer <user_jwt>
export function getCallerUid(req: Request): string | null {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;

  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function getLane(is_test?: boolean): ArchiveLane {
  return is_test ? "sandbox" : "rot";
}

export function minuteBookPrimaryPath(entityKey: string, section: string, ledgerId: string, suffix = "") {
  // keep your existing convention: holdings/Resolutions/<ledgerId>-signed.pdf, etc.
  // NOTE: section values are doc_section_enum labels (case-sensitive in UI list, but stored as enum)
  // Your existing storage uses "Resolutions" (capital R). Keep it consistent.
  const safeSection = section; // expected e.g. "Resolutions"
  return `${entityKey}/${safeSection}/${ledgerId}${suffix}.pdf`;
}

export function fileNameFromPath(p: string) {
  const ix = p.lastIndexOf("/");
  return ix >= 0 ? p.slice(ix + 1) : p;
}

export function makeServiceClient() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch },
    auth: { persistSession: false },
  });
}

// Map governance record_type -> doc_section_enum (match your enum labels list)
export function mapRecordTypeToSection(recordType: string | null): string {
  const rt = (recordType ?? "").toLowerCase();
  if (rt.includes("resolution")) return "Resolutions";
  if (rt.includes("bylaw")) return "Bylaws";
  if (rt.includes("register")) return "Registers";
  if (rt.includes("share")) return "ShareCertificates";
  return "Resolutions";
}
