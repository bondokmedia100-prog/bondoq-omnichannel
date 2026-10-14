type ContactRow = { displayName?: string; phone?: string; email?: string; notes?: string };

export function parseContactsCsv(text: string): ContactRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { field += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map((value) => value.trim());
  const supported = ["displayName", "phone", "email", "notes"] as const;
  return rows.map((values) => Object.fromEntries(supported.map((header) => {
    const index = headers.indexOf(header);
    const value = index < 0 ? "" : values[index] || "";
    return [header, value.replace(/^'(?=[=+@-])/, "").trim()];
  }))).filter((contact) => contact.displayName || contact.phone || contact.email) as ContactRow[];
}
