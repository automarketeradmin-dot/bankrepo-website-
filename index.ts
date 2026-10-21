// BANK REPO CARS: "submit" function
// Saves customer enquiries and rent to own applications, then (for enquiries)
// returns the WhatsApp link. The website calls this; customers never write to
// the database directly.
//
// Deploy as a Supabase Edge Function named "submit" WITHOUT jwt verification:
//   supabase functions deploy submit --no-verify-jwt
// Secrets (Supabase > Edge Functions > Secrets):
//   WHATSAPP_NUMBER  e.g. 27821234567  (salesman's number, digits only, with country code)
//   ALLOWED_ORIGINS  optional, e.g. https://www.yourdomain.co.za  (comma separated)
//   IP_SALT          optional, any random text

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const WA = (Deno.env.get("WHATSAPP_NUMBER") || "").replace(/\D/g, "");
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
const SALT = Deno.env.get("IP_SALT") || "brc";
const PRIVACY_VERSION = "2026-10-v1";
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const BUDGETS = ["Under R50,000", "R50,000–R100,000", "R100,000–R200,000", "R200,000–R350,000", "R350,000 and above", "Still deciding"];
const PAYMENTS = ["Cash", "Rent to own", "Not sure yet"];
const DOCS: Record<string, [string, string, boolean][]> = {
  employed: [["bank", "Bank statements: last 3 months", true], ["payslip", "Payslips: last 3 months", true], ["license", "Driver's license", false], ["id", "ID or passport", false]],
  self: [["bank", "Bank statements: last 6 months", true], ["license", "Driver's license", false], ["id", "ID or passport", false]],
};
const EXPENSES = ["rent", "vehicle", "clothing", "utilities", "furniture", "policies", "groceries", "cellphone", "other"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const allow = ORIGINS.length ? (ORIGINS.includes(o) ? o : ORIGINS[0]) : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
const fail = (req: Request, msg: string, status = 400) => reply(req, { ok: false, error: msg }, status);

const clean = (v: unknown, max = 300) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const money = (n: number) => "R" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function normPhone(raw: string): string | null {
  const c = raw.replace(/[\s\-().]/g, "");
  if (/^(\+27|27|0)[1-9]\d{8}$/.test(c)) return "+27" + c.replace(/^(\+27|27|0)/, "");
  if (/^\+[1-9]\d{7,14}$/.test(c)) return c;
  return null;
}

async function ipHash(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",")[0].trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + ip));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
async function tooMany(table: "leads" | "applications", hash: string, limit: number) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb.from(table).select("id", { count: "exact", head: true }).eq("ip_hash", hash).gte("created_at", since);
  return (count ?? 0) >= limit;
}

async function getVehicle(stock: string) {
  const { data } = await sb.from("vehicles").select("*").ilike("stock_number", stock).eq("status", "published").maybeSingle();
  return data;
}
const titleOf = (v: any) => `${v.year} ${v.make} ${v.model}`;

// ---------------------------------------------------------------- enquiry
async function enquiry(req: Request, d: any) {
  if (clean(d.website)) return reply(req, { ok: true, whatsappUrl: null, message: "" }); // honeypot: pretend success
  const first = clean(d.first, 60), sur = clean(d.sur, 60), loc = clean(d.location, 80);
  const phone = normPhone(clean(d.phone, 30));
  if (first.length < 2 || sur.length < 2) return fail(req, "Please enter your name and surname.");
  if (!phone) return fail(req, "Please enter a valid phone number.");
  if (loc.length < 2) return fail(req, "Please enter your town or city.");
  if (!BUDGETS.includes(d.budget)) return fail(req, "Please choose a budget range.");
  if (!PAYMENTS.includes(d.payment)) return fail(req, "Please choose a payment method.");
  if (d.consent !== true) return fail(req, "Please accept the privacy notice.");

  const v = await getVehicle(clean(d.stock, 40));
  if (!v) return fail(req, "That vehicle is no longer available.", 404);

  const hash = await ipHash(req);
  if (await tooMany("leads", hash, 10)) return fail(req, "Too many enquiries from your connection. Please try again later.", 429);

  const { error } = await sb.from("leads").insert({
    first_name: first, surname: sur, phone, location: loc, budget: d.budget, payment: d.payment,
    vehicle_id: v.id, stock_number: v.stock_number, vehicle_title: titleOf(v), price: v.price,
    privacy_version: PRIVACY_VERSION, ip_hash: hash,
  });
  if (error) return fail(req, "We could not save your enquiry. Please try again.", 500);

  const message = [
    `Hi Bank Repo Cars, my name is ${first} ${sur}.`, "",
    "I am interested in the following vehicle:", "",
    `Vehicle: ${titleOf(v)}`, "",
    `Stock Number: ${v.stock_number}`, "",
    `Listed Price: ${money(Number(v.price))}`, "",
    `My Location: ${loc}`, "",
    `My Budget: ${d.budget}`, "",
    `Preferred Payment Method: ${d.payment}`, "",
    `My Contact Number: ${phone}`, "",
    "Please contact me regarding this vehicle.", "",
    "Thank you.",
  ].join("\n");
  const whatsappUrl = WA ? `https://wa.me/${WA}?text=${encodeURIComponent(message)}` : null;
  return reply(req, { ok: true, whatsappUrl, message });
}

// ------------------------------------------------------------ application
async function application(req: Request, form: FormData) {
  if (clean(form.get("website"))) return reply(req, { ok: true, ref: "A000000" });
  let d: any;
  try { d = JSON.parse(String(form.get("data") || "{}")); } catch { return fail(req, "Invalid form data."); }
  if (d.consent !== true) return fail(req, "Please accept the privacy notice.");

  const v = await getVehicle(clean(d.stock, 40));
  if (!v || !v.rto_enabled) return fail(req, "That vehicle is not available for rent to own.", 404);
  const term = Number(d.term);
  const monthly = term === 48 ? Number(v.rto_m48) : term === 54 ? Number(v.rto_m54) : NaN;
  if (!(monthly > 0)) return fail(req, "That payment period is not available for this vehicle.");

  const emp = d.emp === "self" ? "self" : d.emp === "employed" ? "employed" : "";
  if (!emp) return fail(req, "Please say whether you are employed or self-employed.");

  const a = d.f || {};
  const f: Record<string, unknown> = {
    first: clean(a.first, 60), sur: clean(a.sur, 60), phone: normPhone(clean(a.phone, 30)), email: clean(a.email, 120),
    married: a.married === "yes" ? "yes" : "no", mdate: a.married === "yes" ? clean(a.mdate, 20) : "",
    home: clean(a.home), nok: clean(a.nok, 100), nokAddr: clean(a.nokAddr), nokContact: clean(a.nokContact, 80),
    co: clean(a.co, 120), period: clean(a.period, 60), coAddr: clean(a.coAddr), coContact: clean(a.coContact, 80),
    bank: clean(a.bank, 60), acc: clean(a.acc, 20).replace(/\s/g, ""),
    gross: num(a.gross), net: num(a.net),
    bond: a.bond === "yes" ? "yes" : "no", bondBank: a.bond === "yes" ? clean(a.bondBank, 60) : "",
    bondInst: a.bond === "yes" ? num(a.bondInst) : "",
  };
  const x: Record<string, number> = {};
  for (const k of EXPENSES) { const n = num(a.x?.[k] ?? 0); x[k] = Number.isFinite(n) && n >= 0 ? n : NaN; }
  f.x = x;

  if ((f.first as string).length < 2 || (f.sur as string).length < 2) return fail(req, "Please enter your name and surname.");
  if (!f.phone) return fail(req, "Please enter a valid phone number.");
  if (!emailOk(f.email as string)) return fail(req, "Please enter a valid email address.");
  if (f.married === "yes" && !f.mdate) return fail(req, "Please enter the date you were married.");
  if ((f.home as string).length < 5) return fail(req, "Please enter your home address.");
  if ((f.nok as string).length < 2 || (f.nokAddr as string).length < 5 || (f.nokContact as string).length < 5) return fail(req, "Please complete the next of kin details.");
  if ((f.co as string).length < 2 || !(f.period as string) || (f.coAddr as string).length < 5 || (f.coContact as string).length < 5) return fail(req, "Please complete the work details.");
  if ((f.bank as string).length < 2 || !/^\d{5,16}$/.test(f.acc as string)) return fail(req, "Please enter your bank and account number.");
  if (!(f.gross as number >= 0) || !(f.net as number >= 0)) return fail(req, "Please enter your gross and net income.");
  if (f.bond === "yes" && ((f.bondBank as string).length < 2 || !(f.bondInst as number >= 0))) return fail(req, "Please complete the bond details.");
  if (EXPENSES.some((k) => Number.isNaN(x[k]))) return fail(req, "Please enter your expenses (0 if none).");

  // Documents
  const files: { key: string; label: string; file: File }[] = [];
  for (const [key, label, many] of DOCS[emp]) {
    const list = form.getAll(`doc_${key}`).filter((e): e is File => e instanceof File && e.size > 0);
    if (!list.length) return fail(req, `Please attach: ${label}.`);
    if (!many && list.length > 1) return fail(req, `Please attach only one file for: ${label}.`);
    if (list.length > 6) return fail(req, `Too many files for: ${label}.`);
    for (const file of list) {
      if (!FILE_TYPES.includes(file.type)) return fail(req, `${label}: only PDF, JPG, PNG or WEBP files are accepted.`);
      if (file.size > MAX_FILE) return fail(req, `${label}: each file must be under 10 MB.`);
      files.push({ key, label, file });
    }
  }

  const hash = await ipHash(req);
  if (await tooMany("applications", hash, 3)) return fail(req, "Too many applications from your connection. Please try again later.", 429);

  const ref = "A" + crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  const { data: app, error } = await sb.from("applications").insert({
    ref, vehicle_id: v.id, stock_number: v.stock_number, vehicle_title: titleOf(v), price: v.price,
    deposit: v.rto_deposit, term_months: term, monthly, employment: emp, answers: f,
    privacy_version: PRIVACY_VERSION, ip_hash: hash,
  }).select("id").single();
  if (error || !app) return fail(req, "We could not save your application. Please try again.", 500);

  const rows: { application_id: string; label: string; path: string; position: number }[] = [];
  let i = 0;
  for (const { key, label, file } of files) {
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-60) || "file";
    const path = `${app.id}/${key}-${i}-${safe}`;
    const up = await sb.storage.from("application-documents").upload(path, file, { contentType: file.type });
    if (up.error) {
      await sb.storage.from("application-documents").remove(rows.map((r) => r.path));
      await sb.from("applications").delete().eq("id", app.id);
      return fail(req, "We could not upload your documents. Please try again.", 500);
    }
    rows.push({ application_id: app.id, label, path, position: i });
    i++;
  }
  const ins = await sb.from("application_documents").insert(rows);
  if (ins.error) {
    await sb.storage.from("application-documents").remove(rows.map((r) => r.path));
    await sb.from("applications").delete().eq("id", app.id);
    return fail(req, "We could not save your documents. Please try again.", 500);
  }
  return reply(req, { ok: true, ref });
}

// ------------------------------------------------------------------ entry
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return fail(req, "Method not allowed.", 405);
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("multipart/form-data")) return await application(req, await req.formData());
    const d = await req.json();
    if (d?.type === "enquiry") return await enquiry(req, d);
    return fail(req, "Unknown request.");
  } catch (_e) {
    return fail(req, "Something went wrong. Please try again.", 500);
  }
});
