type ContactRow = { displayName?: string; phone?: string; email?: string; notes?: string };

const headerAliases: Record<string, keyof ContactRow> = {
  displayname: "displayName", name: "displayName", fullname: "displayName", "full name": "displayName", الاسم: "displayName", "الاسم الكامل": "displayName",
  phone: "phone", telephone: "phone", mobile: "phone", number: "phone", هاتف: "phone", الهاتف: "phone", "رقم الهاتف": "phone", الجوال: "phone",
  email: "email", "e-mail": "email", البريد: "email", "البريد الإلكتروني": "email",
  notes: "notes", note: "notes", ملاحظات: "notes", ملاحظة: "notes"
};

function canonicalHeader(value: unknown) {
  const header = String(value ?? "").trim().toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return headerAliases[header.replace(/ /g, "")] || headerAliases[header];
}

function safeCell(value: unknown) {
  return String(value ?? "").replace(/^'(?=[=+@-])/, "").trim();
}

export function parseContactRecords(records: Record<string, unknown>[]): ContactRow[] {
  return records.map((record) => {
    const contact: ContactRow = {};
    for (const [header, value] of Object.entries(record)) {
      const key = canonicalHeader(header);
      if (key) contact[key] = safeCell(value);
    }
    return contact;
  }).filter((contact) => contact.displayName || contact.phone || contact.email);
}

export function parseContactsCsv(text: string): ContactRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const delimiter = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { field += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  return parseContactRecords(rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))));
}

function unfoldVcardLines(text: string) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeVcard(value: string) {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

export function parseContactsVcf(text: string): ContactRow[] {
  const contacts: ContactRow[] = [];
  let card: string[] = [];
  for (const line of unfoldVcardLines(text)) {
    if (line.toUpperCase() === "BEGIN:VCARD") { card = []; continue; }
    if (line.toUpperCase() === "END:VCARD") {
      const values: Record<string, unknown> = {};
      for (const property of card) {
        const separator = property.indexOf(":");
        if (separator < 0) continue;
        const name = property.slice(0, separator).split(";")[0].toUpperCase();
        const value = unescapeVcard(property.slice(separator + 1));
        if (name === "FN") values.displayName = value;
        else if (name === "N" && !values.displayName) values.displayName = value.split(";").filter(Boolean).reverse().join(" ");
        else if (name === "TEL" && !values.phone) values.phone = value;
        else if (name === "EMAIL" && !values.email) values.email = value;
        else if (name === "NOTE") values.notes = value;
      }
      contacts.push(...parseContactRecords([values]));
      card = [];
      continue;
    }
    if (card.length) card.push(line);
  }
  return contacts;
}
