import assert from "node:assert/strict";
import test from "node:test";
import { parseContactsCsv, parseContactsVcf } from "./contactsCsv";

test("parses quoted commas, escaped quotes, and multi-line CSV cells", () => {
  assert.deepEqual(parseContactsCsv('displayName,phone,email,notes\r\n"Mona, A","+201001234567",mona@example.com,"first line\nsecond ""line"""'), [{
    displayName: "Mona, A", phone: "+201001234567", email: "mona@example.com", notes: 'first line\nsecond "line"'
  }]);
});

test("ignores unsupported columns and spreadsheet escape prefixes", () => {
  assert.deepEqual(parseContactsCsv("displayName,phone,tags\n'=SUM(A1),'+201001234567,loyal"), [{
    displayName: "=SUM(A1)", phone: "+201001234567", email: "", notes: ""
  }]);
});

test("accepts localized headers and semicolon-delimited CSV", () => {
  assert.deepEqual(parseContactsCsv("الاسم;رقم الهاتف;البريد الإلكتروني\nمريم;+201001234567;mariam@example.com"), [{
    displayName: "مريم", phone: "+201001234567", email: "mariam@example.com"
  }]);
});

test("parses vCard names, phone numbers, and emails", () => {
  assert.deepEqual(parseContactsVcf("BEGIN:VCARD\nVERSION:3.0\nFN:Mona Samir\nTEL;TYPE=CELL:+201001234567\nEMAIL:mona@example.com\nEND:VCARD"), [{
    displayName: "Mona Samir", phone: "+201001234567", email: "mona@example.com"
  }]);
});
