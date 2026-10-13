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

const products = [
  { id: "seed-basbousa", name: "بسبوسة بندق", category: ProductCategory.EASTERN, price: "220.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "صينية بسبوسة بالمكسرات" },
  { id: "seed-kunafa", name: "كنافة بالقشطة", category: ProductCategory.EASTERN, price: "280.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "كنافة طازجة بالقشطة" },
  { id: "seed-cookies", name: "علبة كوكيز مشكلة", category: ProductCategory.WESTERN, price: "190.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "تشكيلة كوكيز مخبوزة يوميًا" },
  { id: "seed-cheesecake", name: "تشيز كيك الفراولة", category: ProductCategory.WESTERN, price: "320.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "تشيز كيك بطبقة فراولة" },
  { id: "seed-chocolate-cake", name: "تورتة شوكولاتة", category: ProductCategory.CAKES, price: "480.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "تورتة شوكولاتة بلجيكي" },
  { id: "seed-celebration-cake", name: "تورتة مناسبات", category: ProductCategory.CAKES, price: "620.00", imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=900&auto=format&fit=crop&q=85", description: "تورتة قابلة للتخصيص حسب المناسبة" }
];

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
  for (const [shortcut, title, content] of responses) {
    await prisma.cannedResponse.upsert({ where: { shortcut }, update: { title, content }, create: { shortcut, title, content } });
  }
  const webOrigin = (process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  const fullCatalog = [
    ...products,
    ...menuProducts.map((product) => ({
      ...product,
      category: product.category as ProductCategory,
      price: product.price.toFixed(2),
      imageUrl: `${webOrigin}/menu/${product.imageFile}`
    }))
  ];
  for (const product of fullCatalog) {
    const { imageFile: _imageFile, ...record } = product as typeof product & { imageFile?: string };
    await prisma.product.upsert({ where: { id: record.id }, update: record, create: record });
  }
  console.info("Bondoq demo accounts, canned responses, and sample products seeded.");
}

main().finally(() => prisma.$disconnect());
