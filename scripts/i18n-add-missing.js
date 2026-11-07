#!/usr/bin/env node
// Adds missing keys (present in en.js but absent from non-English files) to all language packs.
// Machine-drafted translations are provided; each is marked with an inline comment.
// Usage: node scripts/i18n-add-missing.js [--dry-run]

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const DRY = process.argv.includes('--dry-run');

// Keys to add, grouped by namespace prefix, with translations per language.
// reviewed: false — machine-drafted; native-speaker review pending.
const MISSING = {
  'cpool.academy_buses': {
    hi: 'अकादमी बसें', mr: 'अकादमी बसेस', ta: 'அகாடமி பேருந்துகள்',
    te: 'అకాడమీ బస్సులు', ml: 'അക്കാദമി ബസ്സുകൾ', kn: 'ಅಕಾಡೆಮಿ ಬಸ್ಸುಗಳು',
    bn: 'একাডেমি বাসগুলি', or: 'ଆକାଡେମୀ ବସ', si: 'ඇකඩමි බස් රථ',
    ur: 'اکیڈمی بسیں', id: 'Bus Akademi',
  },
  'cpool.all_transport': {
    hi: 'सभी परिवहन', mr: 'सर्व वाहतूक', ta: 'அனைத்து போக்குவரத்தும்',
    te: 'అన్ని రవాణా', ml: 'എല്ലാ ഗതാഗതവും', kn: 'ಎಲ್ಲಾ ಸಾರಿಗೆ',
    bn: 'সমস্ত পরিবহন', or: 'ସମସ୍ତ ପରିବହନ', si: 'සියලු ප්‍රවාහන',
    ur: 'تمام ٹرانسپورٹ', id: 'Semua Transportasi',
  },
  'cpool.private': {
    hi: 'निजी कारपूल', mr: 'खाजगी कारपूल', ta: 'தனியார் கார்பூல்கள்',
    te: 'ప్రైవేట్ కార్‌పూల్స్', ml: 'സ്വകാര്യ കാർ‌പൂളുകൾ', kn: 'ಖಾಸಗಿ ಕಾರ್‌ಪೂಲ್‌ಗಳು',
    bn: 'ব্যক্তিগত কার্পুল', or: 'ବ୍ୟକ୍ତିଗତ କାର୍‌ପୁଲ', si: 'පෞද්ගලික කාර්‌පූල',
    ur: 'نجی کارپول', id: 'Carpool Pribadi',
  },
  'gob.academic': {
    hi: 'शैक्षणिक कार्यक्रम', mr: 'शैक्षणिक वेळापत्रक', ta: 'கல்வி அட்டவணை',
    te: 'విద్యా వేళాపట్టిక', ml: 'അക്കാദമിക് ഷെഡ്യൂൾ', kn: 'ಶೈಕ್ಷಣಿಕ ವೇಳಾಪಟ್ಟಿ',
    bn: 'শিক্ষামূলক সময়সূচি', or: 'ଶୈକ୍ଷଣିକ ତାଲିକା', si: 'ශාස්ත්‍රීය කාලසටහන',
    ur: 'تعلیمی شیڈول', id: 'Jadwal Akademik',
  },
  'gob.biometrics': {
    hi: 'स्पोर्ट साइंस', mr: 'क्रीडा विज्ञान', ta: 'விளையாட்டு அறிவியல்',
    te: 'స్పోర్ట్ సైన్స్', ml: 'സ്‌പോർട്ട് സയൻസ്', kn: 'ಕ್ರೀಡಾ ವಿಜ್ಞಾನ',
    bn: 'স্পোর্ট সায়েন্স', or: 'ଖେଳ ବିଜ୍ଞାନ', si: 'ක්‍රීඩා විද්‍යාව',
    ur: 'سپورٹ سائنس', id: 'Sains Olahraga',
  },
  'gob.independent_in': {
    hi: '{years} वर्ष में स्वतंत्र', mr: '{years} वर्षांत स्वतंत्र',
    ta: '{years} ஆண்டுகளில் சுதந்திரம்', te: '{years} సంవత్సరాలలో స్వతంత్రం',
    ml: '{years} വർഷത്തിൽ സ്വതന്ത്രൻ', kn: '{years} ವರ್ಷಗಳಲ್ಲಿ ಸ್ವತಂತ್ರ',
    bn: '{years} বছরে স্বাধীন', or: '{years} ବର୍ଷ ଭିତରେ ସ୍ୱତନ୍ତ୍ର',
    si: '{years} වසරෙන් ස්වාධීන', ur: '{years} سالوں میں آزاد',
    id: 'Mandiri dalam {years} tahun',
  },
  'gob.jurisdiction': {
    hi: '{jurisdiction} क्षेत्राधिकार', mr: '{jurisdiction} अधिकारक्षेत्र',
    ta: '{jurisdiction} அதிகார வரம்பு', te: '{jurisdiction} అధికార పరిధి',
    ml: '{jurisdiction} അധികാര പരിധി', kn: '{jurisdiction} ನ್ಯಾಯವ್ಯಾಪ್ತಿ',
    bn: '{jurisdiction} অধিক্ষেত্র', or: '{jurisdiction} ନ୍ୟାୟ ଏଲାକା',
    si: '{jurisdiction} බලහිමිකම', ur: '{jurisdiction} دائرہ اختیار',
    id: 'Yurisdiksi {jurisdiction}',
  },
  'gob.wingspan': {
    hi: 'विंगस्पैन (सेमी)', mr: 'विंगस्पॅन (सेमी)', ta: 'இறக்கை நீளம் (செமீ)',
    te: 'వింగ్‌స్పాన్ (సెం.మీ.)', ml: 'ചിറക് നീളം (സെ.മീ.)', kn: 'ವಿಂಗ್‌ಸ್ಪ್ಯಾನ್ (ಸೆ.ಮೀ.)',
    bn: 'উইংস্প্যান (সেমি)', or: 'ୱିଂ ବ୍ୟାପ୍ତି (ସେ.ମି.)', si: 'පියාපත් දිග (සෙ.මී.)',
    ur: 'ونگ اسپین (سینٹی میٹر)', id: 'Lebar Sayap (cm)',
  },
  'sh.child_scored': {
    hi: '{name} ने {min}वें मिनट में गोल किया!',
    mr: '{name} ने {min}व्या मिनिटात गोल केला!',
    ta: '{name} {min}வது நிமிடத்தில் கோல் அடித்தார்!',
    te: '{name} {min}వ నిమిషంలో గోల్ చేశారు!',
    ml: '{name} {min}-ാം മിനിട്ടിൽ ഗോൾ നേടി!',
    kn: '{name} {min}ನೇ ನಿಮಿಷದಲ್ಲಿ ಗೋಲ್ ಮಾಡಿದರು!',
    bn: '{name} {min}তম মিনিটে গোল করেছে!',
    or: '{name} {min}ମ ମିନିଟ୍‌ରେ ଗୋଲ ଦେଲେ!',
    si: '{name} {min}වන මිනිත්තුවේ ගෝල් කළා!',
    ur: '{name} نے {min}ویں منٹ میں گول کیا!',
    id: '{name} mencetak gol menit ke-{min}!',
  },
  'sh.clip_note': {
    hi: 'यह पल शेयर करें — लिंक इस टाइमस्टैम्प पर खुलेगा।',
    mr: 'हा क्षण शेअर करा — लिंक या टाइमस्टॅम्पवर उघडेल।',
    ta: 'இந்த தருணத்தை பகிரவும் — இணைப்பு இந்த நேரத்தில் திறக்கும்.',
    te: 'ఈ క్షణాన్ని పంచుకోండి — లింక్ ఈ టైమ్‌స్టాంప్‌లో తెరుచుకుంటుంది.',
    ml: 'ഈ നിമിഷം ഷെയർ ചെയ്യൂ — ലിങ്ക് ഈ ടൈംസ്റ്റാമ്പിൽ തുറക്കും.',
    kn: 'ಈ ಕ್ಷಣ ಹಂಚಿಕೊಳ್ಳಿ — ಲಿಂಕ್ ಈ ಟೈಮ್‌ಸ್ಟ್ಯಾಂಪ್‌ನಲ್ಲಿ ತೆರೆಯುತ್ತದೆ.',
    bn: 'এই মুহূর্তটি শেয়ার করুন — লিংক এই টাইমস্ট্যাম্পে খুলবে।',
    or: 'ଏହି ମୁହୂର୍ତ ଶେୟାର କରନ୍ତୁ — ଲିଂକ ଏହି ଟାଇମଷ୍ଟ୍ୟାମ୍ପ ରେ ଖୋଲିବ।',
    si: 'මෙම මොහොත බෙදාගන්න — සබැඳිය මෙම කාල මුද්‍රාවේ විවෘත වේ.',
    ur: 'یہ لمحہ شیئر کریں — لنک اس ٹائم اسٹیمپ پر کھلے گا۔',
    id: 'Bagikan momen ini — tautan terbuka di timestamp ini.',
  },
  'tjl.referrals_sub': {
    hi: '{total} शामिल हुए · {referrer} ने {count} लाए',
    mr: '{total} सामील झाले · {referrer} ने {count} आणले',
    ta: '{total} சேர்ந்தனர் · {referrer} {count} பேரை அழைத்தனர்',
    te: '{total} చేరారు · {referrer} {count} తెచ్చారు',
    ml: '{total} ചേർന്നു · {referrer} {count} കൊണ്ടുവന്നു',
    kn: '{total} ಸೇರಿದರು · {referrer} {count} ತಂದರು',
    bn: '{total} যোগ দিয়েছে · {referrer} {count} জন এনেছে',
    or: '{total} ଯୋଗ ଦେଲେ · {referrer} {count} ଆଣିଲେ',
    si: '{total} යෙදුනු · {referrer} {count} ගෙනාවා',
    ur: '{total} شامل ہوئے · {referrer} نے {count} لائے',
    id: '{total} bergabung · {referrer} membawa {count}',
  },
};

// Extra key to add: nav.title.ManagedChildrenList (exists in non-English files, not in en.js)
// We handle en.js separately via en-add-missing.js step.

const LANGS = ['hi', 'mr', 'ta', 'te', 'ml', 'kn', 'bn', 'or', 'si', 'ur', 'id'];

function addMissing(code) {
  const file = resolve(root, 'apps/app/src/i18n', `${code}.js`);
  const src = readFileSync(file, 'utf8');

  // Check which keys are already present
  const toAdd = Object.entries(MISSING).filter(([key]) => !src.includes(`'${key}'`));
  if (toAdd.length === 0) {
    console.log(`${code}: all keys already present`);
    return;
  }

  // Build the block to append (before the final `};`)
  const lines = toAdd.map(([key, translations]) => {
    const val = translations[code];
    return `  '${key}': '${val.replace(/'/g, "\\'")}', // machine-drafted`;
  });

  const block = '\n  // Missing keys added by i18n-add-missing.js\n' + lines.join('\n') + '\n';

  const insertAt = src.lastIndexOf('};');
  const newSrc = src.slice(0, insertAt) + block + src.slice(insertAt);

  if (!DRY) {
    writeFileSync(file, newSrc, 'utf8');
  }
  console.log(`${code}: added ${toAdd.length} key${toAdd.length === 1 ? '' : 's'}${DRY ? ' (dry run)' : ''}: ${toAdd.map(([k]) => k).join(', ')}`);
}

for (const code of LANGS) addMissing(code);
