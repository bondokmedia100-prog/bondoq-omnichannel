"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookUser, Mail, MessageCircle, Pencil, Phone, Plus, Save, Search, Star, Tag, Trash2, Users, X } from "lucide-react";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { parseContactsFile } from "@/lib/contactsImport";
import { normalizePhoneNumber } from "@/lib/egyptianPhoneFormatter";
import CrmThemeToggle from "./CrmThemeToggle";

type Row = Record<string, any>;
type Profile = { role: string; canManageCatalog?: boolean | null; canManageTeam?: boolean | null };

function contactPhoneLink(value: string | null | undefined, channel: "call" | "whatsapp") {
  if (!value) return null;
  try {
    const number = normalizePhoneNumber(value);
    return channel === "call" ? `tel:+${number}` : `https://wa.me/${number}`;
  } catch { return null; }
}

export default function CrmContactsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<"customers" | "directory">("customers");
  const [customers, setCustomers] = useState<Row[]>([]);
  const [customerCount, setCustomerCount] = useState(0);
  const [favoriteCustomerIds, setFavoriteCustomerIds] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [tags, setTags] = useState<Row[]>([]);
  const [directory, setDirectory] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ displayName: "", phone: "", email: "", notes: "" });
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#2563eb");
  const [editingTagId, setEditingTagId] = useState("");
  const [tagDraft, setTagDraft] = useState({ name: "", color: "#2563eb" });
  const [categoryName, setCategoryName] = useState("");
  const [categoryIdToDelete, setCategoryIdToDelete] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [editingEntryId, setEditingEntryId] = useState("");
  const [entryDraft, setEntryDraft] = useState({ categoryId: "", name: "", phone: "", whatsappNumber: "", email: "", description: "" });
  const [entry, setEntry] = useState({ categoryId: "", name: "", phone: "", whatsappNumber: "", email: "", description: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importAnyInput = useRef<HTMLInputElement>(null);
  const canManageCatalog = profile?.role === "ADMIN" || profile?.role === "SUPERVISOR" && profile.canManageCatalog !== false;
  const canManageTeam = profile?.role === "ADMIN" || profile?.role === "SUPERVISOR" && profile.canManageTeam !== false;

  async function loadCustomers(search = query, onlyFavorites = favoritesOnly) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (onlyFavorites) params.set("favoritesOnly", "true");
    const result = await api<{ customers: Row[]; total: number }>(`/api/customers?${params}`);
    setCustomers(result.customers); setCustomerCount(result.total);
  }
  async function loadDirectory() { setDirectory(await api<Row[]>(canManageCatalog ? "/api/admin/directory" : "/api/directory")); }
  async function bootstrap() {
    const user = await api<Profile>("/api/auth/me");
    setProfile(user);
    const manageCatalog = user.role === "ADMIN" || user.role === "SUPERVISOR" && user.canManageCatalog !== false;
    const [customerResult, tagResult, directoryResult, favorites] = await Promise.all([
      api<{ customers: Row[]; total: number }>("/api/customers"), api<Row[]>(manageCatalog ? "/api/admin/customer-tags" : "/api/customer-tags"), api<Row[]>(manageCatalog ? "/api/admin/directory" : "/api/directory"), api<{ ids: string[] }>("/api/customers/favorites")
    ]);
    setCustomers(customerResult.customers); setCustomerCount(customerResult.total); setFavoriteCustomerIds(favorites.ids || []); setTags(tagResult); setDirectory(directoryResult);
  }

  useEffect(() => {
    if (!getToken()) { router.replace("/login"); return; }
    let current = true;
    bootstrap().catch((error) => {
      if (!current) return;
      if (error instanceof ApiError && error.status === 401) { localStorage.removeItem("bondoq_token"); router.replace("/login"); }
      else setNotice(error instanceof Error ? error.message : "تعذر تحميل بيانات CRM");
    });
    return () => { current = false; };
  }, [router]);

  async function selectCustomer(customer: Row) {
    setNotice("");
    try {
      const detail = await api<Row>(`/api/customers/${customer.id}`);
      setSelected(detail);
      setForm({ displayName: detail.displayName || detail.name || "", phone: detail.phone || "", email: detail.email || "", notes: detail.notes || "" });
      setSelectedTagIds((detail.tags || []).map((item: Row) => item.tagId));
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر فتح ملف العميل"); }
  }

  async function toggleCustomerFavorite() {
    if (!selected || busy) return;
    const favorite = !favoriteCustomerIds.includes(selected.id);
    try {
      await api(`/api/customers/${selected.id}/favorite`, { method: "PUT", body: JSON.stringify({ favorite }) });
      setFavoriteCustomerIds((current) => favorite ? [...new Set([...current, selected.id])] : current.filter((id) => id !== selected.id));
      if (favoritesOnly && !favorite) await loadCustomers(query, true);
      setNotice(favorite ? "تم حفظ العميل في المفضلة." : "تمت إزالة العميل من المفضلة.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث مفضلة العميل"); }
  }

  async function saveCustomer(event: FormEvent) {
    event.preventDefault(); if (!selected || busy) return;
    setBusy(true); setNotice("");
    try {
      await api(`/api/customers/${selected.id}`, { method: "PATCH", body: JSON.stringify({ displayName: form.displayName || null, phone: form.phone || null, email: form.email || null, notes: form.notes || null }) });
      await api(`/api/customers/${selected.id}/tags`, { method: "PUT", body: JSON.stringify({ tagIds: selectedTagIds }) });
      await loadCustomers();
      await selectCustomer({ ...selected, displayName: form.displayName });
      setNotice("تم حفظ بيانات العميل والوسوم.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حفظ بيانات العميل"); }
    finally { setBusy(false); }
  }

  async function createTag(event: FormEvent) {
    event.preventDefault(); if (!tagName.trim()) return;
    try { const tag = await api<Row>("/api/admin/customer-tags", { method: "POST", body: JSON.stringify({ name: tagName, color: tagColor }) }); setTags((old) => [...old, tag].sort((a, b) => a.name.localeCompare(b.name))); setTagName(""); setNotice("تم إنشاء الوسم."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إنشاء الوسم"); }
  }

  async function saveTag(event: FormEvent) {
    event.preventDefault(); if (!editingTagId || !tagDraft.name.trim()) return;
    try {
      const updated = await api<Row>(`/api/admin/customer-tags/${editingTagId}`, { method: "PATCH", body: JSON.stringify(tagDraft) });
      setTags((old) => old.map((tag) => tag.id === updated.id ? { ...tag, ...updated } : tag).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingTagId(""); setNotice("تم تحديث الوسم.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث الوسم"); }
  }

  async function deleteTag(tag: Row) {
    if (!window.confirm(`حذف الوسم «${tag.name}»؟ ستُزال علاقته بملفات العملاء.`)) return;
    try {
      await api(`/api/admin/customer-tags/${tag.id}`, { method: "DELETE" });
      setTags((old) => old.filter((item) => item.id !== tag.id)); setSelectedTagIds((old) => old.filter((id) => id !== tag.id)); setNotice("تم حذف الوسم.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف الوسم"); }
  }

  async function createCategory(event: FormEvent) {
    event.preventDefault(); if (!categoryName.trim()) return;
    try { const category = await api<Row>("/api/admin/directory/categories", { method: "POST", body: JSON.stringify({ name: categoryName }) }); setDirectory((old) => [...old, { ...category, entries: [] }]); setEntry((old) => ({ ...old, categoryId: category.id })); setCategoryName(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذر إنشاء القسم"); }
  }

  async function updateCategory(category: Row, changes: Row) {
    try {
      await api(`/api/admin/directory/categories/${category.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await loadDirectory(); setNotice(changes.isActive === undefined ? "تم تحديث القسم." : changes.isActive ? "تم إظهار القسم." : "تم إخفاء القسم.");
      setEditingCategoryId("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث القسم"); }
  }

  async function deleteCategory(category: Row) {
    const count = category.entries?.length || 0;
    const contents = count ? ` وسيُحذف معها ${count} من جهات الاتصال الموجودة فيها.` : "";
    if (!window.confirm(`حذف القسم «${category.name}» نهائيًا؟${contents}`)) return;
    try {
      await api(`/api/admin/directory/categories/${category.id}`, { method: "DELETE" });
      setDirectory((old) => old.filter((item) => item.id !== category.id));
      setCategoryIdToDelete("");
      setEntry((old) => old.categoryId === category.id ? { ...old, categoryId: "" } : old);
      setNotice("تم حذف القسم وجهات الاتصال التابعة له.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر حذف القسم"); }
  }

  async function createEntry(event: FormEvent) {
    event.preventDefault(); if (!entry.categoryId || !entry.name.trim()) return;
    try { await api("/api/admin/directory/entries", { method: "POST", body: JSON.stringify({ ...entry, phone: entry.phone || null, whatsappNumber: entry.whatsappNumber || null, email: entry.email || null, description: entry.description || null }) }); setEntry((old) => ({ ...old, name: "", phone: "", whatsappNumber: "", email: "", description: "" })); await loadDirectory(); setNotice("تمت إضافة جهة الاتصال إلى الدليل."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "تعذرت إضافة جهة الاتصال"); }
  }

  async function saveDirectoryEntry(event: FormEvent) {
    event.preventDefault(); if (!editingEntryId || !entryDraft.categoryId || !entryDraft.name.trim()) return;
    try {
      await api(`/api/admin/directory/entries/${editingEntryId}`, { method: "PATCH", body: JSON.stringify({ ...entryDraft, phone: entryDraft.phone || null, whatsappNumber: entryDraft.whatsappNumber || null, email: entryDraft.email || null, description: entryDraft.description || null }) });
      await loadDirectory(); setEditingEntryId(""); setNotice("تم تحديث جهة الاتصال.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث جهة الاتصال"); }
  }

  async function toggleDirectoryEntry(item: Row) {
    try {
      await api(`/api/admin/directory/entries/${item.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !item.isActive }) });
      await loadDirectory(); setNotice(item.isActive ? "تم إخفاء جهة الاتصال." : "تم إظهار جهة الاتصال.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تحديث ظهور جهة الاتصال"); }
  }

  async function exportCustomers() {
    try {
      const response = await fetch(`${API_URL}/api/admin/customers/export.csv`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) throw new Error("تعذر تصدير جهات الاتصال");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = "contacts.csv"; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر تصدير جهات الاتصال"); }
  }

  async function importCustomers(file?: File) {
    if (!file) return;
    setBusy(true); setNotice("");
    try {
      const rows = await parseContactsFile(file);
      if (!rows.length) throw new Error("لم نعثر على جهات اتصال داخل الملف");
      const result = await api<{ created: number; updated: number }>("/api/admin/customers/import", { method: "POST", body: JSON.stringify({ customers: rows }) });
      await loadCustomers();
      setNotice(`اكتمل الاستيراد: ${result.created} جديد، ${result.updated} تم تحديثه.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "تعذر استيراد الملف"); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ""; }
  }

  const inputClass = "h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm outline-none focus:border-amber-400";
  return <main dir="rtl" className="min-h-screen bg-[#f7f5f1] p-4 text-stone-800 sm:p-7">
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><button onClick={() => router.back()} aria-label="رجوع" className="grid h-10 w-10 place-items-center rounded-xl bg-white text-stone-500 shadow-sm"><ArrowRight size={18} /></button><div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#d32f2f] text-white"><Users size={20} /></div><div><p className="text-xs font-bold text-[#b88718]">مركز خدمة العملاء - CRM</p><h1 className="text-xl font-extrabold">العملاء ودليل الشركة</h1></div></div><div className="flex items-center gap-2"><span className="rounded-full bg-white px-4 py-2 text-xs font-bold text-stone-500">{profile ? "متصل" : "جارٍ التحميل"}</span><CrmThemeToggle /></div></header>
      {notice && <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice}</div>}
      <nav className="mb-4 flex gap-2"><button onClick={() => setTab("customers")} className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold ${tab === "customers" ? "bg-[#d32f2f] text-white" : "bg-white text-stone-500"}`}><Users size={16} /> العملاء <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs">{customerCount}</span></button><button onClick={() => setTab("directory")} className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold ${tab === "directory" ? "bg-[#d32f2f] text-white" : "bg-white text-stone-500"}`}><BookUser size={16} /> دليل الشركة</button></nav>
      {tab === "customers" ? <section className="grid min-h-[70vh] gap-4 lg:grid-cols-[minmax(0,1fr)_390px]">
        <div className="flex flex-wrap justify-start gap-2 lg:col-span-2"><button type="button" aria-pressed={favoritesOnly} onClick={() => { const next = !favoritesOnly; setFavoritesOnly(next); void loadCustomers(query, next); }} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold ${favoritesOnly ? "bg-amber-500 text-white" : "bg-white text-stone-600"}`}><Star size={15} fill={favoritesOnly ? "currentColor" : "none"} />{favoritesOnly ? "عرض كل العملاء" : `العملاء المفضلون (${favoriteCustomerIds.length})`}</button>{canManageTeam && <><input ref={importAnyInput} type="file" accept=".csv,.xlsx,.xls,.vcf,.vcard,text/csv" className="hidden" onChange={(event) => void importCustomers(event.target.files?.[0])} /><button type="button" disabled={busy} onClick={() => importAnyInput.current?.click()} className="rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-xs font-bold text-stone-600 disabled:opacity-50">استيراد CSV / Excel / VCF</button></>}</div>
        <div className="panel min-h-0 overflow-hidden"><form onSubmit={(event) => { event.preventDefault(); void loadCustomers(); }} className="flex gap-2 border-b border-stone-100 p-4"><label className="flex h-11 flex-1 items-center gap-2 rounded-xl bg-stone-50 px-3"><Search size={16} className="text-stone-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث بالاسم أو الهاتف أو البريد" className="w-full bg-transparent text-sm outline-none" /></label><button className="rounded-xl bg-stone-800 px-4 text-xs font-bold text-white">بحث</button></form>{canManageTeam && <div className="flex flex-wrap items-center justify-end gap-2 border-b border-stone-100 px-4 py-2"><input ref={importInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => void importCustomers(event.target.files?.[0])} /><button disabled={busy} onClick={() => importInput.current?.click()} className="rounded-lg border border-stone-200 px-3 py-2 text-[10px] font-bold text-stone-600 disabled:opacity-50">استيراد CSV</button><button onClick={() => void exportCustomers()} className="rounded-lg bg-[#fff8e9] px-3 py-2 text-[10px] font-bold text-[#8c650a]">تصدير CSV</button><span className="w-full text-left text-[9px] text-stone-400">الأعمدة: displayName, phone, email, notes</span></div>}<div className="max-h-[66vh] divide-y divide-stone-100 overflow-y-auto">{customers.map((customer) => <button key={customer.id} onClick={() => void selectCustomer(customer)} className={`flex w-full items-center gap-3 px-4 py-3 text-right hover:bg-[#fffaf2] ${selected?.id === customer.id ? "bg-[#fff6e4]" : "bg-white"}`}><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#fff0d1] font-bold text-[#9c6920]">{(customer.displayName || customer.name || "ع")[0]}</span><span className="min-w-0 flex-1"><b className="block truncate text-sm">{customer.displayName || customer.name || "عميل جديد"}</b><span className="mt-1 block truncate text-xs text-stone-400">{customer.phone || customer.email || "لا توجد بيانات اتصال"}</span><span className="mt-1 flex flex-wrap gap-1">{customer.tags?.map((item: Row) => <i key={item.tagId} className="rounded-full px-2 py-0.5 text-[9px] not-italic" style={{ backgroundColor: `${item.tag.color}20`, color: item.tag.color }}>{item.tag.name}</i>)}</span></span></button>)}{!customers.length && <p className="p-10 text-center text-sm text-stone-400">لا توجد جهات اتصال مطابقة.</p>}</div></div>
        <aside className="panel soft-scroll max-h-[78vh] overflow-y-auto p-4">
          {selected && <div className="mb-3 flex justify-end"><button type="button" onClick={() => void toggleCustomerFavorite()} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${favoriteCustomerIds.includes(selected.id) ? "bg-amber-50 text-amber-700" : "bg-stone-50 text-stone-500"}`}><Star size={14} fill={favoriteCustomerIds.includes(selected.id) ? "currentColor" : "none"} />{favoriteCustomerIds.includes(selected.id) ? "إزالة من المفضلة" : "حفظ في المفضلة"}</button></div>}
          {selected ? <form onSubmit={saveCustomer} className="space-y-3"><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">ملف العميل</h2><span className="text-[10px] text-stone-400">{selected.conversations?.length || 0} محادثة</span></div><label className="block text-xs font-bold text-stone-500">الاسم<input className={`${inputClass} mt-1`} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} maxLength={120} /></label><label className="block text-xs font-bold text-stone-500">الهاتف<input className={`${inputClass} mt-1`} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} dir="ltr" maxLength={32} /></label><label className="block text-xs font-bold text-stone-500">البريد الإلكتروني<input className={`${inputClass} mt-1`} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} maxLength={254} dir="ltr" /></label><label className="block text-xs font-bold text-stone-500">ملاحظات داخلية<textarea className="mt-1 w-full rounded-xl border border-stone-200 p-3 text-sm outline-none focus:border-amber-400" rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} maxLength={4000} /></label>
            {!!tags.length && <fieldset><legend className="mb-2 text-xs font-bold text-stone-500">وسوم العميل</legend><div className="flex flex-wrap gap-2">{tags.map((tag) => <label key={tag.id} className="flex items-center gap-1.5 rounded-full border border-stone-100 px-2.5 py-1.5 text-xs"><input type="checkbox" checked={selectedTagIds.includes(tag.id)} onChange={(event) => setSelectedTagIds((old) => event.target.checked ? [...old, tag.id] : old.filter((id) => id !== tag.id))} />{tag.name}</label>)}</div></fieldset>}
            <button disabled={busy} className="h-11 w-full rounded-xl bg-[#d32f2f] text-sm font-bold text-white disabled:opacity-50">{busy ? "جارٍ الحفظ..." : "حفظ التعديلات"}</button></form> : <div className="grid min-h-64 place-items-center text-center text-sm text-stone-400"><div><Tag size={25} className="mx-auto mb-2" />اختر عميلًا لعرض بياناته ووسومه.</div></div>}
          {canManageCatalog && <div className="mt-5 border-t border-stone-100 pt-4"><h3 className="mb-2 text-xs font-extrabold">إدارة الوسوم</h3><form onSubmit={createTag} className="flex gap-2"><input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="وسم جديد" maxLength={40} className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 px-3 text-xs outline-none" /><input aria-label="لون الوسم" type="color" value={tagColor} onChange={(event) => setTagColor(event.target.value)} className="h-10 w-12 rounded-lg border border-stone-200 bg-white p-1" /><button aria-label="إضافة وسم" className="grid h-10 w-10 place-items-center rounded-xl bg-stone-800 text-white"><Plus size={17} /></button></form><div className="mt-3 space-y-2">{tags.map((tag) => editingTagId === tag.id ? <form key={tag.id} onSubmit={saveTag} className="flex items-center gap-2 rounded-xl bg-stone-50 p-2"><input value={tagDraft.name} onChange={(event) => setTagDraft({ ...tagDraft, name: event.target.value })} maxLength={40} aria-label="اسم الوسم" className="h-9 min-w-0 flex-1 rounded-lg border border-stone-200 px-2 text-xs" /><input type="color" value={tagDraft.color} onChange={(event) => setTagDraft({ ...tagDraft, color: event.target.value })} aria-label="لون الوسم" className="h-9 w-10 rounded-lg border border-stone-200 bg-white p-1" /><button aria-label="حفظ الوسم" className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-600 text-white"><Save size={15} /></button><button type="button" onClick={() => setEditingTagId("")} aria-label="إلغاء تعديل الوسم" className="grid h-9 w-9 place-items-center rounded-lg bg-white text-stone-500"><X size={15} /></button></form> : <div key={tag.id} className="flex items-center gap-2 rounded-xl bg-stone-50 px-2 py-1.5"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color }} /><span className="min-w-0 flex-1 truncate text-xs font-bold">{tag.name}</span><span className="text-[10px] text-stone-400">{tag._count?.customers ?? ""}</span><button type="button" onClick={() => { setEditingTagId(tag.id); setTagDraft({ name: tag.name, color: tag.color || "#2563eb" }); }} aria-label={`تعديل الوسم ${tag.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-white"><Pencil size={14} /></button><button type="button" onClick={() => void deleteTag(tag)} aria-label={`حذف الوسم ${tag.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={14} /></button></div>)}</div></div>}
        </aside>
      </section> : <section className="space-y-4">
        {canManageCatalog && <div className="grid gap-4 md:grid-cols-2"><form onSubmit={createCategory} className="panel flex gap-2 p-4"><input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="اسم قسم جديد" maxLength={80} className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 px-3 text-sm outline-none" /><button className="rounded-xl bg-stone-800 px-4 text-xs font-bold text-white">إضافة قسم</button></form><form onSubmit={createEntry} className="panel grid gap-2 p-4 sm:grid-cols-2"><select required value={entry.categoryId} onChange={(event) => setEntry({ ...entry, categoryId: event.target.value })} className={inputClass}><option value="">اختر القسم</option>{directory.filter((category) => category.isActive).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><input required value={entry.name} onChange={(event) => setEntry({ ...entry, name: event.target.value })} placeholder="اسم جهة الاتصال" className={inputClass} /><input value={entry.phone} onChange={(event) => setEntry({ ...entry, phone: event.target.value })} placeholder="الهاتف" className={inputClass} dir="ltr" /><input value={entry.whatsappNumber} onChange={(event) => setEntry({ ...entry, whatsappNumber: event.target.value })} placeholder="واتساب" className={inputClass} dir="ltr" /><input type="email" value={entry.email} onChange={(event) => setEntry({ ...entry, email: event.target.value })} placeholder="البريد الإلكتروني" className={inputClass} dir="ltr" /><input value={entry.description} onChange={(event) => setEntry({ ...entry, description: event.target.value })} placeholder="وصف مختصر (اختياري)" className={inputClass} /><button className="rounded-xl bg-[#d32f2f] px-4 text-xs font-bold text-white">إضافة للدليل</button></form></div>}
        {canManageCatalog && <div className="panel flex flex-wrap items-center gap-2 p-4"><label htmlFor="delete-directory-category" className="text-xs font-bold text-stone-600">حذف قسم</label><select id="delete-directory-category" value={categoryIdToDelete} onChange={(event) => setCategoryIdToDelete(event.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 text-sm"><option value="">اختر القسم</option>{directory.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button type="button" disabled={!categoryIdToDelete} onClick={() => { const category = directory.find((item) => item.id === categoryIdToDelete); if (category) void deleteCategory(category); }} className="flex h-10 items-center gap-2 rounded-xl bg-red-50 px-4 text-xs font-bold text-red-700 disabled:opacity-40"><Trash2 size={15} />حذف القسم ومحتوياته</button></div>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {directory.map((category) => <article key={category.id} className={`panel p-5 ${category.isActive === false ? "opacity-60" : ""}`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              {editingCategoryId === category.id ? <form onSubmit={(event) => { event.preventDefault(); void updateCategory(category, { name: categoryDraft }); }} className="flex min-w-0 flex-1 gap-2"><input autoFocus value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} maxLength={80} aria-label="اسم القسم" className="h-9 min-w-0 flex-1 rounded-lg border border-stone-200 px-2 text-sm" /><button aria-label="حفظ القسم" className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-600 text-white"><Save size={14} /></button><button type="button" onClick={() => setEditingCategoryId("")} aria-label="إلغاء تعديل القسم" className="grid h-9 w-9 place-items-center rounded-lg bg-stone-100 text-stone-500"><X size={14} /></button></form> : <h2 className="flex min-w-0 items-center gap-2 font-extrabold"><BookUser size={17} className="shrink-0 text-[#b88718]" /><span className="truncate">{category.name}</span>{category.isActive === false && <span className="text-[9px] text-stone-400">مخفي</span>}</h2>}
              {canManageCatalog && editingCategoryId !== category.id && <div className="flex shrink-0 gap-1"><button type="button" onClick={() => { setEditingCategoryId(category.id); setCategoryDraft(category.name); }} aria-label={`تعديل القسم ${category.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100"><Pencil size={14} /></button><button type="button" onClick={() => void updateCategory(category, { isActive: !category.isActive })} aria-label={category.isActive === false ? `إظهار القسم ${category.name}` : `إخفاء القسم ${category.name}`} className="rounded-lg px-2 text-[10px] font-bold text-stone-500 hover:bg-stone-100">{category.isActive === false ? "إظهار" : "إخفاء"}</button></div>}
            </div>
            <div className="space-y-2">
              {category.entries.map((item: Row) => {
                const callHref = contactPhoneLink(item.phone, "call");
                const whatsappNumber = item.whatsappNumber || item.phone;
                const whatsappHref = contactPhoneLink(whatsappNumber, "whatsapp");
                return <div key={item.id} className={`rounded-xl bg-stone-50 p-3 ${item.isActive === false ? "opacity-55" : ""}`}>
                  {editingEntryId === item.id ? <form onSubmit={saveDirectoryEntry} className="grid gap-2"><select required value={entryDraft.categoryId} onChange={(event) => setEntryDraft({ ...entryDraft, categoryId: event.target.value })} className={inputClass}>{directory.filter((option) => option.isActive || option.id === entryDraft.categoryId).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><input required value={entryDraft.name} onChange={(event) => setEntryDraft({ ...entryDraft, name: event.target.value })} placeholder="الاسم" className={inputClass} /><input value={entryDraft.phone} onChange={(event) => setEntryDraft({ ...entryDraft, phone: event.target.value })} placeholder="الهاتف" className={inputClass} dir="ltr" /><input value={entryDraft.whatsappNumber} onChange={(event) => setEntryDraft({ ...entryDraft, whatsappNumber: event.target.value })} placeholder="واتساب" className={inputClass} dir="ltr" /><input type="email" value={entryDraft.email} onChange={(event) => setEntryDraft({ ...entryDraft, email: event.target.value })} placeholder="البريد الإلكتروني" className={inputClass} dir="ltr" /><input value={entryDraft.description} onChange={(event) => setEntryDraft({ ...entryDraft, description: event.target.value })} placeholder="وصف مختصر" className={inputClass} /><div className="flex gap-2"><button className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 text-xs font-bold text-white"><Save size={14} /> حفظ</button><button type="button" onClick={() => setEditingEntryId("")} className="grid h-9 w-9 place-items-center rounded-lg bg-white text-stone-500" aria-label="إلغاء"><X size={14} /></button></div></form> : <>
                    <div className="flex items-start justify-between gap-2"><b className="text-sm">{item.name}</b>{canManageCatalog && <div className="flex shrink-0 gap-1"><button type="button" onClick={() => { setEditingEntryId(item.id); setEntryDraft({ categoryId: category.id, name: item.name || "", phone: item.phone || "", whatsappNumber: item.whatsappNumber || "", email: item.email || "", description: item.description || "" }); }} aria-label={`تعديل ${item.name}`} className="grid h-7 w-7 place-items-center rounded-lg text-stone-500 hover:bg-white"><Pencil size={13} /></button><button type="button" onClick={() => void toggleDirectoryEntry(item)} aria-label={item.isActive === false ? `إظهار ${item.name}` : `إخفاء ${item.name}`} className="rounded-lg px-2 text-[9px] font-bold text-stone-500 hover:bg-white">{item.isActive === false ? "إظهار" : "إخفاء"}</button></div>}</div>
                    {item.description && <p className="mt-1 text-xs text-stone-500">{item.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-stone-500">
                      {callHref ? <a href={callHref} className="flex items-center gap-1 text-stone-700"><Phone size={12} />اتصال</a> : item.phone && <span>{item.phone}</span>}
                      {whatsappHref ? <a href={whatsappHref} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-emerald-700"><MessageCircle size={12} />واتساب</a> : item.whatsappNumber && <span>واتساب: {item.whatsappNumber}</span>}
                      {item.email && <a href={`mailto:${item.email}`} className="flex items-center gap-1"><Mail size={12} />{item.email}</a>}
                    </div>
                  </>}
                </div>;
              })}
              {!category.entries.length && <p className="text-xs text-stone-400">لا توجد جهات اتصال في هذا القسم.</p>}
            </div>
          </article>)}
          {!directory.length && <p className="panel p-8 text-center text-sm text-stone-400">دليل الشركة فارغ حاليًا.</p>}
        </div>
      </section>}
      <footer className="mt-5 text-center text-[10px] text-stone-400">بيانات العملاء مقيدة بصلاحيات المحادثات المسندة إليك.</footer>
    </div>
  </main>;
}
