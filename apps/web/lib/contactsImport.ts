import * as XLSX from "xlsx";
import { parseContactsCsv, parseContactRecords, parseContactsVcf } from "./contactsCsv";

export async function parseContactsFile(file: File) {
  const extension = file.name.split(".").pop()?.toLocaleLowerCase();
  if (extension === "csv") return parseContactsCsv(await file.text());
  if (extension === "vcf" || extension === "vcard") return parseContactsVcf(await file.text());
  if (extension === "xlsx" || extension === "xls") {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) return [];
    const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "", raw: false });
    return parseContactRecords(records);
  }
  throw new Error("اختر ملف CSV أو Excel أو VCF");
}
