import { PrismaClient, Department, ProductCategory, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import menuProducts from "./menu-products.json";

const prisma = new PrismaClient();

const staff = [
  { email: "admin@bondoq.com", name: "مدير النظام", role: Role.ADMIN, department: null, password: process.env.BONDOQ_ADMIN_PASSWORD || "BondoqAdmin@2026" },
  { email: "ahmed@bondoq.com", name: "أحمد", role: Role.AGENT, department: Department.CAKES, password: process.env.BONDOQ_AGENT_PASSWORD || "Agent@123" },
  { email: "sara@bondoq.com", name: "سارة", role: Role.AGENT, department: Department.DELIVERY, password: process.env.BONDOQ_AGENT_PASSWORD || "Agent@123" },
  { email: "mahmoud@bondoq.com", name: "محمود", role: Role.AGENT, department: Department.CUSTOMER_CARE, password: process.env.BONDOQ_AGENT_PASSWORD || "Agent@123" },
  { email: "quality@bondoq.com", name: "فريق الجودة", role: Role.AGENT, department: Department.QUALITY, password: process.env.BONDOQ_QUALITY_PASSWORD || process.env.BONDOQ_AGENT_PASSWORD || "Quality@123" }
];

const responses = [
  ["/ترحيب", "ترحيب", "أهلًا وسهلًا بك في حلواني بندق 🍰 يسعدنا خدمتك، كيف نقدر نساعدك؟"],
  ["/منيو", "المنيو", "يسعدنا نشاركك منيو حلواني بندق. أخبرنا بالفرع الأقرب لك لنرسل لك الأصناف والأسعار المتاحة."],
  ["/تورتة_خاصة", "تورتة خاصة", "نجهز لك تورتة على ذوقك! ما الحجم والحشوة والعبارة التي ترغب بها؟ ومتى موعد التسليم؟"],
  ["/فروعنا", "فروعنا", "يسعدنا خدمتك في فروع حلواني بندق. أخبرنا بمنطقتك لنساعدك في اختيار أقرب فرع."],
  ["/تأكيد_طلب", "تأكيد الطلب", "تم تسجيل طلبك لدى حلواني بندق. سنراجع التفاصيل وموعد التسليم ونعود إليك بالتأكيد النهائي."],
  ["/شكوى", "متابعة شكوى", "نعتذر لك عن التجربة، ونشكرك لتنبيهنا. شاركنا رقم الطلب وتفاصيل ما حدث وسيتابع فريق خدمة العملاء الموضوع معك."]
];

const initialCatalogImportId = "menu-bondok-editable-v1";

async function main() {
  if (process.env.NODE_ENV === "production" && (!process.env.BONDOQ_ADMIN_PASSWORD || !process.env.BONDOQ_AGENT_PASSWORD)) {
    throw new Error("Set BONDOQ_ADMIN_PASSWORD and BONDOQ_AGENT_PASSWORD before seeding production accounts");
  }
  for (const person of staff) {
    const username = person.email.split("@")[0];
    const passwordHash = await bcrypt.hash(person.password, 12);
    await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name, role: person.role, department: person.department },
      create: { email: person.email, username, name: person.name, role: person.role, department: person.department, passwordHash }
    });
  }
  for (let index = 1; index <= 8; index += 1) {
    const id = `branch-${index}`;
    await prisma.branch.upsert({ where: { id }, update: {}, create: { id, name: `الفرع ${index}` } });
  }
  for (const [shortcut, title, content] of responses) {
    await prisma.cannedResponse.upsert({ where: { shortcut }, update: { title, content }, create: { shortcut, title, content } });
  }
  await prisma.autoReplyRule.createMany({ data: [{ id: "default-welcome", name: "رسالة الترحيب", keywords: [], responseText: "أهلًا بك في حلواني بندق. اختر كيف نقدر نساعدك:", isWelcome: true, priority: 100 }], skipDuplicates: true });
  const webOrigin = (process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  const fullCatalog = menuProducts.map((product) => ({
      ...product,
      category: product.category as ProductCategory,
      price: product.price.toFixed(2),
      imageUrl: `${webOrigin}/menu/${product.imageFile}`
    }));
  if (fullCatalog.length !== 76 || new Set(fullCatalog.map((product) => product.id)).size !== 76) {
    throw new Error("Expected 76 unique products in the initial Bondoq menu import");
  }
  const imported = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1784354946, 1)`;
    const priorImport = await tx.catalogImport.findUnique({ where: { id: initialCatalogImportId } });
    if (priorImport) return false;

    await tx.product.deleteMany();
    const data = fullCatalog.map(({ imageFile: _imageFile, ...record }) => record);
    await tx.product.createMany({ data });
    await tx.catalogImport.create({
      data: { id: initialCatalogImportId, source: "menu_bondok_editable_4.html", productCount: data.length }
    });
    return true;
  });
  console.info(imported ? "Initial Bondoq menu replaced the product catalog." : "Initial Bondoq menu import already completed; catalog unchanged.");
  console.info("Bondoq demo accounts, canned responses, and sample products seeded.");
}

main().finally(() => prisma.$disconnect());
