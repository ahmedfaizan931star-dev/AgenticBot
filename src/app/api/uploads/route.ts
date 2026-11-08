import { cleanFileName, extractFromBuffer, MAX_UPLOAD_BYTES } from "@/lib/files/extract";
import { err, guard } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILES_PER_USER = 200;

export async function POST(request: Request) {
  const g = await guard(request, { write: true, bucket: "upload", limit: 10, windowSeconds: 60 });
  if (g.response) return g.response;

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) return err(413, "too_large", "Files can be up to 4 MB.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "bad_request", "Invalid upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return err(400, "bad_request", "No file received.");
  if (file.size > MAX_UPLOAD_BYTES) return err(413, "too_large", "Files can be up to 4 MB.");

  const db = createAdminClient();
  const { count } = await db.from("files").select("id", { count: "exact", head: true }).eq("user_id", g.user.id);
  if ((count ?? 0) >= MAX_FILES_PER_USER) return err(409, "limit", "You have reached the file limit. Delete some files first.");

  const name = cleanFileName(file.name);
  const out = await extractFromBuffer(name, new Uint8Array(await file.arrayBuffer()));
  if (!out.ok) return err(422, "unreadable", out.reason);

  const { data, error } = await db
    .from("files")
    .insert({ user_id: g.user.id, name, mime: out.mime, bytes: file.size, text_content: out.text, chars: out.text.length })
    .select("id")
    .single();
  if (error || !data) return err(500, "server", "Could not save the file.");
  return Response.json({ id: data.id, name, chars: out.text.length });
}
