import { config } from "./config";

const htmlEscapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => htmlEscapes[char]);

export async function sendPasswordResetApprovalEmail(to: string, name: string, identifier: string, approveUrl: string) {
  if (!config.resendApiKey || !config.emailFrom) throw new Error("Email delivery is not configured");
  const safeName = escapeHtml(name);
  const safeIdentifier = escapeHtml(identifier);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [to],
      subject: "موافقة مطلوبة لإعادة ضبط كلمة مرور",
      text: `ورد طلب لإعادة ضبط كلمة المرور للحساب ${name} (${identifier}). إذا كنت توافق على الطلب، افتح هذا الرابط وأكد الموافقة:\n\n${approveUrl}\n\nالرابط صالح لمدة ساعة. إذا لم تتوقع هذا الطلب، تجاهل الرسالة.`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#292524"><h2>موافقة مطلوبة لإعادة ضبط كلمة مرور</h2><p>ورد طلب للحساب <b>${safeName}</b> (<span dir="ltr">${safeIdentifier}</span>).</p><p>اضغط الزر للمراجعة ثم أكد الموافقة. بعد التأكيد سيصل رابط تغيير كلمة المرور إلى هذا البريد. رابط الموافقة صالح لمدة ساعة.</p><p><a href="${approveUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#bd2528;color:#fff;text-decoration:none;font-weight:bold">مراجعة الطلب والموافقة</a></p><p>إذا لم تتوقع هذا الطلب، فتجاهل الرسالة.</p></div>`
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  if (!config.resendApiKey || !config.emailFrom) throw new Error("Email delivery is not configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [to],
      subject: "رابط إعادة ضبط كلمة المرور",
      text: `تمت الموافقة على طلب إعادة ضبط كلمة المرور. استخدم الرابط التالي لتعيين كلمة مرور جديدة خلال 30 دقيقة:\n\n${resetUrl}\n\nإذا لم تطلب ذلك، تجاهل هذه الرسالة.`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#292524"><h2>إعادة ضبط كلمة المرور</h2><p>تمت الموافقة على طلبك. استخدم الزر أدناه لتعيين كلمة مرور جديدة. الرابط صالح لمدة 30 دقيقة ويُستخدم مرة واحدة.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#bd2528;color:#fff;text-decoration:none;font-weight:bold">تعيين كلمة مرور جديدة</a></p><p>إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p></div>`
    })
  });

  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}
