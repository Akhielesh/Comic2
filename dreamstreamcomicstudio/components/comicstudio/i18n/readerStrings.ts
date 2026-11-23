// Reader chrome strings in every supported language (i18n.md §11.2). Owner: P1-I18N.
//
// The ONLY app-chrome localization in scope: what a reader of a translated edition sees around the
// pages (layout names, page turns, full screen, the language picker, the end card). A static table,
// committed for native-speaker review; anything missing falls back to English. `{n}` / `{total}`
// are interpolated; numbers stay in Western digits (the comic's own page numbers).

import { languageSpec } from '../../../shared/comic/languages';

export type ReaderStringKey =
  | 'pageTurnHelp'
  | 'scrollHelp'
  | 'pageTurn'
  | 'singlePage'
  | 'facingPages'
  | 'scroll'
  | 'page'
  | 'spread'
  | 'theEnd'
  | 'previousPage'
  | 'nextPage'
  | 'fullScreen'
  | 'exitFullScreen'
  | 'language'
  | 'original'
  | 'readsRightToLeft'
  | 'untranslatedLines'
  | 'translatedPercent'
  | 'close'
  | 'chooseLanguage'
  | 'cover'
  | 'pageOf'
  | 'download'
  | 'share'
  | 'guidedView'
  | 'settings'
  | 'startReading'
  | 'readAgain';

export type ReaderStrings = Record<ReaderStringKey, string>;

const EN: ReaderStrings = {
  pageTurnHelp: 'Drag a page edge or use the arrows to turn pages.', scrollHelp: 'Scroll vertically through the comic.',
  pageTurn: 'Page turn', singlePage: 'Single page', facingPages: 'Facing pages',
  scroll: 'Scroll',
  page: 'Page',
  spread: 'Spread',
  theEnd: 'The end.',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  fullScreen: 'Full screen',
  exitFullScreen: 'Exit full screen',
  language: 'Language',
  original: 'Original',
  readsRightToLeft: 'Reads right to left',
  untranslatedLines: 'Not yet translated: {n}',
  translatedPercent: '{n}% translated',
  close: 'Close',
  chooseLanguage: 'Choose a language',
  cover: 'Cover',
  pageOf: 'Page {n} of {total}',
  download: 'Download',
  share: 'Share',
  guidedView: 'Guided View',
  settings: 'Settings',
  startReading: 'Start reading',
  readAgain: 'Read again'
};

const NNBSP = ' ';

export const READER_STRINGS: Readonly<Record<string, Partial<ReaderStrings>>> = {
  en: EN,
  hi: {
    pageTurnHelp: 'पन्ने का किनारा खींचें या तीरों से पन्ना पलटें।', scrollHelp: 'कॉमिक को ऊपर-नीचे स्क्रॉल करें।',
    pageTurn: 'पन्ना पलटें', singlePage: 'एक पन्ना', facingPages: 'आमने-सामने के पन्ने',
    scroll: 'स्क्रॉल', page: 'पेज', spread: 'दो पेज', theEnd: 'समाप्त।', previousPage: 'पिछला पेज', nextPage: 'अगला पेज',
    fullScreen: 'फ़ुल स्क्रीन', exitFullScreen: 'फ़ुल स्क्रीन बंद करें', language: 'भाषा', original: 'मूल',
    readsRightToLeft: 'दाएँ से बाएँ पढ़ें', untranslatedLines: 'अभी अनूदित नहीं: {n}', translatedPercent: '{n}% अनूदित',
    close: 'बंद करें', chooseLanguage: 'भाषा चुनें', cover: 'कवर', pageOf: 'पेज {n} / {total}', download: 'डाउनलोड',
    share: 'शेयर करें', guidedView: 'गाइडेड व्यू', settings: 'सेटिंग्स', startReading: 'पढ़ना शुरू करें', readAgain: 'फिर से पढ़ें'
  },
  te: {
    pageTurnHelp: 'పేజీ అంచును లాగండి లేదా బాణాలతో పేజీలు తిప్పండి.', scrollHelp: 'కామిక్‌ను నిలువుగా స్క్రోల్ చేయండి.',
    pageTurn: 'పేజీ తిప్పండి', singlePage: 'ఒక పేజీ', facingPages: 'ఎదురెదురు పేజీలు',
    scroll: 'స్క్రోల్', page: 'పేజీ', spread: 'రెండు పేజీలు', theEnd: 'సమాప్తం.', previousPage: 'మునుపటి పేజీ', nextPage: 'తదుపరి పేజీ',
    fullScreen: 'పూర్తి స్క్రీన్', exitFullScreen: 'పూర్తి స్క్రీన్ నుండి బయటకు', language: 'భాష', original: 'అసలు',
    readsRightToLeft: 'కుడి నుండి ఎడమకు చదవండి', untranslatedLines: 'ఇంకా అనువదించనివి: {n}', translatedPercent: '{n}% అనువదించబడింది',
    close: 'మూసివేయి', chooseLanguage: 'భాషను ఎంచుకోండి', cover: 'ముఖచిత్రం', pageOf: 'పేజీ {n} / {total}', download: 'డౌన్‌లోడ్',
    share: 'షేర్ చేయండి', guidedView: 'గైడెడ్ వ్యూ', settings: 'సెట్టింగ్‌లు', startReading: 'చదవడం మొదలుపెట్టండి', readAgain: 'మళ్ళీ చదవండి'
  },
  ta: {
    pageTurnHelp: 'பக்க ஓரத்தை இழுக்கவும் அல்லது அம்புகளைப் பயன்படுத்தவும்.', scrollHelp: 'காமிக்ஸை மேல்கீழாக உருட்டவும்.',
    pageTurn: 'பக்கம் திருப்பவும்', singlePage: 'ஒரு பக்கம்', facingPages: 'எதிரெதிர் பக்கங்கள்',
    scroll: 'ஸ்க்ரோல்', page: 'பக்கம்', spread: 'இரு பக்கங்கள்', theEnd: 'முற்றும்.', previousPage: 'முந்தைய பக்கம்', nextPage: 'அடுத்த பக்கம்',
    fullScreen: 'முழுத் திரை', exitFullScreen: 'முழுத் திரையிலிருந்து வெளியேறு', language: 'மொழி', original: 'மூலம்',
    readsRightToLeft: 'வலமிருந்து இடமாகப் படிக்கவும்', untranslatedLines: 'இன்னும் மொழிபெயர்க்கப்படாதவை: {n}', translatedPercent: '{n}% மொழிபெயர்க்கப்பட்டது',
    close: 'மூடு', chooseLanguage: 'மொழியைத் தேர்ந்தெடுக்கவும்', cover: 'அட்டைப்படம்', pageOf: 'பக்கம் {n} / {total}', download: 'பதிவிறக்கு',
    share: 'பகிர்', guidedView: 'வழிகாட்டும் பார்வை', settings: 'அமைப்புகள்', startReading: 'படிக்கத் தொடங்கு', readAgain: 'மீண்டும் படி'
  },
  kn: {
    pageTurnHelp: 'ಪುಟದ ಅಂಚನ್ನು ಎಳೆಯಿರಿ ಅಥವಾ ಬಾಣಗಳಿಂದ ಪುಟ ತಿರುಗಿಸಿ.', scrollHelp: 'ಕಾಮಿಕ್ ಅನ್ನು ಲಂಬವಾಗಿ ಸ್ಕ್ರಾಲ್ ಮಾಡಿ.',
    pageTurn: 'ಪುಟ ತಿರುಗಿಸಿ', singlePage: 'ಒಂದು ಪುಟ', facingPages: 'ಎದುರುಬದುರು ಪುಟಗಳು',
    scroll: 'ಸ್ಕ್ರೋಲ್', page: 'ಪುಟ', spread: 'ಎರಡು ಪುಟಗಳು', theEnd: 'ಮುಕ್ತಾಯ.', previousPage: 'ಹಿಂದಿನ ಪುಟ', nextPage: 'ಮುಂದಿನ ಪುಟ',
    fullScreen: 'ಪೂರ್ಣ ಪರದೆ', exitFullScreen: 'ಪೂರ್ಣ ಪರದೆಯಿಂದ ನಿರ್ಗಮಿಸಿ', language: 'ಭಾಷೆ', original: 'ಮೂಲ',
    readsRightToLeft: 'ಬಲದಿಂದ ಎಡಕ್ಕೆ ಓದಿ', untranslatedLines: 'ಇನ್ನೂ ಅನುವಾದವಾಗಿಲ್ಲ: {n}', translatedPercent: '{n}% ಅನುವಾದವಾಗಿದೆ',
    close: 'ಮುಚ್ಚಿ', chooseLanguage: 'ಭಾಷೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ', cover: 'ಮುಖಪುಟ', pageOf: 'ಪುಟ {n} / {total}', download: 'ಡೌನ್‌ಲೋಡ್',
    share: 'ಹಂಚಿಕೊಳ್ಳಿ', guidedView: 'ಮಾರ್ಗದರ್ಶಿ ವೀಕ್ಷಣೆ', settings: 'ಸೆಟ್ಟಿಂಗ್‌ಗಳು', startReading: 'ಓದಲು ಪ್ರಾರಂಭಿಸಿ', readAgain: 'ಮತ್ತೆ ಓದಿ'
  },
  ml: {
    pageTurnHelp: 'താളിന്റെ അരിക് വലിക്കുകയോ അമ്പുകൾ ഉപയോഗിക്കുകയോ ചെയ്യുക.', scrollHelp: 'കോമിക് വായിക്കാൻ മുകളിലേക്കും താഴേക്കും സ്ക്രോൾ ചെയ്യുക.',
    pageTurn: 'താൾ മറിക്കുക', singlePage: 'ഒറ്റ താൾ', facingPages: 'എതിർ താളുകൾ',
    scroll: 'സ്ക്രോൾ', page: 'പേജ്', spread: 'രണ്ട് പേജ്', theEnd: 'ശുഭം.', previousPage: 'മുമ്പത്തെ പേജ്', nextPage: 'അടുത്ത പേജ്',
    fullScreen: 'പൂർണ്ണ സ്ക്രീൻ', exitFullScreen: 'പൂർണ്ണ സ്ക്രീനിൽ നിന്ന് പുറത്തുകടക്കുക', language: 'ഭാഷ', original: 'മൂലം',
    readsRightToLeft: 'വലത്തുനിന്ന് ഇടത്തോട്ട് വായിക്കുക', untranslatedLines: 'ഇനിയും വിവർത്തനം ചെയ്യാത്തവ: {n}', translatedPercent: '{n}% വിവർത്തനം ചെയ്തു',
    close: 'അടയ്ക്കുക', chooseLanguage: 'ഭാഷ തിരഞ്ഞെടുക്കുക', cover: 'കവർ', pageOf: 'പേജ് {n} / {total}', download: 'ഡൗൺലോഡ്',
    share: 'പങ്കിടുക', guidedView: 'ഗൈഡഡ് വ്യൂ', settings: 'ക്രമീകരണങ്ങൾ', startReading: 'വായന തുടങ്ങുക', readAgain: 'വീണ്ടും വായിക്കുക'
  },
  mr: {
    pageTurnHelp: 'पानाची कड ओढा किंवा बाणांनी पान उलटा.', scrollHelp: 'कॉमिक वर-खाली स्क्रोल करा.',
    pageTurn: 'पान उलटा', singlePage: 'एक पान', facingPages: 'समोरासमोरची पाने',
    scroll: 'स्क्रोल', page: 'पान', spread: 'दोन पाने', theEnd: 'समाप्त.', previousPage: 'मागील पान', nextPage: 'पुढील पान',
    fullScreen: 'पूर्ण स्क्रीन', exitFullScreen: 'पूर्ण स्क्रीनमधून बाहेर पडा', language: 'भाषा', original: 'मूळ',
    readsRightToLeft: 'उजवीकडून डावीकडे वाचा', untranslatedLines: 'अजून अनुवाद न झालेल्या: {n}', translatedPercent: '{n}% अनुवादित',
    close: 'बंद करा', chooseLanguage: 'भाषा निवडा', cover: 'मुखपृष्ठ', pageOf: 'पान {n} / {total}', download: 'डाउनलोड',
    share: 'शेअर करा', guidedView: 'मार्गदर्शित दृश्य', settings: 'सेटिंग्ज', startReading: 'वाचायला सुरुवात करा', readAgain: 'पुन्हा वाचा'
  },
  bn: {
    pageTurnHelp: 'পাতার কিনারা টানুন বা তির দিয়ে পাতা উল্টান।', scrollHelp: 'কমিকটি ওপর-নিচে স্ক্রল করুন।',
    pageTurn: 'পাতা উল্টান', singlePage: 'একটি পাতা', facingPages: 'পাশাপাশি পাতা',
    scroll: 'স্ক্রল', page: 'পাতা', spread: 'দুই পাতা', theEnd: 'সমাপ্ত।', previousPage: 'আগের পাতা', nextPage: 'পরের পাতা',
    fullScreen: 'পূর্ণ স্ক্রিন', exitFullScreen: 'পূর্ণ স্ক্রিন থেকে বেরোন', language: 'ভাষা', original: 'মূল',
    readsRightToLeft: 'ডান থেকে বাঁয়ে পড়ুন', untranslatedLines: 'এখনও অনূদিত হয়নি: {n}', translatedPercent: '{n}% অনূদিত',
    close: 'বন্ধ করুন', chooseLanguage: 'ভাষা বেছে নিন', cover: 'প্রচ্ছদ', pageOf: 'পাতা {n} / {total}', download: 'ডাউনলোড',
    share: 'শেয়ার করুন', guidedView: 'গাইডেড ভিউ', settings: 'সেটিংস', startReading: 'পড়া শুরু করুন', readAgain: 'আবার পড়ুন'
  },
  gu: {
    pageTurnHelp: 'પાનાની ધાર ખેંચો અથવા તીરથી પાનાં ફેરવો.', scrollHelp: 'કોમિક ઉપર-નીચે સ્ક્રોલ કરો.',
    pageTurn: 'પાનું ફેરવો', singlePage: 'એક પાનું', facingPages: 'સામસામેનાં પાનાં',
    scroll: 'સ્ક્રોલ', page: 'પાનું', spread: 'બે પાનાં', theEnd: 'સમાપ્ત.', previousPage: 'પાછલું પાનું', nextPage: 'આગલું પાનું',
    fullScreen: 'પૂર્ણ સ્ક્રીન', exitFullScreen: 'પૂર્ણ સ્ક્રીનમાંથી બહાર નીકળો', language: 'ભાષા', original: 'મૂળ',
    readsRightToLeft: 'જમણેથી ડાબે વાંચો', untranslatedLines: 'હજી અનુવાદ બાકી: {n}', translatedPercent: '{n}% અનુવાદિત',
    close: 'બંધ કરો', chooseLanguage: 'ભાષા પસંદ કરો', cover: 'મુખપૃષ્ઠ', pageOf: 'પાનું {n} / {total}', download: 'ડાઉનલોડ',
    share: 'શેર કરો', guidedView: 'માર્ગદર્શિત દૃશ્ય', settings: 'સેટિંગ્સ', startReading: 'વાંચવાનું શરૂ કરો', readAgain: 'ફરી વાંચો'
  },
  pa: {
    pageTurnHelp: 'ਸਫ਼ੇ ਦਾ ਕਿਨਾਰਾ ਖਿੱਚੋ ਜਾਂ ਤੀਰਾਂ ਨਾਲ ਸਫ਼ੇ ਪਲਟੋ।', scrollHelp: 'ਕਾਮਿਕ ਨੂੰ ਉੱਪਰ-ਹੇਠਾਂ ਸਕ੍ਰੋਲ ਕਰੋ।',
    pageTurn: 'ਸਫ਼ਾ ਪਲਟੋ', singlePage: 'ਇੱਕ ਸਫ਼ਾ', facingPages: 'ਆਹਮੋ-ਸਾਹਮਣੇ ਸਫ਼ੇ',
    scroll: 'ਸਕ੍ਰੋਲ', page: 'ਪੰਨਾ', spread: 'ਦੋ ਪੰਨੇ', theEnd: 'ਸਮਾਪਤ।', previousPage: 'ਪਿਛਲਾ ਪੰਨਾ', nextPage: 'ਅਗਲਾ ਪੰਨਾ',
    fullScreen: 'ਪੂਰੀ ਸਕ੍ਰੀਨ', exitFullScreen: 'ਪੂਰੀ ਸਕ੍ਰੀਨ ਤੋਂ ਬਾਹਰ ਨਿਕਲੋ', language: 'ਭਾਸ਼ਾ', original: 'ਮੂਲ',
    readsRightToLeft: 'ਸੱਜੇ ਤੋਂ ਖੱਬੇ ਪੜ੍ਹੋ', untranslatedLines: 'ਅਜੇ ਅਨੁਵਾਦ ਨਹੀਂ ਹੋਏ: {n}', translatedPercent: '{n}% ਅਨੁਵਾਦਿਤ',
    close: 'ਬੰਦ ਕਰੋ', chooseLanguage: 'ਭਾਸ਼ਾ ਚੁਣੋ', cover: 'ਕਵਰ', pageOf: 'ਪੰਨਾ {n} / {total}', download: 'ਡਾਊਨਲੋਡ',
    share: 'ਸਾਂਝਾ ਕਰੋ', guidedView: 'ਗਾਈਡਡ ਵਿਊ', settings: 'ਸੈਟਿੰਗਾਂ', startReading: 'ਪੜ੍ਹਨਾ ਸ਼ੁਰੂ ਕਰੋ', readAgain: 'ਮੁੜ ਪੜ੍ਹੋ'
  },
  ur: {
    pageTurnHelp: 'صفحے کا کنارہ کھینچیں یا تیروں سے صفحے پلٹیں۔', scrollHelp: 'کامک کو اوپر نیچے اسکرول کریں۔',
    pageTurn: 'صفحہ پلٹیں', singlePage: 'ایک صفحہ', facingPages: 'آمنے سامنے صفحات',
    scroll: 'اسکرول', page: 'صفحہ', spread: 'دو صفحات', theEnd: 'ختم۔', previousPage: 'پچھلا صفحہ', nextPage: 'اگلا صفحہ',
    fullScreen: 'پوری اسکرین', exitFullScreen: 'پوری اسکرین سے باہر نکلیں', language: 'زبان', original: 'اصل',
    readsRightToLeft: 'دائیں سے بائیں پڑھیں', untranslatedLines: 'ابھی ترجمہ نہیں ہوا: {n}', translatedPercent: '{n}% ترجمہ شدہ',
    close: 'بند کریں', chooseLanguage: 'زبان منتخب کریں', cover: 'سرورق', pageOf: 'صفحہ {n} / {total}', download: 'ڈاؤن لوڈ',
    share: 'شیئر کریں', guidedView: 'رہنمائی منظر', settings: 'ترتیبات', startReading: 'پڑھنا شروع کریں', readAgain: 'دوبارہ پڑھیں'
  },
  es: {
    pageTurnHelp: 'Arrastra el borde de la página o usa las flechas para pasar de página.', scrollHelp: 'Desplázate verticalmente por el cómic.',
    pageTurn: 'Pasar página', singlePage: 'Una página', facingPages: 'Páginas enfrentadas',
    scroll: 'Desplazar', page: 'Página', spread: 'Doble página', theEnd: 'Fin.', previousPage: 'Página anterior', nextPage: 'Página siguiente',
    fullScreen: 'Pantalla completa', exitFullScreen: 'Salir de pantalla completa', language: 'Idioma', original: 'Original',
    readsRightToLeft: 'Se lee de derecha a izquierda', untranslatedLines: 'Sin traducir: {n}', translatedPercent: '{n} % traducido',
    close: 'Cerrar', chooseLanguage: 'Elige un idioma', cover: 'Portada', pageOf: 'Página {n} de {total}', download: 'Descargar',
    share: 'Compartir', guidedView: 'Vista guiada', settings: 'Ajustes', startReading: 'Empezar a leer', readAgain: 'Leer de nuevo'
  },
  fr: {
    pageTurnHelp: 'Faites glisser le bord d’une page ou utilisez les flèches pour la tourner.', scrollHelp: 'Faites défiler la bande dessinée verticalement.',
    pageTurn: 'Tourner la page', singlePage: 'Une page', facingPages: 'Pages en vis-à-vis',
    scroll: 'Défilement', page: 'Page', spread: 'Double page', theEnd: 'Fin.', previousPage: 'Page précédente', nextPage: 'Page suivante',
    fullScreen: 'Plein écran', exitFullScreen: 'Quitter le plein écran', language: 'Langue', original: 'Original',
    readsRightToLeft: 'Se lit de droite à gauche', untranslatedLines: `Pas encore traduites${NNBSP}: {n}`, translatedPercent: `{n}${NNBSP}% traduit`,
    close: 'Fermer', chooseLanguage: 'Choisir une langue', cover: 'Couverture', pageOf: 'Page {n} sur {total}', download: 'Télécharger',
    share: 'Partager', guidedView: 'Lecture guidée', settings: 'Réglages', startReading: 'Commencer la lecture', readAgain: 'Relire'
  },
  pt: {
    pageTurnHelp: 'Arraste a borda da página ou use as setas para virar.', scrollHelp: 'Role a história na vertical.',
    pageTurn: 'Virar página', singlePage: 'Uma página', facingPages: 'Páginas lado a lado',
    scroll: 'Rolagem', page: 'Página', spread: 'Página dupla', theEnd: 'Fim.', previousPage: 'Página anterior', nextPage: 'Próxima página',
    fullScreen: 'Tela cheia', exitFullScreen: 'Sair da tela cheia', language: 'Idioma', original: 'Original',
    readsRightToLeft: 'Lê-se da direita para a esquerda', untranslatedLines: 'Ainda sem tradução: {n}', translatedPercent: '{n}% traduzido',
    close: 'Fechar', chooseLanguage: 'Escolha um idioma', cover: 'Capa', pageOf: 'Página {n} de {total}', download: 'Baixar',
    share: 'Compartilhar', guidedView: 'Visão guiada', settings: 'Configurações', startReading: 'Começar a ler', readAgain: 'Ler de novo'
  },
  de: {
    pageTurnHelp: 'Ziehe am Seitenrand oder blättere mit den Pfeilen.', scrollHelp: 'Scrolle senkrecht durch den Comic.',
    pageTurn: 'Umblättern', singlePage: 'Einzelseite', facingPages: 'Doppelseite',
    scroll: 'Scrollen', page: 'Seite', spread: 'Doppelseite', theEnd: 'Ende.', previousPage: 'Vorherige Seite', nextPage: 'Nächste Seite',
    fullScreen: 'Vollbild', exitFullScreen: 'Vollbild beenden', language: 'Sprache', original: 'Original',
    readsRightToLeft: 'Wird von rechts nach links gelesen', untranslatedLines: 'Noch nicht übersetzt: {n}', translatedPercent: `{n}${NNBSP}% übersetzt`,
    close: 'Schließen', chooseLanguage: 'Sprache wählen', cover: 'Cover', pageOf: 'Seite {n} von {total}', download: 'Herunterladen',
    share: 'Teilen', guidedView: 'Geführte Ansicht', settings: 'Einstellungen', startReading: 'Lesen beginnen', readAgain: 'Nochmal lesen'
  },
  id: {
    pageTurnHelp: 'Tarik tepi halaman atau gunakan panah untuk membalik halaman.', scrollHelp: 'Gulir komik secara vertikal.',
    pageTurn: 'Balik halaman', singlePage: 'Satu halaman', facingPages: 'Dua halaman berhadapan',
    scroll: 'Gulir', page: 'Halaman', spread: 'Dua halaman', theEnd: 'Tamat.', previousPage: 'Halaman sebelumnya', nextPage: 'Halaman berikutnya',
    fullScreen: 'Layar penuh', exitFullScreen: 'Keluar dari layar penuh', language: 'Bahasa', original: 'Asli',
    readsRightToLeft: 'Dibaca dari kanan ke kiri', untranslatedLines: 'Belum diterjemahkan: {n}', translatedPercent: '{n}% diterjemahkan',
    close: 'Tutup', chooseLanguage: 'Pilih bahasa', cover: 'Sampul', pageOf: 'Halaman {n} dari {total}', download: 'Unduh',
    share: 'Bagikan', guidedView: 'Tampilan terpandu', settings: 'Pengaturan', startReading: 'Mulai membaca', readAgain: 'Baca lagi'
  },
  ja: {
    pageTurnHelp: 'ページの端をドラッグするか、矢印でページをめくります。', scrollHelp: '縦にスクロールして読みます。',
    pageTurn: 'ページめくり', singlePage: '単ページ', facingPages: '見開き',
    scroll: 'スクロール', page: 'ページ', spread: '見開き', theEnd: 'おしまい。', previousPage: '前のページ', nextPage: '次のページ',
    fullScreen: '全画面', exitFullScreen: '全画面を終了', language: '言語', original: 'オリジナル',
    readsRightToLeft: '右から左に読みます', untranslatedLines: '未翻訳：{n}', translatedPercent: '{n}% 翻訳済み',
    close: '閉じる', chooseLanguage: '言語を選ぶ', cover: '表紙', pageOf: '{n} / {total} ページ', download: 'ダウンロード',
    share: '共有', guidedView: 'ガイドビュー', settings: '設定', startReading: '読みはじめる', readAgain: 'もう一度読む'
  },
  ko: {
    pageTurnHelp: '페이지 가장자리를 끌거나 화살표로 페이지를 넘깁니다.', scrollHelp: '세로로 스크롤하여 만화를 읽습니다.',
    pageTurn: '페이지 넘기기', singlePage: '한 페이지', facingPages: '두 페이지',
    scroll: '스크롤', page: '페이지', spread: '두 쪽 보기', theEnd: '끝.', previousPage: '이전 페이지', nextPage: '다음 페이지',
    fullScreen: '전체 화면', exitFullScreen: '전체 화면 종료', language: '언어', original: '원문',
    readsRightToLeft: '오른쪽에서 왼쪽으로 읽어요', untranslatedLines: '아직 번역되지 않음: {n}', translatedPercent: '{n}% 번역됨',
    close: '닫기', chooseLanguage: '언어 선택', cover: '표지', pageOf: '{total}쪽 중 {n}쪽', download: '다운로드',
    share: '공유', guidedView: '가이드 보기', settings: '설정', startReading: '읽기 시작', readAgain: '다시 읽기'
  },
  'zh-Hans': {
    pageTurnHelp: '拖动页边或使用箭头翻页。', scrollHelp: '上下滚动阅读漫画。',
    pageTurn: '翻页', singlePage: '单页', facingPages: '跨页',
    scroll: '滚动', page: '单页', spread: '双页', theEnd: '完。', previousPage: '上一页', nextPage: '下一页',
    fullScreen: '全屏', exitFullScreen: '退出全屏', language: '语言', original: '原文',
    readsRightToLeft: '从右向左阅读', untranslatedLines: '尚未翻译：{n}', translatedPercent: '已翻译 {n}%',
    close: '关闭', chooseLanguage: '选择语言', cover: '封面', pageOf: '第 {n} 页，共 {total} 页', download: '下载',
    share: '分享', guidedView: '导读模式', settings: '设置', startReading: '开始阅读', readAgain: '再读一遍'
  },
  ar: {
    pageTurnHelp: 'اسحب حافة الصفحة أو استخدم الأسهم لتقليب الصفحات.', scrollHelp: 'مرّر عموديًا لقراءة القصّة المصوّرة.',
    pageTurn: 'تقليب الصفحات', singlePage: 'صفحة واحدة', facingPages: 'صفحتان متقابلتان',
    scroll: 'تمرير', page: 'صفحة', spread: 'صفحتان', theEnd: 'النهاية.', previousPage: 'الصفحة السابقة', nextPage: 'الصفحة التالية',
    fullScreen: 'ملء الشاشة', exitFullScreen: 'الخروج من ملء الشاشة', language: 'اللغة', original: 'الأصل',
    readsRightToLeft: 'تُقرأ من اليمين إلى اليسار', untranslatedLines: 'لم تُترجم بعد: {n}', translatedPercent: 'تُرجم {n}٪',
    close: 'إغلاق', chooseLanguage: 'اختر لغة', cover: 'الغلاف', pageOf: 'الصفحة {n} من {total}', download: 'تنزيل',
    share: 'مشاركة', guidedView: 'العرض الموجّه', settings: 'الإعدادات', startReading: 'ابدأ القراءة', readAgain: 'اقرأ مرة أخرى'
  }
};

/** The full table for a language (English fills any gap). */
export const readerStrings = (lang: string): ReaderStrings => {
  const code = languageSpec(lang)?.code;
  return { ...EN, ...(code ? READER_STRINGS[code] : undefined) };
};

/** One string, interpolated: readerString('te', 'pageOf', { n: 2, total: 6 }) → "పేజీ 2 / 6". */
export const readerString = (lang: string, key: ReaderStringKey, vars?: Record<string, string | number>): string => {
  const raw = readerStrings(lang)[key];
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : raw;
};
