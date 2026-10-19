"use client";

import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Save, ShieldCheck, UserRound, X } from "lucide-react";
import { api } from "@/lib/api";

type Member = {
  id: string;
  name: string;
  email: string;
  username: string;
  role: string;
  department: string | null;
  presence: string;
  isConnected?: boolean;
  isActive: boolean;
  canViewAllConversations: boolean | null;
  canTransferConversations: boolean | null;
  canManageCatalog: boolean | null;
  canViewReports: boolean | null;
  canManageTeam: boolean | null;
  canReceiveWhatsApp: boolean | null;
  canReceiveMessenger: boolean | null;
  canReceiveTelegram: boolean | null;
  whatsappAccess: AccessMode | null;
  messengerAccess: AccessMode | null;
  telegramAccess: AccessMode | null;
};
type Channel = "WHATSAPP" | "MESSENGER" | "TELEGRAM";
type AccessMode = "FULL" | "READ_ONLY" | "DISABLED";
type ChannelChoice = "INHERIT" | "FULL" | "READ_ONLY" | "EXCLUDED";
type Form = { name: string; email: string; username: string; password: string; role: string; department: string; canViewAllConversations: boolean; canTransferConversations: boolean; canManageCatalog: boolean; canViewReports: boolean; canManageTeam: boolean; whatsappAccess: ChannelChoice; messengerAccess: ChannelChoice; telegramAccess: ChannelChoice };
type DepartmentPolicy = { department: string; mode: AccessMode };

const emptyForm: Form = { name: "", email: "", username: "", password: "", role: "AGENT", department: "HEADQUARTERS", canViewAllConversations: false, canTransferConversations: false, canManageCatalog: false, canViewReports: false, canManageTeam: false, whatsappAccess: "INHERIT", messengerAccess: "INHERIT", telegramAccess: "INHERIT" };
const roleNames: Record<string, string> = { ADMIN: "مدير النظام", SUPERVISOR: "قائد فريق", AGENT: "موظف", BRANCH_USER: "موظف" };
const departmentNames: Record<string, string> = { HEADQUARTERS: "المقر الرئيسي (HQ)", WORK_FROM_HOME: "العمل من المنزل (WFH)", BRANCH: "خدمة العملاء", ADMINISTRATION: "الإدارة", CAKES: "مبيعات التورتات", DELIVERY: "طلبات التوصيل", CUSTOMER_CARE: "خدمة العملاء", QUALITY: "الجودة" };
const permissionNames: Array<[keyof Pick<Form, "canViewAllConversations" | "canTransferConversations" | "canManageCatalog" | "canViewReports" | "canManageTeam">, string]> = [
  ["canViewAllConversations", "عرض جميع المحادثات"], ["canTransferConversations", "تحويل المحادثات"], ["canManageCatalog", "إدارة الكتالوج والردود"], ["canViewReports", "عرض التقارير"], ["canManageTeam", "إدارة الفريق"]
];
const channelNames: Array<{ id: Channel; key: "whatsappAccess" | "messengerAccess" | "telegramAccess"; legacy: "canReceiveWhatsApp" | "canReceiveMessenger" | "canReceiveTelegram"; label: string }> = [
  { id: "WHATSAPP", key: "whatsappAccess", legacy: "canReceiveWhatsApp", label: "واتساب" },
  { id: "MESSENGER", key: "messengerAccess", legacy: "canReceiveMessenger", label: "ماسنجر" },
  { id: "TELEGRAM", key: "telegramAccess", legacy: "canReceiveTelegram", label: "تليجرام" }
];
const accessNames: Record<ChannelChoice | AccessMode, string> = { INHERIT: "حسب إعداد القسم", FULL: "كامل", READ_ONLY: "قراءة فقط", EXCLUDED: "مستبعد", DISABLED: "مستبعد" };
const accessChoices: Array<[ChannelChoice, string]> = [["INHERIT", "حسب إعداد القسم"], ["FULL", "كامل"], ["READ_ONLY", "قراءة فقط"], ["EXCLUDED", "مستبعد"]];
const toAccessMode = (choice: ChannelChoice | AccessMode): AccessMode | null => choice === "INHERIT" ? null : choice === "EXCLUDED" ? "DISABLED" : choice;
const fromAccessMode = (mode: AccessMode | null | undefined): ChannelChoice => !mode ? "INHERIT" : mode === "DISABLED" ? "EXCLUDED" : mode;
const permissionsForRole = (role: string) => permissionNames.filter(([key]) => key !== "canViewAllConversations" || role === "SUPERVISOR" || role === "ADMIN");

function effectivePermission(member: Member, key: keyof Form) {
  const value = member[key as keyof Member];
  if (typeof value === "boolean") return value;
  return member.role === "ADMIN" || member.role === "SUPERVISOR";
}

export default function TeamManagementModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [staff, setStaff] = useState<Member[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyChannel, setPolicyChannel] = useState<Channel>("MESSENGER");
  const [departmentPolicies, setDepartmentPolicies] = useState<Record<Channel, DepartmentPolicy[]>>({ WHATSAPP: [], MESSENGER: [], TELEGRAM: [] });
  const [policyDraft, setPolicyDraft] = useState<Record<Channel, Record<string, AccessMode>>>({ WHATSAPP: {}, MESSENGER: {}, TELEGRAM: {} });

  async function refresh() {
    const [members, messenger, whatsapp, telegram] = await Promise.all([
      api<Member[]>("/api/admin/team"),
      api<{ departments: DepartmentPolicy[] }>("/api/admin/messenger-permissions"),
      api<{ departments: DepartmentPolicy[] }>("/api/admin/channel-permissions/WHATSAPP"),
      api<{ departments: DepartmentPolicy[] }>("/api/admin/channel-permissions/TELEGRAM")
    ]);
    const policies = { WHATSAPP: whatsapp.departments, MESSENGER: messenger.departments, TELEGRAM: telegram.departments };
    setStaff(members);
    setDepartmentPolicies(policies);
    setPolicyDraft(Object.fromEntries(channelNames.map(({ id }) => [id, Object.fromEntries(policies[id].map(({ department, mode }) => [department, mode]))])) as Record<Channel, Record<string, AccessMode>>);
  }

  useEffect(() => { refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "تعذر تحميل الفريق")); }, []);

  function updateForm<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(member: Member) {
    setError(""); setNotice(""); setEditingId(member.id);
    setForm({ name: member.name, email: member.email, username: member.username, password: "", role: member.role === "BRANCH_USER" ? "AGENT" : member.role, department: member.department === "BRANCH" ? "CUSTOMER_CARE" : member.department || "", canViewAllConversations: effectivePermission(member, "canViewAllConversations"), canTransferConversations: effectivePermission(member, "canTransferConversations"), canManageCatalog: effectivePermission(member, "canManageCatalog"), canViewReports: effectivePermission(member, "canViewReports"), canManageTeam: effectivePermission(member, "canManageTeam"), whatsappAccess: fromAccessMode(member.whatsappAccess), messengerAccess: fromAccessMode(member.messengerAccess), telegramAccess: fromAccessMode(member.telegramAccess) });
  }

  function resetForm() { setEditingId(""); setForm(emptyForm); }

  async function saveMember(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const body = { ...form, canViewAllConversations: form.role === "SUPERVISOR" || form.role === "ADMIN" ? form.canViewAllConversations : false, username: form.username || undefined, department: form.department || null, whatsappAccess: toAccessMode(form.whatsappAccess), messengerAccess: toAccessMode(form.messengerAccess), telegramAccess: toAccessMode(form.telegramAccess) };
    if (!editingId && form.password.length < 10) { setBusy(false); setError("كلمة المرور يجب ألا تقل عن 10 أحرف."); return; }
    try {
      const saved = editingId
        ? await api(`/api/admin/agents/${editingId}`, { method: "PATCH", body: JSON.stringify({ ...body, password: undefined }) })
        : await api("/api/admin/agents", { method: "POST", body: JSON.stringify(body) });
      setStaff((current) => editingId ? current.map((member) => member.id === editingId ? saved : member) : [...current, saved].sort((a, b) => a.name.localeCompare(b.name, "ar")));
      setNotice(editingId ? "تم حفظ تعديلات الموظف وتحديث بيانات الفريق." : "تم إنشاء الحساب وإضافته إلى الفريق.");
      resetForm(); onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر حفظ الحساب"); }
    finally { setBusy(false); }
  }

  async function toggle(member: Member) {
    setError(""); setNotice("");
    try {
      const saved = await api(`/api/admin/agents/${member.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !member.isActive }) });
      setStaff((current) => current.map((item) => item.id === member.id ? saved : item));
      setNotice(member.isActive ? `تم إيقاف حساب ${member.name}.` : `تم تفعيل حساب ${member.name}.`); onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر تغيير حالة الحساب"); }
  }

  async function resetPassword(member: Member) {
    const password = passwords[member.id] || "";
    if (password.length < 10) { setError("كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف."); return; }
    setError(""); setNotice("");
    try {
      await api(`/api/admin/agents/${member.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setPasswords((current) => ({ ...current, [member.id]: "" }));
      setNotice(`تم تحديث كلمة مرور ${member.name} وإبطال جلساته السابقة.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر تحديث كلمة المرور"); }
  }

  async function saveDepartmentPolicy(event: FormEvent) {
    event.preventDefault(); setSavingPolicy(true); setError(""); setNotice("");
    try {
      const endpoint = policyChannel === "MESSENGER" ? "/api/admin/messenger-permissions" : `/api/admin/channel-permissions/${policyChannel}`;
      const departments = Object.entries(policyDraft[policyChannel]).map(([department, mode]) => ({ department, mode }));
      const saved = await api<{ departments: DepartmentPolicy[] }>(endpoint, { method: "PUT", body: JSON.stringify({ departments }) });
      setDepartmentPolicies((current) => ({ ...current, [policyChannel]: saved.departments }));
      setNotice(`تم تحديث صلاحيات ${channelNames.find(({ id }) => id === policyChannel)?.label || policyChannel}.`); onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "تعذر حفظ صلاحيات القسم"); }
    finally { setSavingPolicy(false); }
  }

  function accessForMember(member: Member, channel: typeof channelNames[number]): AccessMode {
    const override = member[channel.key];
    if (override) return override;
    const departmentMode = departmentPolicies[channel.id].find((item) => item.department === member.department)?.mode || "DISABLED";
    return departmentMode === "FULL" && member[channel.legacy] === false ? "READ_ONLY" : departmentMode;
  }

  const employeeRole = form.role === "AGENT";

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-900/45 p-3" onClick={onClose}>
    <section dir="rtl" role="dialog" aria-modal="true" aria-labelledby="team-title" className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl sm:p-6" onClick={(event) => event.stopPropagation()}>
      <header className="mb-5 flex items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><ShieldCheck className="text-[#c48d20]" size={19} /><h2 id="team-title" className="text-xl font-extrabold">إدارة الفريق</h2></div><p className="mt-1 text-xs text-stone-500">الأدوار، الأقسام، الصلاحيات وكلمات المرور</p></div>
        <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-xl p-2 text-stone-400 hover:bg-stone-100"><X size={19} /></button>
      </header>

      {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

      <div className="grid gap-5 xl:grid-cols-[minmax(330px,.85fr)_minmax(0,1.15fr)]">
        <div className="space-y-5">
          <form onSubmit={saveMember} className="rounded-2xl border border-stone-200 bg-[#fcfbf8] p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between"><h3 className="font-extrabold">{editingId ? "تعديل بيانات الموظف" : "إضافة عضو جديد"}</h3>{editingId && <button type="button" onClick={resetForm} className="text-xs font-bold text-stone-500">إلغاء التعديل</button>}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold text-stone-600">الاسم الكامل<input required minLength={2} value={form.name} onChange={(event) => updateForm("name", event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400" /></label>
              <label className="text-xs font-bold text-stone-600">البريد الإلكتروني<input required type="email" value={form.email} onChange={(event) => updateForm("email", event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400" dir="ltr" /></label>
              <label className="text-xs font-bold text-stone-600">اسم المستخدم (اختياري عند الإضافة)<input minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={form.username} onChange={(event) => updateForm("username", event.target.value.toLowerCase())} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400" dir="ltr" /></label>
              {!editingId && <label className="text-xs font-bold text-stone-600">كلمة المرور المؤقتة<input required type="password" minLength={10} autoComplete="new-password" value={form.password} onChange={(event) => updateForm("password", event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400" dir="ltr" /></label>}
              <label className="text-xs font-bold text-stone-600">الدور<select value={form.role} onChange={(event) => { const role = event.target.value; setForm((current) => ({ ...current, role, department: current.department === "BRANCH" ? "CUSTOMER_CARE" : current.department, canViewAllConversations: role === "SUPERVISOR" || role === "ADMIN", canTransferConversations: role === "SUPERVISOR" || role === "ADMIN", canManageCatalog: role === "SUPERVISOR" || role === "ADMIN", canViewReports: role === "SUPERVISOR" || role === "ADMIN", canManageTeam: role === "SUPERVISOR" || role === "ADMIN" })); }} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400"><option value="AGENT">موظف</option><option value="SUPERVISOR">قائد فريق</option><option value="ADMIN">مدير النظام الأعلى</option></select></label>
              <label className="text-xs font-bold text-stone-600">القسم / مكان العمل<select value={form.department} onChange={(event) => updateForm("department", event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 font-normal outline-none focus:border-amber-400"><option value="HEADQUARTERS">المقر الرئيسي (HQ)</option><option value="WORK_FROM_HOME">العمل من المنزل (WFH)</option><option value="ADMINISTRATION">الإدارة</option><option value="CAKES">مبيعات التورتات</option><option value="DELIVERY">طلبات التوصيل</option><option value="CUSTOMER_CARE">خدمة العملاء</option><option value="QUALITY">الجودة</option></select></label>
            </div>
            <fieldset className="mt-4 rounded-xl border border-stone-200 bg-white p-3"><legend className="px-1 text-xs font-extrabold text-stone-600">الصلاحيات الفردية</legend><div className="grid gap-2 sm:grid-cols-2">{permissionsForRole(form.role).map(([key, title]) => <label key={key} className="flex items-center gap-2 text-xs text-stone-700"><input type="checkbox" checked={form[key]} onChange={(event) => updateForm(key, event.target.checked)} className="h-4 w-4 accent-[#b9272d]" />{title}</label>)}</div></fieldset>
            {employeeRole && <fieldset className="mt-3 rounded-xl border border-stone-200 bg-white p-3"><legend className="px-1 text-xs font-extrabold text-stone-600">صلاحيات القنوات للموظف</legend><div className="grid gap-3 sm:grid-cols-3">{channelNames.map(({ id, label, key }) => <label key={id} className="text-xs font-bold text-stone-600">{label}<select value={form[key]} onChange={(event) => updateForm(key, event.target.value as ChannelChoice)} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-2 text-xs font-normal outline-none focus:border-amber-400">{accessChoices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>)}</div><p className="mt-2 text-[10px] leading-5 text-stone-400">الكامل يسمح بالرد والإسناد والتحويل، والقراءة فقط تعرض المحادثات دون الرد، والمستبعد يمنع الوصول. خيار حسب القسم يتبع الإعداد الافتراضي أدناه.</p></fieldset>}
            <button disabled={busy} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#bd2528] text-sm font-bold text-white hover:bg-[#a61e21] disabled:opacity-60"><Save size={16} />{busy ? "جارٍ الحفظ..." : editingId ? "حفظ التعديلات" : "إنشاء الحساب"}</button>
          </form>
          <section className="rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
            <div className="mb-3"><h3 className="font-extrabold">صلاحيات القنوات الافتراضية للأقسام</h3><p className="mt-1 text-[10px] leading-5 text-stone-500">تبدأ القيم من سياسة الإنتاج الحالية. التغيير هنا يضبط صلاحية القسم، ويمكن تجاوزها لكل موظف أعلاه.</p></div>
            <div className="mb-3 flex rounded-xl bg-stone-100 p-1">{channelNames.map(({ id, label }) => <button key={id} type="button" onClick={() => setPolicyChannel(id)} className={`flex-1 rounded-lg px-2 py-2 text-[10px] font-bold ${policyChannel === id ? "bg-white text-stone-800 shadow-sm" : "text-stone-500"}`}>{label}</button>)}</div>
            <form onSubmit={saveDepartmentPolicy} className="space-y-2">
              {departmentPolicies[policyChannel].map(({ department, mode }) => <label key={department} className="flex items-center justify-between gap-3 rounded-xl bg-[#fcfbf8] px-3 py-2 text-[10px] font-semibold text-stone-600"><span>{departmentNames[department] || department}</span><select value={policyDraft[policyChannel][department] || mode} onChange={(event) => setPolicyDraft((current) => ({ ...current, [policyChannel]: { ...current[policyChannel], [department]: event.target.value as AccessMode } }))} className="h-9 min-w-32 rounded-lg border border-stone-200 bg-white px-2 text-xs font-normal outline-none focus:border-amber-400"><option value="FULL">كامل</option><option value="READ_ONLY">قراءة فقط</option><option value="DISABLED">مستبعد</option></select></label>)}
              <button type="submit" disabled={savingPolicy || !departmentPolicies[policyChannel].length} className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-stone-800 text-xs font-bold text-white hover:bg-stone-700 disabled:opacity-50"><Save size={14} />{savingPolicy ? "جارٍ حفظ السياسة..." : "حفظ صلاحيات القسم"}</button>
            </form>
          </section>
        </div>

          <section className="min-w-0"><div className="mb-3 flex items-center justify-between"><h3 className="font-extrabold">أعضاء الفريق</h3><span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-600">{staff.length}</span></div><div className="space-y-2">{staff.map((member) => <article key={member.id} className="rounded-2xl border border-stone-200 p-3 sm:p-4"><div className="flex flex-wrap items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fff4dc] text-[#a87a16]"><UserRound size={18} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><b className="text-sm">{member.name}</b><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${member.isActive ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{member.isActive ? "نشط" : "موقوف"}</span><span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-600">{roleNames[member.role] || member.role}</span></div><p className="mt-1 truncate text-xs text-stone-500" dir="ltr">{member.email} · {member.username}</p><p className="mt-1 text-[10px] text-stone-400">{departmentNames[member.department === "BRANCH" ? "CUSTOMER_CARE" : member.department || ""] || "بدون قسم"} · {member.presence === "ONLINE" ? member.isConnected ? "متصل الآن" : "غير متصل" : member.presence === "BREAK" ? "استراحة" : member.presence === "BUSY" ? "مشغول" : "غير متصل"}</p></div><div className="flex gap-1.5"><button type="button" onClick={() => startEdit(member)} className="flex items-center gap-1 rounded-lg bg-stone-100 px-2.5 py-2 text-[10px] font-bold text-stone-700"><Pencil size={13} />تعديل</button><button type="button" onClick={() => void toggle(member)} className={`rounded-lg px-2.5 py-2 text-[10px] font-bold ${member.isActive ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{member.isActive ? "إيقاف" : "تفعيل"}</button></div></div>
                <div className="mt-3 flex flex-wrap gap-1.5">{permissionsForRole(member.role).filter(([key]) => effectivePermission(member, key)).map(([, title]) => <span key={title} className="rounded-full bg-[#fff8e7] px-2 py-1 text-[9px] text-[#806015]">{title}</span>)}{!permissionsForRole(member.role).some(([key]) => effectivePermission(member, key)) && <span className="text-[10px] text-stone-400">لا توجد صلاحيات إضافية</span>}</div>
                {(member.role === "AGENT" || member.role === "BRANCH_USER") && <div className="mt-2 flex flex-wrap gap-1.5">{channelNames.map((channel) => <span key={channel.id} className={`rounded-full px-2 py-1 text-[9px] ${accessForMember(member, channel) === "FULL" ? "bg-blue-50 text-blue-800" : accessForMember(member, channel) === "READ_ONLY" ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-500"}`}>{channel.label}: {accessNames[accessForMember(member, channel)]}</span>)}</div>}
              <div className="mt-3 flex gap-2 border-t border-stone-100 pt-3"><input type="password" autoComplete="new-password" minLength={10} placeholder="كلمة مرور جديدة (10 أحرف فأكثر)" value={passwords[member.id] || ""} onChange={(event) => setPasswords((current) => ({ ...current, [member.id]: event.target.value }))} className="h-9 min-w-0 flex-1 rounded-lg border border-stone-200 px-3 text-xs outline-none focus:border-amber-400" dir="ltr" /><button type="button" onClick={() => void resetPassword(member)} className="flex items-center gap-1 rounded-lg bg-[#fff4dc] px-3 text-[10px] font-bold text-[#805c11]"><KeyRound size={13} />تحديث كلمة المرور</button></div>
            </article>)}{!staff.length && <p className="rounded-xl bg-stone-50 p-8 text-center text-sm text-stone-400">لا يوجد أعضاء فريق بعد.</p>}</div></section>
      </div>
    </section>
  </div>;
}
