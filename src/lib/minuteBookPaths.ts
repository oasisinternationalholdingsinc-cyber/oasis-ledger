// src/lib/minuteBookPaths.ts

/**
 * Oasis Minute Book Path Resolver
 *
 * Single source of truth for:
 *   (entitySlug, documentType, recordId) -> Storage path in `minute_book` bucket
 *
 * Use this in:
 *  - Edge functions (PDF engine, certificates, uploads)
 *  - React / Next.js (CI-Archive, CI-Forge, etc.)
 *
 * NO OTHER CODE should hand-build minute_book paths.
 */

export const MINUTE_BOOK_BUCKET = "minute_book" as const;

/**
 * Slugs as used in public.entities.slug
 */
export type EntitySlug = "holdings" | "lounge" | "real-estate" | string;

/**
 * Canonical minute-book document types.
 *
 * You can extend this over time, but keep folder mappings in sync below.
 */
export type MinuteBookDocumentType =
  | "resolution_draft"
  | "resolution_signed"
  | "resolution_pdf" // generic resolution file
  | "certificate"
  | "supporting_document"
  | "ai_summary"
  | "ai_advice"
  | "bylaw"
  | "annual_return"
  | "share_certificate"
  | "share_register"
  | "director_register"
  | "officer_register"
  | "governance_memo"
  | "compliance_review"
  | "template"
  | "incorporation_document";

/**
 * Storage root per entity (must match Storage + storage-init).
 */
const ENTITY_ROOT: Record<string, string> = {
  holdings: "Oasis International Holdings Inc",
  lounge: "Oasis International Lounge Inc",
  "real-estate": "Oasis International Real Estate Inc",
};

/**
 * Folder per document type (must match Storage folder names).
 */
const DOC_FOLDER: Record<MinuteBookDocumentType, string> = {
  resolution_draft: "Resolutions",
  resolution_signed: "Resolutions",
  resolution_pdf: "Resolutions",

  certificate: "Certificates",

  supporting_document: "SupportingDocs",

  ai_summary: "AI_Summaries",
  ai_advice: "AI_Advice",

  bylaw: "ByLaws",
  annual_return: "AnnualReturns",

  share_certificate: "ShareCertificates",
  share_register: "ShareRegisters",
  director_register: "DirectorRegisters",
  officer_register: "OfficerRegisters",

  governance_memo: "GovernanceMemos",
  compliance_review: "ComplianceReviews",

  template: "Templates",
  incorporation_document: "Incorporation",
};

/**
 * Result shape from the resolver.
 */
export type MinuteBookPathResult = {
  bucket: typeof MINUTE_BOOK_BUCKET;
  entitySlug: string;
  root: string; // e.g. "Oasis International Holdings Inc"
  documentType: MinuteBookDocumentType;
  folder: string; // e.g. "Resolutions"
  filename: string; // e.g. "<recordId>-certificate.pdf"
  storagePath: string; // e.g. "Oasis International Holdings Inc/Resolutions/<file>.pdf"
};

/**
 * Very simple slugifier for optional labels in filenames.
 */
function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compute a default filename based on type + recordId (+ optional label).
 */
function buildFilename(
  documentType: MinuteBookDocumentType,
  recordId: string,
  label?: string | null
): string {
  const safeId = recordId.trim();

  // Optional label becomes a suffix like "-board-approval"
  const suffix = label ? `-${slugifyLabel(label)}` : "";

  switch (documentType) {
    case "certificate":
      return `${safeId}-certificate${suffix}.pdf`;

    case "resolution_signed":
      return `${safeId}-signed-resolution${suffix}.pdf`;

    case "resolution_draft":
      return `${safeId}-draft-resolution${suffix}.pdf`;

    case "resolution_pdf":
      return `${safeId}-resolution${suffix}.pdf`;

    case "ai_summary":
      return `${safeId}-ai-summary${suffix}.pdf`;

    case "ai_advice":
      return `${safeId}-ai-advice${suffix}.pdf`;

    case "supporting_document":
      return `${safeId}-supporting-doc${suffix}.pdf`;

    case "bylaw":
      return `${safeId}-bylaw${suffix}.pdf`;

    case "annual_return":
      return `${safeId}-annual-return${suffix}.pdf`;

    case "share_certificate":
      return `${safeId}-share-certificate${suffix}.pdf`;

    case "share_register":
      return `${safeId}-share-register${suffix}.pdf`;

    case "director_register":
      return `${safeId}-director-register${suffix}.pdf`;

    case "officer_register":
      return `${safeId}-officer-register${suffix}.pdf`;

    case "governance_memo":
      return `${safeId}-governance-memo${suffix}.pdf`;

    case "compliance_review":
      return `${safeId}-compliance-review${suffix}.pdf`;

    case "template":
      return `${safeId}-template${suffix}.pdf`;

    case "incorporation_document":
      return `${safeId}-incorporation-doc${suffix}.pdf`;

    default:
      // Fallback, should rarely hit
      return `${safeId}${suffix}.pdf`;
  }
}

/**
 * Main resolver:
 *
 * Given (entitySlug, documentType, recordId) => return
 * { bucket, root, folder, filename, storagePath }
 */
export function getMinuteBookPath(options: {
  entitySlug: EntitySlug;
  documentType: MinuteBookDocumentType;
  recordId: string;
  label?: string | null; // optional human label to include in filename
  filenameOverride?: string; // if you want to provide full filename yourself
}): MinuteBookPathResult {
  const { entitySlug, documentType, recordId, label, filenameOverride } =
    options;

  const normalizedSlug = entitySlug.trim() as EntitySlug;

  const root =
    ENTITY_ROOT[normalizedSlug] ??
    ENTITY_ROOT[normalizedSlug.toLowerCase()] ??
    ENTITY_ROOT[normalizedSlug.replace(/[^a-z0-9\-]/gi, "").toLowerCase()];

  if (!root) {
    throw new Error(
      `getMinuteBookPath: Unknown entitySlug '${entitySlug}'. Add it to ENTITY_ROOT.`
    );
  }

  const folder = DOC_FOLDER[documentType];

  if (!folder) {
    throw new Error(
      `getMinuteBookPath: Unknown documentType '${documentType}'. Add it to DOC_FOLDER.`
    );
  }

  const filename =
    filenameOverride && filenameOverride.trim().length > 0
      ? filenameOverride.trim()
      : buildFilename(documentType, recordId, label);

  const storagePath = `${root}/${folder}/${filename}`;

  return {
    bucket: MINUTE_BOOK_BUCKET,
    entitySlug: normalizedSlug,
    root,
    documentType,
    folder,
    filename,
    storagePath,
  };
}

/**
 * Helper: quick check if a given path belongs to the minute book layout.
 */
export function isMinuteBookPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.includes("Oasis International ") && // cheap sanity check
    path.split("/").length >= 3 // root / folder / filename
  );
}
