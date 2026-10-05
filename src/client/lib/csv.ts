// Reading a CSV of people: the rows, and which column holds what. The
// separator is guessed from the header line (comma, semicolon or tab), since a
// spreadsheet saved in Europe often uses semicolons.

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const FIELDS: Record<string, string[]> = {
  email: ["email", "emailaddress", "mail", "workemail", "businessemail"],
  first_name: ["firstname", "first", "givenname", "voornaam", "nome", "vorname", "prenom"],
  last_name: ["lastname", "last", "surname", "familyname", "achternaam", "cognome", "nachname", "nom"],
  name: ["name", "fullname", "contact", "contactname", "naam", "nomecompleto"],
  company: ["company", "companyname", "organization", "organisation", "account", "accountname", "bedrijf", "azienda", "firma", "entreprise"],
  title: ["title", "jobtitle", "position", "role", "functie", "ruolo", "titel", "poste"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "personlinkedinurl"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "telefoon", "telefono", "telefon", "telephone"],
  notes: ["notes", "note", "context", "research", "about"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface CsvPeople {
  people: Array<Record<string, string>>;
  /** Field → the header it came from. */
  columns: Record<string, string>;
  withoutEmail: number;
}

export function csvPeople(rows: string[][]): CsvPeople {
  const [head = [], ...body] = rows;
  const columns: Record<string, string> = {};
  const index: Record<string, number> = {};
  head.forEach((h, i) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(FIELDS)) {
      if (index[field] === undefined && names.includes(n)) {
        index[field] = i;
        columns[field] = h.trim();
      }
    }
  });
  const people: Array<Record<string, string>> = [];
  let withoutEmail = 0;
  for (const r of body) {
    const get = (f: string) => (index[f] === undefined ? "" : (r[index[f]] ?? "").trim());
    const email = get("email");
    if (!email.includes("@")) {
      withoutEmail++;
      continue;
    }
    let first = get("first_name");
    let last = get("last_name");
    if (!first && !last && get("name")) {
      const [f, ...rest] = get("name").split(/\s+/);
      first = f;
      last = rest.join(" ");
    }
    const p: Record<string, string> = { email };
    for (const [k, v] of Object.entries({ first_name: first, last_name: last, company: get("company"), title: get("title"), linkedin_url: get("linkedin_url"), phone: get("phone"), notes: get("notes") })) {
      if (v) p[k] = v;
    }
    people.push(p);
  }
  return { people, columns, withoutEmail };
}
