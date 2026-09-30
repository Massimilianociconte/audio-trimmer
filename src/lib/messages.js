/**
 * Titolo breve + dettaglio da un messaggio lungo: la prima frase fa da titolo.
 * "Parte troppo grande (~172 MB): su questo … Dividi in almeno 3 parti."
 * → titolo "Parte troppo grande (~172 MB)", dettaglio il resto.
 */
export function splitMessage(message, maxTitle = 90) {
  const text = String(message ?? '').trim();
  if (!text) {
    return { title: '', detail: '' };
  }
  const match = /^(.{8,}?)([.:!?])\s+(.+)$/s.exec(text);
  if (!match || match[1].length > maxTitle) {
    return { title: text, detail: '' };
  }
  const title = match[2] === ':' ? match[1] : `${match[1]}${match[2]}`;
  const detail = match[3].trim();
  return { title, detail: detail.charAt(0).toUpperCase() + detail.slice(1) };
}
