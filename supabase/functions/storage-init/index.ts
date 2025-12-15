// supabase/functions/storage-init/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Simple JSON helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
// Read env vars
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}
// Service-role client (bypasses RLS, safe for backend function)
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
// Our standard Oasis minute book structure
const bucketName = "minute_book";
// Map entity slugs → storage codes
// If we ever add new entities, just extend this map.
const ENTITY_CODE_MAP = {
  holdings: "OIH",
  lounge: "OIL",
  realestate: "OIRE"
};
const folders = [
  "Incorporation",
  "ByLaws",
  "ShareCertificates",
  "ShareRegisters",
  "DirectorRegisters",
  "OfficerRegisters",
  "AnnualReturns",
  "Resolutions",
  "SpecialResolutions",
  "SupportingDocs",
  "GovernanceMemos",
  "ComplianceReviews",
  // ✅ AI + Ledger Generated
  "AI_Summaries",
  "AI_Advice",
  // ✅ Templates
  "Templates",
  // ✅ SYSTEM CERTIFICATES (PDF hash proofs, verification certs)
  "certificates"
];
serve(async (req)=>{
  if (req.method !== "POST") {
    return json({
      error: "Use POST"
    }, 405);
  }
  // 1) Load entities from the database
  const { data: entities, error: entityError } = await supabase.from("entities").select("id, slug, name").order("slug");
  if (entityError) {
    return json({
      ok: false,
      stage: "load_entities",
      message: entityError.message
    }, 500);
  }
  if (!entities || entities.length === 0) {
    return json({
      ok: false,
      stage: "load_entities",
      message: "No entities found in public.entities"
    }, 400);
  }
  const created = [];
  const skipped = [];
  const errors = [];
  // Small non-empty file so Supabase is happy
  const keepFile = new Blob([
    "keep"
  ], {
    type: "text/plain"
  });
  for (const entity of entities){
    // 2) Determine the storage code for this entity
    const corpCode = ENTITY_CODE_MAP[entity.slug] ?? entity.slug.toUpperCase();
    if (!corpCode) {
      skipped.push({
        slug: entity.slug,
        reason: "No storage code mapping"
      });
      continue;
    }
    // Ensure root .keep for the corp
    const rootPath = `${corpCode}/.keep`;
    {
      const { error } = await supabase.storage.from(bucketName).upload(rootPath, keepFile, {
        upsert: true,
        contentType: "text/plain"
      });
      if (error) {
        errors.push({
          path: rootPath,
          message: error.message
        });
      } else {
        created.push(rootPath);
      }
    }
    // Subfolders
    for (const folder of folders){
      const path = `${corpCode}/${folder}/.keep`;
      const { error } = await supabase.storage.from(bucketName).upload(path, keepFile, {
        upsert: true,
        contentType: "text/plain"
      });
      if (error) {
        errors.push({
          path,
          message: error.message
        });
      } else {
        created.push(path);
      }
    }
  }
  return json({
    ok: errors.length === 0,
    bucket: bucketName,
    createdCount: created.length,
    created,
    skipped,
    errors
  });
});
