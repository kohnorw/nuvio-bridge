// Language handling for playback preferences.
//
// Three things need language codes and they don't agree with each other:
// Nuvio's settings use ISO 639-1 ("en"), subtitle addons emit a mix of 639-1
// and 639-2 ("en", "eng"), and VLC's `audio-language` / `sub-language` options
// want 639-2/B ("eng"). So everything is normalised through here.

const LANGUAGES = [
  { code: 'en', iso2: 'eng', name: 'English', match: /\b(eng(?:lish)?|en)\b/i },
  { code: 'es', iso2: 'spa', name: 'Spanish', match: /\b(spa(?:nish)?|esp|es|castellano|latino)\b/i },
  { code: 'fr', iso2: 'fre', name: 'French', match: /\b(fre(?:nch)?|fra|vf|vostfr|fr)\b/i },
  { code: 'de', iso2: 'ger', name: 'German', match: /\b(ger(?:man)?|deu|de)\b/i },
  { code: 'it', iso2: 'ita', name: 'Italian', match: /\b(ita(?:lian)?|it)\b/i },
  { code: 'pt', iso2: 'por', name: 'Portuguese', match: /\b(por(?:tuguese)?|pt|pt-br|dublado)\b/i },
  { code: 'nl', iso2: 'dut', name: 'Dutch', match: /\b(dut(?:ch)?|nld|nl)\b/i },
  { code: 'pl', iso2: 'pol', name: 'Polish', match: /\b(pol(?:ish)?|pl|lektor)\b/i },
  { code: 'ru', iso2: 'rus', name: 'Russian', match: /\b(rus(?:sian)?|ru)\b/i },
  { code: 'ja', iso2: 'jpn', name: 'Japanese', match: /\b(jap(?:anese)?|jpn|ja|dual.?audio)\b/i },
  { code: 'ko', iso2: 'kor', name: 'Korean', match: /\b(kor(?:ean)?|ko)\b/i },
  { code: 'zh', iso2: 'chi', name: 'Chinese', match: /\b(chi(?:nese)?|zho|zh|mandarin|cantonese)\b/i },
  { code: 'hi', iso2: 'hin', name: 'Hindi', match: /\b(hin(?:di)?|hi)\b/i },
  { code: 'ar', iso2: 'ara', name: 'Arabic', match: /\b(ara(?:bic)?|ar)\b/i },
  { code: 'tr', iso2: 'tur', name: 'Turkish', match: /\b(tur(?:kish)?|tr)\b/i },
  { code: 'sv', iso2: 'swe', name: 'Swedish', match: /\b(swe(?:dish)?|sv)\b/i },
  { code: 'da', iso2: 'dan', name: 'Danish', match: /\b(dan(?:ish)?|da)\b/i },
  { code: 'no', iso2: 'nor', name: 'Norwegian', match: /\b(nor(?:wegian)?|nb|no)\b/i },
  { code: 'fi', iso2: 'fin', name: 'Finnish', match: /\b(fin(?:nish)?|fi)\b/i },
  { code: 'cs', iso2: 'cze', name: 'Czech', match: /\b(cze(?:ch)?|ces|cs)\b/i },
  { code: 'el', iso2: 'gre', name: 'Greek', match: /\b(gre(?:ek)?|ell|el)\b/i },
  { code: 'he', iso2: 'heb', name: 'Hebrew', match: /\b(heb(?:rew)?|he|iw)\b/i },
  { code: 'th', iso2: 'tha', name: 'Thai', match: /\b(tha(?:i)?|th)\b/i },
  { code: 'vi', iso2: 'vie', name: 'Vietnamese', match: /\b(vie(?:tnamese)?|vi)\b/i },
];

// Sent to the client so the settings sheet doesn't hard-code a second list.
export const options = LANGUAGES.map(({ code, name }) => ({ code, name }));

export function find(code) {
  if (!code) return null;
  const wanted = String(code).toLowerCase().split('-')[0];
  return LANGUAGES.find((l) => l.code === wanted || l.iso2 === wanted) || null;
}

// VLC wants 639-2/B on audio-language and sub-language.
export function toVlc(code) {
  return find(code)?.iso2 || null;
}

export function nameOf(code) {
  return find(code)?.name || null;
}

// Does a subtitle entry's `lang` refer to this language? Addons are
// inconsistent — "en", "eng", "English", "pt-BR" all turn up.
export function subtitleMatches(subLang, code) {
  const target = find(code);
  if (!target) return false;
  const value = String(subLang || '').toLowerCase().trim();
  if (!value) return false;
  return value === target.code
    || value === target.iso2
    || value.split('-')[0] === target.code
    || value === target.name.toLowerCase();
}

// Does a track's language tag (from inside a file: "eng", "fra", "deu",
// "en-US", "English") mean this language? Files use both 639-2 forms — /B
// ("fre", "ger") and /T ("fra", "deu") — so the name pattern is the fallback.
export function trackMatches(trackLang, code) {
  if (subtitleMatches(trackLang, code)) return true;
  const target = LANGUAGES.find((l) => l.code === String(code || '').toLowerCase().split('-')[0]);
  const value = String(trackLang || '').trim();
  return Boolean(target && value && target.match.test(value));
}

// Release names carry language hints in free text — "MULTi", "VOSTFR",
// "Dual Audio", "[Latino]". This is a hint, not a guarantee, so callers use it
// to rank streams rather than to filter them out.
export function streamMentions(text, code) {
  const target = find(code);
  if (!target || !text) return false;
  return target.match.test(String(text));
}
