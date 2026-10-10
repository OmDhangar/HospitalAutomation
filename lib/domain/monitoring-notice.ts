/**
 * The staff monitoring notice (IPD sheets plan §7.8, legal item L3).
 *
 * DRAFT WORDING, written by us, not yet reviewed by counsel or checked by a
 * native Marathi and Hindi speaker. A hospital can require it only by turning
 * it on in Settings → Staff access, which says so. When the reviewed text
 * replaces this, the version changes and everyone is asked again.
 */

export const MONITORING_NOTICE_KEY = 'monitoring_notice';
export const MONITORING_NOTICE_VERSION = '2026-10-draft';
export const MONITORING_NOTICE_IS_DRAFT = true;

export type NoticeLocale = 'en' | 'mr' | 'hi';

export type NoticeText = { title: string; points: string[]; accept: string };

export const MONITORING_NOTICE: Record<NoticeLocale, NoticeText> = {
  en: {
    title: 'How your work in QuriioHQ is recorded',
    points: [
      'Every entry you make (readings, medicines given, stock counts, corrections) is saved with your name, the time, and the device it came from: a ward tablet or your own phone.',
      'Opening a patient’s file and printing it are also recorded.',
      'The hospital uses these records for patient safety, for the medicine registers the law requires, and to find mistakes or losses. Unusual patterns are shown to the people responsible for checking them.',
      'A flag is a question for a person to look into, never a finding against you. You can see entries of yours that are being reviewed, and add your explanation.',
      'Use only your own login and your own PIN. Never let anyone else use them.',
      'The records are kept as long as the law requires for hospital records. Ask the hospital administrator if you have a question or a complaint.',
    ],
    accept: 'I have read and understood this',
  },
  mr: {
    title: 'QuriioHQ मध्ये तुमच्या कामाची नोंद कशी होते',
    points: [
      'तुम्ही केलेली प्रत्येक नोंद (रीडिंग, दिलेली औषधे, स्टॉक मोजणी, दुरुस्त्या) तुमचे नाव, वेळ आणि ती कोणत्या उपकरणावरून केली (वॉर्ड टॅबलेट की तुमचा स्वतःचा फोन) यांसह जतन केली जाते.',
      'रुग्णाची फाइल उघडणे आणि प्रिंट करणे याचीही नोंद होते.',
      'रुग्णांची सुरक्षितता, कायद्याने आवश्यक असलेली औषध रजिस्टर्स आणि चुका किंवा नुकसान शोधण्यासाठी हॉस्पिटल या नोंदी वापरते. असामान्य गोष्टी तपासणाऱ्या जबाबदार व्यक्तींना दाखवल्या जातात.',
      'फ्लॅग म्हणजे एखाद्या व्यक्तीने तपासायचा प्रश्न आहे, तुमच्याविरुद्ध निष्कर्ष नाही. तपासणीत असलेल्या तुमच्या नोंदी तुम्ही पाहू शकता आणि तुमचे स्पष्टीकरण देऊ शकता.',
      'फक्त तुमचे स्वतःचे लॉगिन आणि तुमचा स्वतःचा PIN वापरा. ते इतर कोणालाही वापरू देऊ नका.',
      'हॉस्पिटलच्या नोंदींसाठी कायद्याने आवश्यक तितका काळ या नोंदी ठेवल्या जातात. काही प्रश्न किंवा तक्रार असल्यास हॉस्पिटल प्रशासकांना विचारा.',
    ],
    accept: 'मी हे वाचले आणि समजून घेतले आहे',
  },
  hi: {
    title: 'QuriioHQ में आपके काम का रिकॉर्ड कैसे रखा जाता है',
    points: [
      'आपकी हर एंट्री (रीडिंग, दी गई दवाएँ, स्टॉक गिनती, सुधार) आपके नाम, समय और जिस डिवाइस से की गई (वार्ड टैबलेट या आपका अपना फ़ोन) उसके साथ सेव की जाती है।',
      'मरीज़ की फ़ाइल खोलना और प्रिंट करना भी रिकॉर्ड होता है।',
      'अस्पताल इन रिकॉर्ड का उपयोग मरीज़ों की सुरक्षा, क़ानून के अनुसार ज़रूरी दवा रजिस्टरों, और गलतियाँ या नुकसान पकड़ने के लिए करता है। असामान्य बातें जाँच करने वाले ज़िम्मेदार लोगों को दिखाई जाती हैं।',
      'फ़्लैग किसी व्यक्ति द्वारा जाँचने का सवाल है, आपके ख़िलाफ़ नतीजा नहीं। जाँच में चल रही अपनी एंट्री आप देख सकते हैं और अपना स्पष्टीकरण जोड़ सकते हैं।',
      'केवल अपना लॉगिन और अपना PIN इस्तेमाल करें। इन्हें किसी और को इस्तेमाल न करने दें।',
      'अस्पताल के रिकॉर्ड के लिए क़ानून जितना समय माँगता है, उतने समय तक ये रिकॉर्ड रखे जाते हैं। कोई सवाल या शिकायत हो तो अस्पताल प्रशासक से पूछें।',
    ],
    accept: 'मैंने इसे पढ़ और समझ लिया है',
  },
};

export const isNoticeLocale = (value: string): value is NoticeLocale => value === 'en' || value === 'mr' || value === 'hi';
