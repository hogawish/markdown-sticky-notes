// Display-only selection. Never change the files or the saved folder order.
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const normalize = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja");
export const UNASSIGNED = "__unassigned__";

export function selectNotes(notes, filters = {}) {
  const query = normalize(filters.query).trim();
  const selected = notes.filter(note => {
    if (filters.archive !== "all" && filters.archive !== "archived" && note.archived) return false;
    if (filters.archive === "archived" && !note.archived) return false;
    if (filters.folder && note.folder_path !== filters.folder) return false;
    if (filters.tag === UNASSIGNED && note.tags?.length) return false;
    if (filters.tag && filters.tag !== UNASSIGNED && !note.tags?.includes(filters.tag.slice(2))) return false;
    if (filters.status === UNASSIGNED && note.status) return false;
    if (filters.status && filters.status !== UNASSIGNED && note.status !== filters.status.slice(2)) return false;
    if (query && !normalize([note.title, note.body, note.name, note.folder_label, note.status, ...(note.tags || [])].join("\n")).includes(query)) return false;
    return true;
  });
  const sort = ["updated", "created", "title", "folder"].includes(filters.sort) ? filters.sort : "updated";
  const direction = filters.direction === "asc" ? 1 : -1;
  return selected.sort((a, b) => {
    let comparison;
    if (sort === "title") comparison = collator.compare(a.title, b.title);
    else if (sort === "folder") comparison = collator.compare(a.folder_label, b.folder_label) || collator.compare(a.title, b.title);
    else comparison = Number(a[sort] || 0) - Number(b[sort] || 0);
    return comparison * direction || collator.compare(a.path, b.path);
  });
}

export function choices(notes, key) {
  return [...new Set(notes.flatMap(note => key === "tags" ? note.tags || [] : note.status ? [note.status] : []))].sort(collator.compare);
}
