/**
 * Zero-cost Indic script detection, numeral formatting, and automated Marathi transliteration.
 *
 * Designed specifically for waiting room displays and patient-facing screens:
 * - Comprehensive curated medical, hospital, clinic, speciality, title, and reason dictionary so compound
 *   terms (e.g. "Multi-Speciality Hospital", "Dr. Ramesh Patil", "Orthopedic Care") are translated with 100%
 *   precision rather than phonetic distortion (preventing blunders like "मुलतीस्पेसिलीटी" or "दर").
 * - Multi-word phrase regex matcher + token normalizer.
 * - In-memory LRU caching so repeated names / 10s TV refreshes incur 0ms latency & 0 API cost.
 * - Detects already-Devanagari text to skip redundant operations immediately.
 * - Localized Devanagari numerals and time formats.
 */

/** Check if text contains Devanagari Unicode characters (Marathi / Hindi / Sanskrit). */
export function isDevanagari(text: string): boolean {
  if (!text) return false;
  return /[\u0900-\u097F]/.test(text);
}

/**
 * Converts Western Arabic digits (0-9) to Marathi / Devanagari numerals (०-९).
 * e.g., 14 -> "१४", "Token #5" -> "Token #५"
 */
export function toDevanagariNumerals(value: number | string): string {
  if (value === null || value === undefined) return '';
  const devanagariDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  return String(value).replace(/[0-9]/g, (digit) => devanagariDigits[Number(digit)] ?? digit);
}

const MEMORY_CACHE = new Map<string, string>();
const MAX_CACHE_SIZE = 5000;

/** Multi-word phrases & compound words mapped directly to verified Marathi terminology. */
const PHRASE_DICTIONARY: [RegExp, string][] = [
  // Multi-speciality & Super-speciality variations
  [/\bmulti[-\s]?speciali?ty\s+hospital\b/gi, 'मल्टीस्पेशालिटी हॉस्पिटल'],
  [/\bsuper[-\s]?speciali?ty\s+hospital\b/gi, 'सुपरस्पेशालिटी हॉस्पिटल'],
  [/\bmulti[-\s]?speciali?ty\s+clinic\b/gi, 'मल्टीस्पेशालिटी क्लिनिक'],
  [/\bsuper[-\s]?speciali?ty\s+clinic\b/gi, 'सुपरस्पेशालिटी क्लिनिक'],
  [/\bmulti[-\s]?speciali?ty\b/gi, 'मल्टीस्पेशालिटी'],
  [/\bsuper[-\s]?speciali?ty\b/gi, 'सुपरस्पेशालिटी'],
  [/\bmulti[-\s]?specialty\b/gi, 'मल्टीस्पेशालिटी'],
  [/\bsuper[-\s]?specialty\b/gi, 'सुपरस्पेशालिटी'],

  // Hospital & Facility Types
  [/\bgeneral\s+hospital\b/gi, 'जनरल हॉस्पिटल'],
  [/\bchildren(?:'s)?\s+hospital\b/gi, 'बाल रुग्णालय'],
  [/\bpediatric\s+(?:hospital|clinic)\b/gi, 'बाल रुग्णालय'],
  [/\bmaternity\s+(?:home|hospital)\b/gi, 'मॅटर्निटी हॉस्पिटल'],
  [/\beye\s+(?:hospital|clinic|care)\b/gi, 'नेत्र रुग्णालय'],
  [/\bdental\s+(?:hospital|clinic|care)\b/gi, 'दंत चिकित्सालय'],
  [/\bheart\s+(?:hospital|clinic|care|institute)\b/gi, 'हृदयरोग रुग्णालय'],
  [/\bnursing\s+home\b/gi, 'नर्सिंग होम'],
  [/\bdiagnostic\s+cent(?:er|re)\b/gi, 'डायग्नोस्टिक सेंटर'],
  [/\bpathology\s+lab(?:oratory)?\b/gi, 'पॅथॉलॉजी लॅब'],
  [/\bresearch\s+cent(?:er|re)\b/gi, 'संशोधन केंद्र'],
  [/\bhealth\s*care\b/gi, 'हेल्थकेअर'],
  [/\blife\s*care\b/gi, 'लाइफकेअर'],
  [/\bmedi\s*care\b/gi, 'मेडिकेअर'],
  [/\bortho\s*care\b/gi, 'ऑर्थोकेअर'],
  [/\bskin\s*care\b/gi, 'स्किनकेअर'],
  [/\bday\s*care\b/gi, 'डेकेअर'],
  [/\bcritical\s*care\b/gi, 'क्रिटिकल केअर'],
  [/\bemergency\s+care\b/gi, 'तातडीची वैद्यकीय सेवा'],
  [/\bintensive\s+care\s+unit\b/gi, 'अतिदक्षता विभाग (ICU)'],
  [/\boperation\s+theat(?:er|re)\b/gi, 'ऑपरेशन थिएटर'],

  // Branches & Locations
  [/\bmain\s+branch\b/gi, 'मुख्य शाखा'],
  [/\bcity\s+branch\b/gi, 'शहर शाखा'],
  [/\bground\s+floor\b/gi, 'तळमजला'],
  [/\bfirst\s+floor\b/gi, 'पहिला मजला'],
  [/\bsecond\s+floor\b/gi, 'दुसरा मजला'],
  [/\bthird\s+floor\b/gi, 'तिसरा मजला'],

  // Reasons / Pause Status
  [/\blunch\s+break\b/gi, 'दुपारचे जेवण'],
  [/\btea\s+break\b/gi, 'चहाची सुट्टी'],
  [/\bdinner\s+break\b/gi, 'रात्रीचे जेवण'],
  [/\bward\s+rounds?\b/gi, 'वॉर्ड राऊंड'],
  [/\bin\s+surgery\b/gi, 'शस्त्रक्रिया चालू'],
  [/\bin\s+(?:ot|operation\s+theat(?:er|re))\b/gi, 'ऑपरेशन थिएटरमध्ये'],
  [/\bemergency\s+patient\b/gi, 'तातडीचा रुग्ण (इमर्जन्सी)'],
  [/\bemergency\s+call\b/gi, 'तातडीचा कॉल (इमर्जन्सी)'],
  [/\bshort\s+break\b/gi, 'अल्पोपहार / विश्रांती'],
  [/\bpersonal\s+(?:work|break)\b/gi, 'वैयक्तिक काम'],

  // Titles & Honorifics (with punctuation & spacing normalized)
  [/\bdr\.(?=\s|$)/gi, 'डॉ.'],
  [/\bdr\b(?!\.)/gi, 'डॉ.'],
  [/\bdoctor\b/gi, 'डॉक्टर'],
  [/\bmr\.(?=\s|$)/gi, 'श्री.'],
  [/\bmr\b(?!\.)/gi, 'श्री.'],
  [/\bmrs\.(?=\s|$)/gi, 'सौ.'],
  [/\bmrs\b(?!\.)/gi, 'सौ.'],
  [/\bms\.(?=\s|$)/gi, 'कु.'],
  [/\bms\b(?!\.)/gi, 'कु.'],
  [/\bshri\.?(?=\s|$)/gi, 'श्री.'],
  [/\bsmt\.?(?=\s|$)/gi, 'श्रीमती'],
  [/\bprof\.(?=\s|$)/gi, 'प्रा.'],
  [/\bprof\b(?!\.)/gi, 'प्रा.'],
  [/\bprofessor\b/gi, 'प्राध्यापक'],
];

/** Single-word terms & common names mapped to accurate Marathi translations. */
const WORD_DICTIONARY: Record<string, string> = {
  // Facility & Specialities
  multi: 'मल्टी',
  multispeciality: 'मल्टीस्पेशालिटी',
  multispecialty: 'मल्टीस्पेशालिटी',
  'multi-speciality': 'मल्टीस्पेशालिटी',
  'multi-specialty': 'मल्टीस्पेशालिटी',
  super: 'सुपर',
  superspeciality: 'सुपरस्पेशालिटी',
  superspecialty: 'सुपरस्पेशालिटी',
  'super-speciality': 'सुपरस्पेशालिटी',
  speciality: 'स्पेशालिटी',
  specialty: 'स्पेशालिटी',
  hospital: 'हॉस्पिटल',
  hospitals: 'हॉस्पिटल',
  clinic: 'क्लिनिक',
  clinics: 'क्लिनिक',
  dispensary: 'दवाखाना',
  healthcare: 'हेल्थकेअर',
  health: 'हेल्थ',
  care: 'केअर',
  cure: 'क्युर',
  life: 'लाइफ',
  lifecare: 'लाइफकेअर',
  medical: 'मेडिकल',
  medicare: 'मेडिकेअर',
  center: 'सेंटर',
  centre: 'सेंटर',
  institute: 'इन्स्टिट्यूट',
  institution: 'इन्स्टिट्यूट',
  foundation: 'फाउंडेशन',
  trust: 'ट्रस्ट',
  maternity: 'मॅटर्निटी',
  nursing: 'नर्सिंग',
  ortho: 'ऑर्थो',
  orthopedic: 'ऑर्थोपेडिक',
  orthopaedics: 'ऑर्थोपेडिक्स',
  orthopaedic: 'ऑर्थोपेडिक',
  pediatric: 'पीडियाट्रिक',
  paediatric: 'पीडियाट्रिक',
  pediatrics: 'पीडियाट्रिक्स',
  paediatrics: 'पीडियाट्रिक्स',
  cardiac: 'कार्डियाक',
  cardiology: 'कार्डिओलॉजी',
  cardiologist: 'हृदयरोगतज्ज्ञ',
  neurology: 'न्यूरोलॉजी',
  neurologist: 'न्यूरोलॉजिस्ट',
  oncology: 'ऑन्कोलॉजी',
  oncologist: 'कॅन्सरतज्ज्ञ',
  urology: 'युरॉलॉजी',
  urologist: 'मूत्ररोगतज्ज्ञ',
  nephrology: 'नेफ्रॉलॉजी',
  nephrologist: 'नेफ्रॉलॉजिस्ट',
  gynecology: 'स्त्रीरोग',
  gynaecology: 'स्त्रीरोग',
  gynecologist: 'स्त्रीरोगतज्ज्ञ',
  gynaecologist: 'स्त्रीरोगतज्ज्ञ',
  dermatology: 'त्वचारोग',
  dermatologist: 'त्वचारोगतज्ज्ञ',
  skin: 'स्किन',
  dental: 'डेंटल',
  dentist: 'दंतचिकित्सक',
  dentistry: 'दंतचिकित्सा',
  eye: 'नेत्र',
  ophthalmology: 'नेत्ररोग',
  ophthalmologist: 'नेत्ररोगतज्ज्ञ',
  ent: 'ई.एन.टी.',
  general: 'जनरल',
  physician: 'फिजिशियन',
  surgeon: 'सर्जन',
  consultant: 'कन्सल्टंट',
  specialist: 'तज्ज्ञ',
  surgery: 'सर्जरी',
  surgical: 'सर्जिकल',
  trauma: 'ट्रॉमा',
  emergency: 'इमर्जन्सी',
  casualty: 'कॅज्युअल्टी',
  critical: 'क्रिटिकल',
  icu: 'आयसीयू',
  nicu: 'एनआयसीयू',
  picu: 'पीआयसीयू',
  opd: 'ओपीडी',
  ipd: 'आयपीडी',
  lab: 'लॅब',
  labs: 'लॅब',
  laboratory: 'लॅब',
  pathology: 'पॅथॉलॉजी',
  radiology: 'रेडिओलॉजी',
  ayurvedic: 'आयुर्वेदिक',
  ayurveda: 'आयुर्वेद',
  homeopathic: 'होमिओपॅथिक',
  homeopathy: 'होमिओपॅथी',
  branch: 'शाखा',
  wing: 'विभाग',
  room: 'खोली',
  cabin: 'केबिन',
  counter: 'काउंटर',
  floor: 'मजला',
  break: 'विश्रांती',
  lunch: 'दुपारचे जेवण',
  tea: 'चहा',
  dinner: 'रात्रीचे जेवण',
  round: 'वॉर्ड राऊंड',
  rounds: 'वॉर्ड राऊंड',
  meeting: 'बैठक',
  personal: 'वैयक्तिक',

  // Titles & Qualifications
  dr: 'डॉ.',
  'dr.': 'डॉ.',
  doctor: 'डॉक्टर',
  mr: 'श्री.',
  'mr.': 'श्री.',
  mrs: 'सौ.',
  'mrs.': 'सौ.',
  ms: 'कु.',
  'ms.': 'कु.',
  miss: 'कु.',
  shri: 'श्री.',
  smt: 'श्रीमती',
  prof: 'प्रा.',
  'prof.': 'प्रा.',
  professor: 'प्राध्यापक',
  mbbs: 'एम.बी.बी.एस.',
  md: 'एम.डी.',
  ms_: 'एम.एस.',
  bams: 'बी.ए.एम.एस.',
  bhms: 'बी.एच.एम.एस.',
  bds: 'बी.डी.एस.',
  mds: 'एम.डी.एस.',
  dnb: 'डी.एन.बी.',
  dm: 'डी.एम.',
  mch: 'एम.सी.एच.',

  // Top Indian / Marathi Surnames for instantaneous accurate offline translation
  patil: 'पाटील',
  shinde: 'शिंदे',
  pawar: 'पवार',
  kulkarni: 'कुलकर्णी',
  deshmukh: 'देशमुख',
  joshi: 'जोशी',
  jadhav: 'जाधव',
  more: 'मोरे',
  kale: 'काळे',
  gaikwad: 'गायकवाड',
  chavan: 'चव्हाण',
  sharma: 'शर्मा',
  verma: 'वर्मा',
  gupta: 'गुप्ता',
  shah: 'शहा',
  mehta: 'मेहता',
  tamboli: 'तांबोळी',
  dhangar: 'धनगर',
  bhosale: 'भोसले',
  salunkhe: 'साळुंखे',
  ghadge: 'घाडगे',
  mohite: 'मोहिते',
  mane: 'माने',
  shirke: 'शिर्के',
  sawant: 'सावंत',
  wagh: 'वाघ',
  giri: 'गिरी',
  sawarkar: 'सावरकर',
  thorat: 'थोरात',
  shelar: 'शेलार',
  khanna: 'खन्ना',
  singh: 'सिंग',
  kumar: 'कुमार',
  shetty: 'शेट्टी',
  kamble: 'कांबळे',
  kadam: 'कदम',
  raut: 'राऊत',
  gawande: 'गवांदे',
  bhatt: 'भट',
  patel: 'पटेल',

  // Top Indian / Marathi First Names
  rahul: 'राहुल',
  amit: 'अमित',
  ramesh: 'रमेश',
  suresh: 'सुरेश',
  ganesh: 'गणेश',
  mahesh: 'महेश',
  ajay: 'अजय',
  vijay: 'विजय',
  sanjay: 'संजय',
  sunil: 'सुनील',
  anil: 'अनिल',
  prashant: 'प्रशांत',
  sachin: 'सचिन',
  nitin: 'नितीन',
  priya: 'प्रिया',
  pooja: 'पूजा',
  neha: 'नेहा',
  sneha: 'स्नेहा',
  anita: 'अनिता',
  sunita: 'सुनिता',
  kavita: 'कविता',
  swati: 'स्वाती',
  archana: 'अर्चना',
  smita: 'स्मिता',
  priti: 'प्रीती',
  om: 'ओम',
  rohit: 'रोहित',
  vikram: 'विक्रम',
  deepak: 'दीपक',
  rajesh: 'राजेश',
  ashok: 'अशोक',
  akash: 'आकाश',
  santosh: 'संतोष',
  vishal: 'विशाल',
  chetan: 'चेतन',
  kiran: 'किरण',
};

/**
 * Fetch raw Indic transliteration for a single name word from Google Input Tools API.
 */
async function fetchWordTransliteration(word: string): Promise<string> {
  if (!word || isDevanagari(word)) return word;

  const lower = word.toLowerCase();
  if (WORD_DICTIONARY[lower]) {
    return WORD_DICTIONARY[lower];
  }

  if (MEMORY_CACHE.has(word)) {
    return MEMORY_CACHE.get(word)!;
  }

  try {
    const url = `https://inputtools.google.com/request?text=${encodeURIComponent(word)}&itc=mr-t-i0-und&num=1`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'HospitalAutomation-QueueCare/1.0' },
      signal: AbortSignal.timeout(2500),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data[0] === 'SUCCESS' && Array.isArray(data[1])) {
        const item = data[1][0];
        if (Array.isArray(item) && Array.isArray(item[1]) && item[1].length > 0) {
          const result = String(item[1][0]).trim();
          if (result) {
            MEMORY_CACHE.set(word, result);
            return result;
          }
        }
      }
    }
  } catch {
    // If offline or network error, return word as is
  }

  return word;
}

/**
 * Automatically translates/transliterates English text (doctor names, patient names, hospital names,
 * branch names, and reasons) into accurate, professional Marathi (Devanagari).
 *
 * 1. Returns immediately if text is already in Devanagari.
 * 2. Matches medical & hospital phrases (e.g. "Multispeciality Hospital" -> "मल्टीस्पेशालिटी हॉस्पिटल").
 * 3. Tokenizes words to check dictionary for titles (Dr. -> डॉ.) and clinic terms.
 * 4. Transliterates proper names (e.g. "Ramesh", "Patil", "Sunrise") via Indic phonetic engine.
 * 5. Sanitizes punctuation and caches results in memory for zero-latency 10s TV refreshes.
 */
export async function transliterateToMarathi(text: string): Promise<string> {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  // If already Devanagari, skip completely
  if (isDevanagari(trimmed) && !/[a-zA-Z]/.test(trimmed)) {
    return trimmed;
  }

  // Check cache for full string
  if (MEMORY_CACHE.has(trimmed)) {
    return MEMORY_CACHE.get(trimmed)!;
  }

  // Step 1: Replace known multi-word phrases and compound words first
  let processed = trimmed;
  for (const [regex, replacement] of PHRASE_DICTIONARY) {
    processed = processed.replace(regex, replacement);
  }

  // If the entire string became Devanagari after phrase matching, clean up and return
  if (isDevanagari(processed) && !/[a-zA-Z]/.test(processed)) {
    const cleaned = cleanOutput(processed);
    MEMORY_CACHE.set(trimmed, cleaned);
    return cleaned;
  }

  // Step 2: Tokenize words and non-words (preserving spaces and punctuation)
  const tokens = processed.split(/([a-zA-Z0-9\u0900-\u097F]+)/);

  const translatedTokens = await Promise.all(
    tokens.map(async (token) => {
      // If empty, whitespace, punctuation or symbols, leave untouched
      if (!token || !/[a-zA-Z]/.test(token)) {
        return token;
      }

      const lower = token.toLowerCase();

      // Check single-word dictionary
      if (WORD_DICTIONARY[lower]) {
        return WORD_DICTIONARY[lower];
      }

      // Check dictionary without trailing dot (e.g. "Dr." -> "dr")
      const strippedDot = lower.replace(/\.$/, '');
      if (WORD_DICTIONARY[strippedDot]) {
        return WORD_DICTIONARY[strippedDot];
      }

      // Transliterate proper name token
      return fetchWordTransliteration(token);
    }),
  );

  const finalResult = cleanOutput(translatedTokens.join(''));

  if (MEMORY_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = MEMORY_CACHE.keys().next().value;
    if (firstKey) MEMORY_CACHE.delete(firstKey);
  }
  MEMORY_CACHE.set(trimmed, finalResult);

  return finalResult;
}

/** Sanitizes artifact punctuation such as double dots (डॉ..) and extraneous spaces. */
function cleanOutput(str: string): string {
  return str
    .replace(/(\u0964|\.)\./g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/डॉ\.\s*\./g, 'डॉ.')
    .replace(/श्री\.\s*\./g, 'श्री.')
    .replace(/सौ\.\s*\./g, 'सौ.')
    .replace(/कु\.\s*\./g, 'कु.')
    .replace(/प्रा\.\s*\./g, 'प्रा.')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Transliterates an array of names concurrently with cache protection. */
export async function transliterateNamesBatch(names: (string | null | undefined)[]): Promise<Map<string, string>> {
  const resultMap = new Map<string, string>();
  const uniqueNames = Array.from(new Set(names.filter((n): n is string => Boolean(n && n.trim()))));

  await Promise.all(
    uniqueNames.map(async (name) => {
      const converted = await transliterateToMarathi(name);
      resultMap.set(name, converted);
    }),
  );

  return resultMap;
}
