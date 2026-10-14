import { PrismaClient, ProductCategory } from "@prisma/client";
import menuProducts from "./menu-products.json";

const prisma = new PrismaClient();
const importId = "menu-bondok-editable-v1";

async function main() {
  const webOrigin = (process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  const catalog = menuProducts.map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category as ProductCategory,
    price: product.price.toFixed(2),
    imageUrl: `${webOrigin}/menu/${product.imageFile}`,
    description: product.description
  }));

  if (catalog.length !== 76 || new Set(catalog.map((product) => product.id)).size !== 76) {
    throw new Error("Expected 76 unique products in the initial Bondoq menu import");
  }

  const importedCount = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1784354946, 1)`;
    if (await tx.catalogImport.findUnique({ where: { id: importId } })) return 0;

    await tx.product.deleteMany();
    const result = await tx.product.createMany({ data: catalog });
    if (result.count !== catalog.length) throw new Error("Catalog import count did not match the source menu");

    await tx.catalogImport.create({
      data: { id: importId, source: "menu_bondok_editable_4.html", productCount: result.count }
    });
    return result.count;
  });

  console.info(importedCount ? `Initial Bondoq menu imported (${importedCount} products).` : "Initial Bondoq menu import already completed; catalog unchanged.");
}

main().catch((error) => {
  console.error("Catalog import failed.", error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
