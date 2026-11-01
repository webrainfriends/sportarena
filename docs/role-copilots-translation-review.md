# Role copilots — translation review sheet

The 66 `copilot.*` strings were drafted by machine in all 11 language packs and are flagged `reviewed: false`
(`apps/app/src/i18n/catalogue.js`). `test/i18n-catalogues.test.js` deliberately fails if a pack claims review without a native speaker, so the
flag is flipped only by a person, after this sheet is checked. Generated from the packs; regenerate rather than hand-editing.

How to review: for each language, read each row, fix the text in `apps/app/src/i18n/<code>.js`, keep `{placeholders}` unchanged, then
set `reviewed: true` for that language in `catalogue.js`. Urdu is right-to-left. Short labels (chips, buttons) must fit a 44pt control.

Safety-critical wording to check first: `copilot.guardrail`, `copilot.advisory`, `copilot.by_rules`.

## हिन्दी (`hi`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | कोपायलट |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | भूमिका-आधारित सहायक जो केवल वही पढ़ते हैं जो आप पहले से देख सकते हैं, स्रोत बताते हैं और आपके लिए कभी निर्णय नहीं लेते। |  | ☐ |
| `copilot.pick` | Choose a copilot | कोपायलट चुनें |  | ☐ |
| `copilot.task` | What do you need help with? | आपको किस चीज़ में मदद चाहिए? |  | ☐ |
| `copilot.choose` | Choose | चुनें |  | ☐ |
| `copilot.run` | Prepare draft | मसौदा तैयार करें |  | ☐ |
| `copilot.draft` | AI draft | AI मसौदा |  | ☐ |
| `copilot.why` | Why | क्यों |  | ☐ |
| `copilot.no_source` | No record backs this | इसका कोई रिकॉर्ड आधार नहीं है |  | ☐ |
| `copilot.source_a11y` | Source: {label} | स्रोत: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | मंज़ूर करें |  | ☐ |
| `copilot.reject` | Reject | अस्वीकार करें |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | मंज़ूर करें: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | अस्वीकार करें: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | केवल सलाह। यह निर्णय उसी स्क्रीन में स्वयं लें जो इसकी मालिक है। | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | हो गया |  | ☐ |
| `copilot.rejected` | Rejected | अस्वीकृत |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} द्वारा समझाया गया | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | नियमों से बना, कोई AI मॉडल उपयोग नहीं हुआ | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | किसी पर ध्यान देने की ज़रूरत नहीं |  | ☐ |
| `copilot.start` | Pick a copilot to begin | शुरू करने के लिए कोपायलट चुनें |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | केवल मसौदा। आपके मंज़ूर करने तक कुछ नहीं होता। कोपायलट कभी ठेका नहीं देता, चिकित्सकीय मंज़ूरी, अनुशासनात्मक कार्रवाई, वर्गीकरण, हस्ताक्षर, ट्रांसफ़र की मंज़ूरी या पैसों का लेन-देन नहीं करता। | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | उच्च |  | ☐ |
| `copilot.sev.medium` | Medium | मध्यम |  | ☐ |
| `copilot.sev.low` | Low | निम्न |  | ☐ |
| `copilot.status.proposed` | Proposed | प्रस्तावित |  | ☐ |
| `copilot.status.approved` | Approved | मंज़ूर |  | ☐ |
| `copilot.status.rejected` | Rejected | अस्वीकृत |  | ☐ |
| `copilot.status.executed` | Done | पूर्ण |  | ☐ |
| `copilot.status.failed` | Failed | विफल |  | ☐ |
| `copilot.scope.event` | Event | कार्यक्रम |  | ☐ |
| `copilot.scope.body` | Federation body | महासंघ निकाय |  | ☐ |
| `copilot.scope.venue` | Venue | स्थल |  | ☐ |
| `copilot.scope.organisation` | Organisation | संगठन |  | ☐ |
| `copilot.name.coach` | Coach | कोच |  | ☐ |
| `copilot.name.athlete` | Athlete | खिलाड़ी |  | ☐ |
| `copilot.name.event` | Event | कार्यक्रम |  | ☐ |
| `copilot.name.federation` | Federation | महासंघ |  | ☐ |
| `copilot.name.sponsor` | Sponsor | प्रायोजक |  | ☐ |
| `copilot.name.supplier` | Supplier | आपूर्तिकर्ता |  | ☐ |
| `copilot.name.venue` | Venue | स्थल |  | ☐ |
| `copilot.name.official` | Official | अधिकारी |  | ☐ |
| `copilot.name.organisation` | Organisation | संगठन |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | तैयारी की कमियाँ |  | ☐ |
| `copilot.task.incidents` | Incidents | घटनाएँ |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | विक्रेता फ़ॉलो-अप |  | ☐ |
| `copilot.task.run_of_show` | Run of show | कार्यक्रम का क्रम |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | समाप्त हो रही संबद्धताएँ |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | समाप्त हो रहे लाइसेंस |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | पंजीकरण अपवाद |  | ☐ |
| `copilot.task.governance_report` | Governance report | शासन रिपोर्ट |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | पूर्ति |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | समाप्त हो रहे अधिकार |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | नवीनीकरण की तैयारी |  | ☐ |
| `copilot.task.opportunities` | Opportunities | अवसर |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | डिलीवरी दायित्व |  | ☐ |
| `copilot.task.maintenance` | Maintenance | रखरखाव |  | ☐ |
| `copilot.task.operations` | Venue operations | स्थल संचालन |  | ☐ |
| `copilot.task.my_week` | My officiating week | मेरा रेफ़री सप्ताह |  | ☐ |
| `copilot.task.attention` | What needs attention | किस पर ध्यान चाहिए |  | ☐ |
| `copilot.task.week` | My week | मेरा सप्ताह |  | ☐ |
| `copilot.task.goals` | My goals | मेरे लक्ष्य |  | ☐ |
| `copilot.task.training` | Explain my training | मेरा प्रशिक्षण समझाएँ |  | ☐ |
| `copilot.task.plan_session` | Plan a session | सत्र की योजना बनाएँ |  | ☐ |
| `copilot.task.player_focus` | Player focus | खिलाड़ी पर ध्यान |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | बकाया कार्य |  | ☐ |

## मराठी (`mr`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | कोपायलट |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | भूमिकेवर आधारित सहाय्यक जे फक्त तुम्हाला आधीच दिसणारे वाचतात, स्रोत सांगतात आणि तुमच्या वतीने कधीही निर्णय घेत नाहीत. |  | ☐ |
| `copilot.pick` | Choose a copilot | कोपायलट निवडा |  | ☐ |
| `copilot.task` | What do you need help with? | तुम्हाला कशात मदत हवी आहे? |  | ☐ |
| `copilot.choose` | Choose | निवडा |  | ☐ |
| `copilot.run` | Prepare draft | मसुदा तयार करा |  | ☐ |
| `copilot.draft` | AI draft | AI मसुदा |  | ☐ |
| `copilot.why` | Why | का |  | ☐ |
| `copilot.no_source` | No record backs this | याला कोणताही नोंद आधार नाही |  | ☐ |
| `copilot.source_a11y` | Source: {label} | स्रोत: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | मंजूर करा |  | ☐ |
| `copilot.reject` | Reject | नाकारा |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | मंजूर करा: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | नाकारा: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | फक्त सल्ला. हा निर्णय त्या स्क्रीनवर स्वतः घ्या जी याची मालक आहे. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | पूर्ण झाले |  | ☐ |
| `copilot.rejected` | Rejected | नाकारले |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} ने स्पष्ट केले | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | नियमांनी तयार केले, AI मॉडेल वापरले नाही | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | कशाकडेही लक्ष देण्याची गरज नाही |  | ☐ |
| `copilot.start` | Pick a copilot to begin | सुरू करण्यासाठी कोपायलट निवडा |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | फक्त मसुदा. तुम्ही मंजूर करेपर्यंत काही होत नाही. कोपायलट कधीही कंत्राट देत नाही, वैद्यकीय मंजुरी, शिस्तभंग कारवाई, वर्गीकरण, स्वाक्षरी, बदलीला मंजुरी किंवा पैशांचे व्यवहार करत नाही. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | उच्च |  | ☐ |
| `copilot.sev.medium` | Medium | मध्यम |  | ☐ |
| `copilot.sev.low` | Low | कमी |  | ☐ |
| `copilot.status.proposed` | Proposed | प्रस्तावित |  | ☐ |
| `copilot.status.approved` | Approved | मंजूर |  | ☐ |
| `copilot.status.rejected` | Rejected | नाकारले |  | ☐ |
| `copilot.status.executed` | Done | पूर्ण |  | ☐ |
| `copilot.status.failed` | Failed | अयशस्वी |  | ☐ |
| `copilot.scope.event` | Event | स्पर्धा |  | ☐ |
| `copilot.scope.body` | Federation body | महासंघ संस्था |  | ☐ |
| `copilot.scope.venue` | Venue | स्थळ |  | ☐ |
| `copilot.scope.organisation` | Organisation | संस्था |  | ☐ |
| `copilot.name.coach` | Coach | प्रशिक्षक |  | ☐ |
| `copilot.name.athlete` | Athlete | खेळाडू |  | ☐ |
| `copilot.name.event` | Event | स्पर्धा |  | ☐ |
| `copilot.name.federation` | Federation | महासंघ |  | ☐ |
| `copilot.name.sponsor` | Sponsor | प्रायोजक |  | ☐ |
| `copilot.name.supplier` | Supplier | पुरवठादार |  | ☐ |
| `copilot.name.venue` | Venue | स्थळ |  | ☐ |
| `copilot.name.official` | Official | अधिकारी |  | ☐ |
| `copilot.name.organisation` | Organisation | संस्था |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | तयारीतील त्रुटी |  | ☐ |
| `copilot.task.incidents` | Incidents | घटना |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | विक्रेत्यांचा पाठपुरावा |  | ☐ |
| `copilot.task.run_of_show` | Run of show | कार्यक्रमाचा क्रम |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | संपत असलेल्या संलग्नता |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | संपत असलेले परवाने |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | नोंदणी अपवाद |  | ☐ |
| `copilot.task.governance_report` | Governance report | प्रशासन अहवाल |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | पूर्तता |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | संपत असलेले हक्क |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | नूतनीकरणाची तयारी |  | ☐ |
| `copilot.task.opportunities` | Opportunities | संधी |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | वितरण जबाबदाऱ्या |  | ☐ |
| `copilot.task.maintenance` | Maintenance | देखभाल |  | ☐ |
| `copilot.task.operations` | Venue operations | स्थळ संचालन |  | ☐ |
| `copilot.task.my_week` | My officiating week | माझा पंच आठवडा |  | ☐ |
| `copilot.task.attention` | What needs attention | कशाकडे लक्ष हवे |  | ☐ |
| `copilot.task.week` | My week | माझा आठवडा |  | ☐ |
| `copilot.task.goals` | My goals | माझी ध्येये |  | ☐ |
| `copilot.task.training` | Explain my training | माझे प्रशिक्षण समजावून सांगा |  | ☐ |
| `copilot.task.plan_session` | Plan a session | सत्राचे नियोजन करा |  | ☐ |
| `copilot.task.player_focus` | Player focus | खेळाडूवर लक्ष |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | प्रलंबित कामे |  | ☐ |

## தமிழ் (`ta`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | கோபைலட்டுகள் |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | உங்களால் ஏற்கனவே பார்க்கக்கூடியதை மட்டுமே படிக்கும், ஆதாரங்களைக் குறிப்பிடும், உங்களுக்காக ஒருபோதும் முடிவெடுக்காத பங்கு அடிப்படையிலான உதவியாளர்கள். |  | ☐ |
| `copilot.pick` | Choose a copilot | கோபைலட்டைத் தேர்ந்தெடுக்கவும் |  | ☐ |
| `copilot.task` | What do you need help with? | எதில் உங்களுக்கு உதவி தேவை? |  | ☐ |
| `copilot.choose` | Choose | தேர்ந்தெடுக்கவும் |  | ☐ |
| `copilot.run` | Prepare draft | வரைவைத் தயாரிக்கவும் |  | ☐ |
| `copilot.draft` | AI draft | AI வரைவு |  | ☐ |
| `copilot.why` | Why | ஏன் |  | ☐ |
| `copilot.no_source` | No record backs this | இதற்கு எந்தப் பதிவும் ஆதாரம் இல்லை |  | ☐ |
| `copilot.source_a11y` | Source: {label} | ஆதாரம்: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | ஒப்புதல் அளி |  | ☐ |
| `copilot.reject` | Reject | நிராகரி |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | ஒப்புதல் அளி: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | நிராகரி: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | ஆலோசனை மட்டும். இதை உரிய திரையில் நீங்களே முடிவு செய்யுங்கள். | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | முடிந்தது |  | ☐ |
| `copilot.rejected` | Rejected | நிராகரிக்கப்பட்டது |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} விளக்கியது | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | விதிகளால் உருவாக்கப்பட்டது, AI மாதிரி பயன்படுத்தப்படவில்லை | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | கவனிக்க எதுவும் இல்லை |  | ☐ |
| `copilot.start` | Pick a copilot to begin | தொடங்க ஒரு கோபைலட்டைத் தேர்ந்தெடுக்கவும் |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | வரைவு மட்டுமே. நீங்கள் ஒப்புதல் அளிக்கும் வரை எதுவும் நடக்காது. கோபைலட் ஒருபோதும் ஒப்பந்தம் வழங்காது, மருத்துவ அனுமதி, ஒழுங்கு நடவடிக்கை, வகைப்படுத்தல், கையொப்பம், இடமாற்ற ஒப்புதல் அல்லது பணப் பரிமாற்றம் செய்யாது. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | உயர் |  | ☐ |
| `copilot.sev.medium` | Medium | நடுத்தர |  | ☐ |
| `copilot.sev.low` | Low | குறைவு |  | ☐ |
| `copilot.status.proposed` | Proposed | முன்மொழியப்பட்டது |  | ☐ |
| `copilot.status.approved` | Approved | ஒப்புதல் பெற்றது |  | ☐ |
| `copilot.status.rejected` | Rejected | நிராகரிக்கப்பட்டது |  | ☐ |
| `copilot.status.executed` | Done | முடிந்தது |  | ☐ |
| `copilot.status.failed` | Failed | தோல்வி |  | ☐ |
| `copilot.scope.event` | Event | நிகழ்வு |  | ☐ |
| `copilot.scope.body` | Federation body | கூட்டமைப்பு அமைப்பு |  | ☐ |
| `copilot.scope.venue` | Venue | மைதானம் |  | ☐ |
| `copilot.scope.organisation` | Organisation | நிறுவனம் |  | ☐ |
| `copilot.name.coach` | Coach | பயிற்சியாளர் |  | ☐ |
| `copilot.name.athlete` | Athlete | விளையாட்டு வீரர் |  | ☐ |
| `copilot.name.event` | Event | நிகழ்வு |  | ☐ |
| `copilot.name.federation` | Federation | கூட்டமைப்பு |  | ☐ |
| `copilot.name.sponsor` | Sponsor | ஸ்பான்சர் |  | ☐ |
| `copilot.name.supplier` | Supplier | சப்ளையர் |  | ☐ |
| `copilot.name.venue` | Venue | மைதானம் |  | ☐ |
| `copilot.name.official` | Official | நடுவர் |  | ☐ |
| `copilot.name.organisation` | Organisation | நிறுவனம் |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | தயார்நிலை இடைவெளிகள் |  | ☐ |
| `copilot.task.incidents` | Incidents | சம்பவங்கள் |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | விற்பனையாளர் பின்தொடர்தல் |  | ☐ |
| `copilot.task.run_of_show` | Run of show | நிகழ்ச்சி வரிசை |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | காலாவதியாகும் இணைப்புகள் |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | காலாவதியாகும் உரிமங்கள் |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | பதிவு விதிவிலக்குகள் |  | ☐ |
| `copilot.task.governance_report` | Governance report | நிர்வாக அறிக்கை |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | நிறைவேற்றம் |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | காலாவதியாகும் உரிமைகள் |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | புதுப்பித்தல் தயாரிப்பு |  | ☐ |
| `copilot.task.opportunities` | Opportunities | வாய்ப்புகள் |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | வழங்கல் கடமைகள் |  | ☐ |
| `copilot.task.maintenance` | Maintenance | பராமரிப்பு |  | ☐ |
| `copilot.task.operations` | Venue operations | மைதான செயல்பாடுகள் |  | ☐ |
| `copilot.task.my_week` | My officiating week | எனது நடுவர் வாரம் |  | ☐ |
| `copilot.task.attention` | What needs attention | கவனம் தேவைப்படுவது |  | ☐ |
| `copilot.task.week` | My week | எனது வாரம் |  | ☐ |
| `copilot.task.goals` | My goals | எனது இலக்குகள் |  | ☐ |
| `copilot.task.training` | Explain my training | எனது பயிற்சியை விளக்கவும் |  | ☐ |
| `copilot.task.plan_session` | Plan a session | அமர்வைத் திட்டமிடவும் |  | ☐ |
| `copilot.task.player_focus` | Player focus | வீரர் கவனம் |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | நிலுவை செயல்கள் |  | ☐ |

## తెలుగు (`te`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | కోపైలట్లు |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | మీరు ఇప్పటికే చూడగలిగినదాన్ని మాత్రమే చదివి, మూలాలను పేర్కొని, మీ తరఫున ఎప్పుడూ నిర్ణయం తీసుకోని పాత్ర ఆధారిత సహాయకులు. |  | ☐ |
| `copilot.pick` | Choose a copilot | కోపైలట్‌ను ఎంచుకోండి |  | ☐ |
| `copilot.task` | What do you need help with? | మీకు దేనిలో సహాయం కావాలి? |  | ☐ |
| `copilot.choose` | Choose | ఎంచుకోండి |  | ☐ |
| `copilot.run` | Prepare draft | ముసాయిదా సిద్ధం చేయండి |  | ☐ |
| `copilot.draft` | AI draft | AI ముసాయిదా |  | ☐ |
| `copilot.why` | Why | ఎందుకు |  | ☐ |
| `copilot.no_source` | No record backs this | దీనికి ఏ రికార్డూ ఆధారం లేదు |  | ☐ |
| `copilot.source_a11y` | Source: {label} | మూలం: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | ఆమోదించండి |  | ☐ |
| `copilot.reject` | Reject | తిరస్కరించండి |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | ఆమోదించండి: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | తిరస్కరించండి: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | సలహా మాత్రమే. దీన్ని సంబంధిత స్క్రీన్‌లో మీరే నిర్ణయించండి. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | పూర్తయింది |  | ☐ |
| `copilot.rejected` | Rejected | తిరస్కరించబడింది |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} వివరించింది | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | నియమాలతో రూపొందింది, AI మోడల్ వాడలేదు | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | దేనికీ శ్రద్ధ అవసరం లేదు |  | ☐ |
| `copilot.start` | Pick a copilot to begin | ప్రారంభించడానికి కోపైలట్‌ను ఎంచుకోండి |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ముసాయిదా మాత్రమే. మీరు ఆమోదించే వరకు ఏమీ జరగదు. కోపైలట్ ఎప్పుడూ కాంట్రాక్టు ఇవ్వదు, వైద్య అనుమతి, క్రమశిక్షణ చర్య, వర్గీకరణ, సంతకం, బదిలీ ఆమోదం లేదా డబ్బు కదలిక చేయదు. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | అధికం |  | ☐ |
| `copilot.sev.medium` | Medium | మధ్యస్థం |  | ☐ |
| `copilot.sev.low` | Low | తక్కువ |  | ☐ |
| `copilot.status.proposed` | Proposed | ప్రతిపాదించబడింది |  | ☐ |
| `copilot.status.approved` | Approved | ఆమోదించబడింది |  | ☐ |
| `copilot.status.rejected` | Rejected | తిరస్కరించబడింది |  | ☐ |
| `copilot.status.executed` | Done | పూర్తయింది |  | ☐ |
| `copilot.status.failed` | Failed | విఫలమైంది |  | ☐ |
| `copilot.scope.event` | Event | ఈవెంట్ |  | ☐ |
| `copilot.scope.body` | Federation body | సమాఖ్య సంస్థ |  | ☐ |
| `copilot.scope.venue` | Venue | వేదిక |  | ☐ |
| `copilot.scope.organisation` | Organisation | సంస్థ |  | ☐ |
| `copilot.name.coach` | Coach | కోచ్ |  | ☐ |
| `copilot.name.athlete` | Athlete | క్రీడాకారుడు |  | ☐ |
| `copilot.name.event` | Event | ఈవెంట్ |  | ☐ |
| `copilot.name.federation` | Federation | సమాఖ్య |  | ☐ |
| `copilot.name.sponsor` | Sponsor | స్పాన్సర్ |  | ☐ |
| `copilot.name.supplier` | Supplier | సరఫరాదారు |  | ☐ |
| `copilot.name.venue` | Venue | వేదిక |  | ☐ |
| `copilot.name.official` | Official | అధికారి |  | ☐ |
| `copilot.name.organisation` | Organisation | సంస్థ |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | సిద్ధత లోపాలు |  | ☐ |
| `copilot.task.incidents` | Incidents | సంఘటనలు |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | విక్రేత ఫాలో-అప్ |  | ☐ |
| `copilot.task.run_of_show` | Run of show | కార్యక్రమ క్రమం |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | ముగియబోతున్న అనుబంధాలు |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | ముగియబోతున్న లైసెన్స్‌లు |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | నమోదు మినహాయింపులు |  | ☐ |
| `copilot.task.governance_report` | Governance report | పాలన నివేదిక |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | నెరవేర్పు |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | ముగియబోతున్న హక్కులు |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | పునరుద్ధరణ సన్నాహం |  | ☐ |
| `copilot.task.opportunities` | Opportunities | అవకాశాలు |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | డెలివరీ బాధ్యతలు |  | ☐ |
| `copilot.task.maintenance` | Maintenance | నిర్వహణ |  | ☐ |
| `copilot.task.operations` | Venue operations | వేదిక కార్యకలాపాలు |  | ☐ |
| `copilot.task.my_week` | My officiating week | నా అధికారి వారం |  | ☐ |
| `copilot.task.attention` | What needs attention | శ్రద్ధ అవసరమైనవి |  | ☐ |
| `copilot.task.week` | My week | నా వారం |  | ☐ |
| `copilot.task.goals` | My goals | నా లక్ష్యాలు |  | ☐ |
| `copilot.task.training` | Explain my training | నా శిక్షణను వివరించండి |  | ☐ |
| `copilot.task.plan_session` | Plan a session | సెషన్‌ను ప్లాన్ చేయండి |  | ☐ |
| `copilot.task.player_focus` | Player focus | ఆటగాడిపై దృష్టి |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | బాకీ చర్యలు |  | ☐ |

## മലയാളം (`ml`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | കോപൈലറ്റുകൾ |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | നിങ്ങൾക്ക് ഇതിനകം കാണാൻ കഴിയുന്നത് മാത്രം വായിക്കുകയും ഉറവിടങ്ങൾ പറയുകയും നിങ്ങൾക്കായി ഒരിക്കലും തീരുമാനമെടുക്കാതിരിക്കുകയും ചെയ്യുന്ന റോൾ അടിസ്ഥാനമാക്കിയ സഹായികൾ. |  | ☐ |
| `copilot.pick` | Choose a copilot | കോപൈലറ്റ് തിരഞ്ഞെടുക്കുക |  | ☐ |
| `copilot.task` | What do you need help with? | നിങ്ങൾക്ക് എന്തിലാണ് സഹായം വേണ്ടത്? |  | ☐ |
| `copilot.choose` | Choose | തിരഞ്ഞെടുക്കുക |  | ☐ |
| `copilot.run` | Prepare draft | കരട് തയ്യാറാക്കുക |  | ☐ |
| `copilot.draft` | AI draft | AI കരട് |  | ☐ |
| `copilot.why` | Why | എന്തുകൊണ്ട് |  | ☐ |
| `copilot.no_source` | No record backs this | ഇതിന് ഒരു രേഖയും അടിസ്ഥാനമില്ല |  | ☐ |
| `copilot.source_a11y` | Source: {label} | ഉറവിടം: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | അംഗീകരിക്കുക |  | ☐ |
| `copilot.reject` | Reject | നിരസിക്കുക |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | അംഗീകരിക്കുക: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | നിരസിക്കുക: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | ഉപദേശം മാത്രം. ഇത് ഉടമസ്ഥതയുള്ള സ്ക്രീനിൽ നിങ്ങൾ തന്നെ തീരുമാനിക്കുക. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | പൂർത്തിയായി |  | ☐ |
| `copilot.rejected` | Rejected | നിരസിച്ചു |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} വിശദീകരിച്ചു | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | നിയമങ്ങളാൽ നിർമ്മിച്ചത്, AI മോഡൽ ഉപയോഗിച്ചിട്ടില്ല | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | ശ്രദ്ധിക്കേണ്ടതൊന്നുമില്ല |  | ☐ |
| `copilot.start` | Pick a copilot to begin | ആരംഭിക്കാൻ ഒരു കോപൈലറ്റ് തിരഞ്ഞെടുക്കുക |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | കരട് മാത്രം. നിങ്ങൾ അംഗീകരിക്കുന്നതുവരെ ഒന്നും സംഭവിക്കില്ല. കോപൈലറ്റ് ഒരിക്കലും കരാർ നൽകുകയോ വൈദ്യ ക്ലിയറൻസ്, അച്ചടക്ക നടപടി, വർഗ്ഗീകരണം, ഒപ്പ്, ട്രാൻസ്ഫർ അംഗീകാരം, പണക്കൈമാറ്റം എന്നിവ ചെയ്യുകയോ ഇല്ല. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | ഉയർന്നത് |  | ☐ |
| `copilot.sev.medium` | Medium | ഇടത്തരം |  | ☐ |
| `copilot.sev.low` | Low | കുറഞ്ഞത് |  | ☐ |
| `copilot.status.proposed` | Proposed | നിർദ്ദേശിച്ചത് |  | ☐ |
| `copilot.status.approved` | Approved | അംഗീകരിച്ചു |  | ☐ |
| `copilot.status.rejected` | Rejected | നിരസിച്ചു |  | ☐ |
| `copilot.status.executed` | Done | പൂർത്തിയായി |  | ☐ |
| `copilot.status.failed` | Failed | പരാജയപ്പെട്ടു |  | ☐ |
| `copilot.scope.event` | Event | ഇവന്റ് |  | ☐ |
| `copilot.scope.body` | Federation body | ഫെഡറേഷൻ സ്ഥാപനം |  | ☐ |
| `copilot.scope.venue` | Venue | വേദി |  | ☐ |
| `copilot.scope.organisation` | Organisation | സംഘടന |  | ☐ |
| `copilot.name.coach` | Coach | പരിശീലകൻ |  | ☐ |
| `copilot.name.athlete` | Athlete | കായികതാരം |  | ☐ |
| `copilot.name.event` | Event | ഇവന്റ് |  | ☐ |
| `copilot.name.federation` | Federation | ഫെഡറേഷൻ |  | ☐ |
| `copilot.name.sponsor` | Sponsor | സ്പോൺസർ |  | ☐ |
| `copilot.name.supplier` | Supplier | വിതരണക്കാരൻ |  | ☐ |
| `copilot.name.venue` | Venue | വേദി |  | ☐ |
| `copilot.name.official` | Official | ഒഫീഷ്യൽ |  | ☐ |
| `copilot.name.organisation` | Organisation | സംഘടന |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | തയ്യാറെടുപ്പിലെ വിടവുകൾ |  | ☐ |
| `copilot.task.incidents` | Incidents | സംഭവങ്ങൾ |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | വെണ്ടർ തുടർനടപടി |  | ☐ |
| `copilot.task.run_of_show` | Run of show | പരിപാടിയുടെ ക്രമം |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | കാലഹരണപ്പെടുന്ന അഫിലിയേഷനുകൾ |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | കാലഹരണപ്പെടുന്ന ലൈസൻസുകൾ |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | രജിസ്ട്രേഷൻ ഒഴിവാക്കലുകൾ |  | ☐ |
| `copilot.task.governance_report` | Governance report | ഭരണ റിപ്പോർട്ട് |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | നിർവഹണം |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | കാലഹരണപ്പെടുന്ന അവകാശങ്ങൾ |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | പുതുക്കൽ തയ്യാറെടുപ്പ് |  | ☐ |
| `copilot.task.opportunities` | Opportunities | അവസരങ്ങൾ |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | ഡെലിവറി ബാധ്യതകൾ |  | ☐ |
| `copilot.task.maintenance` | Maintenance | പരിപാലനം |  | ☐ |
| `copilot.task.operations` | Venue operations | വേദി പ്രവർത്തനങ്ങൾ |  | ☐ |
| `copilot.task.my_week` | My officiating week | എന്റെ ഒഫീഷ്യൽ ആഴ്ച |  | ☐ |
| `copilot.task.attention` | What needs attention | ശ്രദ്ധ വേണ്ടത് |  | ☐ |
| `copilot.task.week` | My week | എന്റെ ആഴ്ച |  | ☐ |
| `copilot.task.goals` | My goals | എന്റെ ലക്ഷ്യങ്ങൾ |  | ☐ |
| `copilot.task.training` | Explain my training | എന്റെ പരിശീലനം വിശദീകരിക്കുക |  | ☐ |
| `copilot.task.plan_session` | Plan a session | സെഷൻ ആസൂത്രണം ചെയ്യുക |  | ☐ |
| `copilot.task.player_focus` | Player focus | കളിക്കാരനിൽ ശ്രദ്ധ |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | ബാക്കിയുള്ള പ്രവർത്തനങ്ങൾ |  | ☐ |

## ಕನ್ನಡ (`kn`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | ಕೋಪೈಲಟ್‌ಗಳು |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | ನೀವು ಈಗಾಗಲೇ ನೋಡಬಹುದಾದುದನ್ನು ಮಾತ್ರ ಓದುವ, ಮೂಲಗಳನ್ನು ಹೇಳುವ ಮತ್ತು ನಿಮ್ಮ ಪರವಾಗಿ ಎಂದಿಗೂ ನಿರ್ಧರಿಸದ ಪಾತ್ರ ಆಧಾರಿತ ಸಹಾಯಕರು. |  | ☐ |
| `copilot.pick` | Choose a copilot | ಕೋಪೈಲಟ್ ಆಯ್ಕೆಮಾಡಿ |  | ☐ |
| `copilot.task` | What do you need help with? | ನಿಮಗೆ ಯಾವುದರಲ್ಲಿ ಸಹಾಯ ಬೇಕು? |  | ☐ |
| `copilot.choose` | Choose | ಆಯ್ಕೆಮಾಡಿ |  | ☐ |
| `copilot.run` | Prepare draft | ಕರಡು ಸಿದ್ಧಪಡಿಸಿ |  | ☐ |
| `copilot.draft` | AI draft | AI ಕರಡು |  | ☐ |
| `copilot.why` | Why | ಏಕೆ |  | ☐ |
| `copilot.no_source` | No record backs this | ಇದಕ್ಕೆ ಯಾವುದೇ ದಾಖಲೆ ಆಧಾರವಿಲ್ಲ |  | ☐ |
| `copilot.source_a11y` | Source: {label} | ಮೂಲ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | ಅನುಮೋದಿಸಿ |  | ☐ |
| `copilot.reject` | Reject | ತಿರಸ್ಕರಿಸಿ |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | ಅನುಮೋದಿಸಿ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | ತಿರಸ್ಕರಿಸಿ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | ಸಲಹೆ ಮಾತ್ರ. ಇದನ್ನು ಸಂಬಂಧಿತ ಪರದೆಯಲ್ಲಿ ನೀವೇ ನಿರ್ಧರಿಸಿ. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | ಮುಗಿದಿದೆ |  | ☐ |
| `copilot.rejected` | Rejected | ತಿರಸ್ಕರಿಸಲಾಗಿದೆ |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} ವಿವರಿಸಿದೆ | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | ನಿಯಮಗಳಿಂದ ರಚಿಸಲಾಗಿದೆ, AI ಮಾದರಿ ಬಳಸಿಲ್ಲ | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | ಗಮನ ಬೇಕಾದದ್ದು ಏನೂ ಇಲ್ಲ |  | ☐ |
| `copilot.start` | Pick a copilot to begin | ಪ್ರಾರಂಭಿಸಲು ಕೋಪೈಲಟ್ ಆಯ್ಕೆಮಾಡಿ |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ಕರಡು ಮಾತ್ರ. ನೀವು ಅನುಮೋದಿಸುವವರೆಗೆ ಏನೂ ಆಗುವುದಿಲ್ಲ. ಕೋಪೈಲಟ್ ಎಂದಿಗೂ ಗುತ್ತಿಗೆ ನೀಡುವುದಿಲ್ಲ, ವೈದ್ಯಕೀಯ ಅನುಮತಿ, ಶಿಸ್ತು ಕ್ರಮ, ವರ್ಗೀಕರಣ, ಸಹಿ, ವರ್ಗಾವಣೆ ಅನುಮೋದನೆ ಅಥವಾ ಹಣದ ವರ್ಗಾವಣೆ ಮಾಡುವುದಿಲ್ಲ. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | ಹೆಚ್ಚು |  | ☐ |
| `copilot.sev.medium` | Medium | ಮಧ್ಯಮ |  | ☐ |
| `copilot.sev.low` | Low | ಕಡಿಮೆ |  | ☐ |
| `copilot.status.proposed` | Proposed | ಪ್ರಸ್ತಾಪಿಸಲಾಗಿದೆ |  | ☐ |
| `copilot.status.approved` | Approved | ಅನುಮೋದಿಸಲಾಗಿದೆ |  | ☐ |
| `copilot.status.rejected` | Rejected | ತಿರಸ್ಕರಿಸಲಾಗಿದೆ |  | ☐ |
| `copilot.status.executed` | Done | ಮುಗಿದಿದೆ |  | ☐ |
| `copilot.status.failed` | Failed | ವಿಫಲವಾಗಿದೆ |  | ☐ |
| `copilot.scope.event` | Event | ಕಾರ್ಯಕ್ರಮ |  | ☐ |
| `copilot.scope.body` | Federation body | ಒಕ್ಕೂಟ ಸಂಸ್ಥೆ |  | ☐ |
| `copilot.scope.venue` | Venue | ಸ್ಥಳ |  | ☐ |
| `copilot.scope.organisation` | Organisation | ಸಂಸ್ಥೆ |  | ☐ |
| `copilot.name.coach` | Coach | ತರಬೇತುದಾರ |  | ☐ |
| `copilot.name.athlete` | Athlete | ಕ್ರೀಡಾಪಟು |  | ☐ |
| `copilot.name.event` | Event | ಕಾರ್ಯಕ್ರಮ |  | ☐ |
| `copilot.name.federation` | Federation | ಒಕ್ಕೂಟ |  | ☐ |
| `copilot.name.sponsor` | Sponsor | ಪ್ರಾಯೋಜಕ |  | ☐ |
| `copilot.name.supplier` | Supplier | ಪೂರೈಕೆದಾರ |  | ☐ |
| `copilot.name.venue` | Venue | ಸ್ಥಳ |  | ☐ |
| `copilot.name.official` | Official | ಅಧಿಕಾರಿ |  | ☐ |
| `copilot.name.organisation` | Organisation | ಸಂಸ್ಥೆ |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | ಸಿದ್ಧತೆಯ ಕೊರತೆಗಳು |  | ☐ |
| `copilot.task.incidents` | Incidents | ಘಟನೆಗಳು |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | ಮಾರಾಟಗಾರರ ಅನುಸರಣೆ |  | ☐ |
| `copilot.task.run_of_show` | Run of show | ಕಾರ್ಯಕ್ರಮದ ಕ್ರಮ |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | ಮುಗಿಯುತ್ತಿರುವ ಸಂಯೋಜನೆಗಳು |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | ಮುಗಿಯುತ್ತಿರುವ ಪರವಾನಗಿಗಳು |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | ನೋಂದಣಿ ವಿನಾಯಿತಿಗಳು |  | ☐ |
| `copilot.task.governance_report` | Governance report | ಆಡಳಿತ ವರದಿ |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | ಪೂರೈಕೆ ನಿರ್ವಹಣೆ |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | ಮುಗಿಯುತ್ತಿರುವ ಹಕ್ಕುಗಳು |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | ನವೀಕರಣ ಸಿದ್ಧತೆ |  | ☐ |
| `copilot.task.opportunities` | Opportunities | ಅವಕಾಶಗಳು |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | ವಿತರಣಾ ಬಾಧ್ಯತೆಗಳು |  | ☐ |
| `copilot.task.maintenance` | Maintenance | ನಿರ್ವಹಣೆ |  | ☐ |
| `copilot.task.operations` | Venue operations | ಸ್ಥಳದ ಕಾರ್ಯಾಚರಣೆ |  | ☐ |
| `copilot.task.my_week` | My officiating week | ನನ್ನ ಅಧಿಕಾರಿ ವಾರ |  | ☐ |
| `copilot.task.attention` | What needs attention | ಗಮನ ಬೇಕಾದದ್ದು |  | ☐ |
| `copilot.task.week` | My week | ನನ್ನ ವಾರ |  | ☐ |
| `copilot.task.goals` | My goals | ನನ್ನ ಗುರಿಗಳು |  | ☐ |
| `copilot.task.training` | Explain my training | ನನ್ನ ತರಬೇತಿಯನ್ನು ವಿವರಿಸಿ |  | ☐ |
| `copilot.task.plan_session` | Plan a session | ಅಧಿವೇಶನ ಯೋಜಿಸಿ |  | ☐ |
| `copilot.task.player_focus` | Player focus | ಆಟಗಾರನ ಮೇಲೆ ಗಮನ |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | ಬಾಕಿ ಇರುವ ಕ್ರಮಗಳು |  | ☐ |

## বাংলা (`bn`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | কোপাইলট |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | ভূমিকাভিত্তিক সহায়ক, যারা আপনি যা আগে থেকেই দেখতে পারেন শুধু তা-ই পড়ে, উৎস উল্লেখ করে এবং আপনার হয়ে কখনও সিদ্ধান্ত নেয় না। |  | ☐ |
| `copilot.pick` | Choose a copilot | কোপাইলট বেছে নিন |  | ☐ |
| `copilot.task` | What do you need help with? | কীসে সাহায্য দরকার? |  | ☐ |
| `copilot.choose` | Choose | বেছে নিন |  | ☐ |
| `copilot.run` | Prepare draft | খসড়া তৈরি করুন |  | ☐ |
| `copilot.draft` | AI draft | AI খসড়া |  | ☐ |
| `copilot.why` | Why | কেন |  | ☐ |
| `copilot.no_source` | No record backs this | এর পক্ষে কোনো রেকর্ড নেই |  | ☐ |
| `copilot.source_a11y` | Source: {label} | উৎস: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | অনুমোদন করুন |  | ☐ |
| `copilot.reject` | Reject | প্রত্যাখ্যান করুন |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | অনুমোদন করুন: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | প্রত্যাখ্যান করুন: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | শুধু পরামর্শ। এটি যে স্ক্রিনের অধীন সেখানে নিজেই সিদ্ধান্ত নিন। | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | সম্পন্ন |  | ☐ |
| `copilot.rejected` | Rejected | প্রত্যাখ্যাত |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} ব্যাখ্যা করেছে | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | নিয়ম দিয়ে তৈরি, কোনো AI মডেল ব্যবহার হয়নি | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | কোনো কিছুতেই মনোযোগ দরকার নেই |  | ☐ |
| `copilot.start` | Pick a copilot to begin | শুরু করতে একটি কোপাইলট বেছে নিন |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | শুধু খসড়া। আপনি অনুমোদন না করা পর্যন্ত কিছুই হয় না। কোপাইলট কখনও চুক্তি দেয় না, চিকিৎসাগত ছাড়পত্র, শৃঙ্খলামূলক ব্যবস্থা, শ্রেণিবিন্যাস, স্বাক্ষর, বদলির অনুমোদন বা অর্থ স্থানান্তর করে না। | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | উচ্চ |  | ☐ |
| `copilot.sev.medium` | Medium | মাঝারি |  | ☐ |
| `copilot.sev.low` | Low | নিম্ন |  | ☐ |
| `copilot.status.proposed` | Proposed | প্রস্তাবিত |  | ☐ |
| `copilot.status.approved` | Approved | অনুমোদিত |  | ☐ |
| `copilot.status.rejected` | Rejected | প্রত্যাখ্যাত |  | ☐ |
| `copilot.status.executed` | Done | সম্পন্ন |  | ☐ |
| `copilot.status.failed` | Failed | ব্যর্থ |  | ☐ |
| `copilot.scope.event` | Event | ইভেন্ট |  | ☐ |
| `copilot.scope.body` | Federation body | ফেডারেশন সংস্থা |  | ☐ |
| `copilot.scope.venue` | Venue | ভেন্যু |  | ☐ |
| `copilot.scope.organisation` | Organisation | সংগঠন |  | ☐ |
| `copilot.name.coach` | Coach | কোচ |  | ☐ |
| `copilot.name.athlete` | Athlete | ক্রীড়াবিদ |  | ☐ |
| `copilot.name.event` | Event | ইভেন্ট |  | ☐ |
| `copilot.name.federation` | Federation | ফেডারেশন |  | ☐ |
| `copilot.name.sponsor` | Sponsor | স্পনসর |  | ☐ |
| `copilot.name.supplier` | Supplier | সরবরাহকারী |  | ☐ |
| `copilot.name.venue` | Venue | ভেন্যু |  | ☐ |
| `copilot.name.official` | Official | কর্মকর্তা |  | ☐ |
| `copilot.name.organisation` | Organisation | সংগঠন |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | প্রস্তুতির ঘাটতি |  | ☐ |
| `copilot.task.incidents` | Incidents | ঘটনা |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | বিক্রেতার ফলো-আপ |  | ☐ |
| `copilot.task.run_of_show` | Run of show | অনুষ্ঠানের ক্রম |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | মেয়াদ শেষ হতে চলা অধিভুক্তি |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | মেয়াদ শেষ হতে চলা লাইসেন্স |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | নিবন্ধনের ব্যতিক্রম |  | ☐ |
| `copilot.task.governance_report` | Governance report | পরিচালনা প্রতিবেদন |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | পূরণ |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | মেয়াদ শেষ হতে চলা অধিকার |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | নবায়নের প্রস্তুতি |  | ☐ |
| `copilot.task.opportunities` | Opportunities | সুযোগ |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | সরবরাহের দায়বদ্ধতা |  | ☐ |
| `copilot.task.maintenance` | Maintenance | রক্ষণাবেক্ষণ |  | ☐ |
| `copilot.task.operations` | Venue operations | ভেন্যুর কার্যক্রম |  | ☐ |
| `copilot.task.my_week` | My officiating week | আমার কর্মকর্তা-সপ্তাহ |  | ☐ |
| `copilot.task.attention` | What needs attention | যেখানে মনোযোগ দরকার |  | ☐ |
| `copilot.task.week` | My week | আমার সপ্তাহ |  | ☐ |
| `copilot.task.goals` | My goals | আমার লক্ষ্য |  | ☐ |
| `copilot.task.training` | Explain my training | আমার প্রশিক্ষণ ব্যাখ্যা করুন |  | ☐ |
| `copilot.task.plan_session` | Plan a session | সেশনের পরিকল্পনা করুন |  | ☐ |
| `copilot.task.player_focus` | Player focus | খেলোয়াড়ের ওপর মনোযোগ |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | বাকি কাজ |  | ☐ |

## ଓଡ଼ିଆ (`or`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | କୋପାଇଲଟ୍ |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | ଭୂମିକା ଆଧାରିତ ସହାୟକ, ଯେଉଁମାନେ ଆପଣ ପୂର୍ବରୁ ଦେଖିପାରୁଥିବା ଜିନିଷ ହିଁ ପଢ଼ନ୍ତି, ଉତ୍ସ କହନ୍ତି ଏବଂ ଆପଣଙ୍କ ପାଇଁ କେବେ ନିଷ୍ପତ୍ତି ନିଅନ୍ତି ନାହିଁ। |  | ☐ |
| `copilot.pick` | Choose a copilot | କୋପାଇଲଟ୍ ବାଛନ୍ତୁ |  | ☐ |
| `copilot.task` | What do you need help with? | ଆପଣଙ୍କୁ କେଉଁଥିରେ ସାହାଯ୍ୟ ଦରକାର? |  | ☐ |
| `copilot.choose` | Choose | ବାଛନ୍ତୁ |  | ☐ |
| `copilot.run` | Prepare draft | ଖସଡ଼ା ପ୍ରସ୍ତୁତ କରନ୍ତୁ |  | ☐ |
| `copilot.draft` | AI draft | AI ଖସଡ଼ା |  | ☐ |
| `copilot.why` | Why | କାହିଁକି |  | ☐ |
| `copilot.no_source` | No record backs this | ଏହାର କୌଣସି ରେକର୍ଡ ଆଧାର ନାହିଁ |  | ☐ |
| `copilot.source_a11y` | Source: {label} | ଉତ୍ସ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | ଅନୁମୋଦନ କରନ୍ତୁ |  | ☐ |
| `copilot.reject` | Reject | ପ୍ରତ୍ୟାଖ୍ୟାନ କରନ୍ତୁ |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | ଅନୁମୋଦନ କରନ୍ତୁ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | ପ୍ରତ୍ୟାଖ୍ୟାନ କରନ୍ତୁ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | କେବଳ ପରାମର୍ଶ। ଏହାକୁ ସମ୍ବନ୍ଧିତ ସ୍କ୍ରିନ୍‌ରେ ନିଜେ ନିଷ୍ପତ୍ତି ନିଅନ୍ତୁ। | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | ସମ୍ପୂର୍ଣ୍ଣ |  | ☐ |
| `copilot.rejected` | Rejected | ପ୍ରତ୍ୟାଖ୍ୟାତ |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} ବୁଝାଇଛି | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | ନିୟମ ଦ୍ୱାରା ତିଆରି, କୌଣସି AI ମଡେଲ୍ ବ୍ୟବହାର ହୋଇନାହିଁ | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | କିଛି ଉପରେ ଧ୍ୟାନ ଦେବାର ଆବଶ୍ୟକତା ନାହିଁ |  | ☐ |
| `copilot.start` | Pick a copilot to begin | ଆରମ୍ଭ କରିବାକୁ ଗୋଟିଏ କୋପାଇଲଟ୍ ବାଛନ୍ତୁ |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | କେବଳ ଖସଡ଼ା। ଆପଣ ଅନୁମୋଦନ ନକରିବା ପର୍ଯ୍ୟନ୍ତ କିଛି ହୁଏ ନାହିଁ। କୋପାଇଲଟ୍ କେବେ ଠିକା ଦିଏ ନାହିଁ, ଚିକିତ୍ସା ଅନୁମତି, ଅନୁଶାସନିକ କାର୍ଯ୍ୟାନୁଷ୍ଠାନ, ବର୍ଗୀକରଣ, ଦସ୍ତଖତ, ସ୍ଥାନାନ୍ତର ଅନୁମୋଦନ କିମ୍ବା ଟଙ୍କା ଘୁଞ୍ଚାଏ ନାହିଁ। | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | ଉଚ୍ଚ |  | ☐ |
| `copilot.sev.medium` | Medium | ମଧ୍ୟମ |  | ☐ |
| `copilot.sev.low` | Low | ନିମ୍ନ |  | ☐ |
| `copilot.status.proposed` | Proposed | ପ୍ରସ୍ତାବିତ |  | ☐ |
| `copilot.status.approved` | Approved | ଅନୁମୋଦିତ |  | ☐ |
| `copilot.status.rejected` | Rejected | ପ୍ରତ୍ୟାଖ୍ୟାତ |  | ☐ |
| `copilot.status.executed` | Done | ସମ୍ପୂର୍ଣ୍ଣ |  | ☐ |
| `copilot.status.failed` | Failed | ବିଫଳ |  | ☐ |
| `copilot.scope.event` | Event | ଇଭେଣ୍ଟ |  | ☐ |
| `copilot.scope.body` | Federation body | ମହାସଂଘ ସଂସ୍ଥା |  | ☐ |
| `copilot.scope.venue` | Venue | ସ୍ଥାନ |  | ☐ |
| `copilot.scope.organisation` | Organisation | ସଂଗଠନ |  | ☐ |
| `copilot.name.coach` | Coach | ପ୍ରଶିକ୍ଷକ |  | ☐ |
| `copilot.name.athlete` | Athlete | କ୍ରୀଡ଼ାବିତ୍ |  | ☐ |
| `copilot.name.event` | Event | ଇଭେଣ୍ଟ |  | ☐ |
| `copilot.name.federation` | Federation | ମହାସଂଘ |  | ☐ |
| `copilot.name.sponsor` | Sponsor | ପ୍ରାୟୋଜକ |  | ☐ |
| `copilot.name.supplier` | Supplier | ଯୋଗାଣକାରୀ |  | ☐ |
| `copilot.name.venue` | Venue | ସ୍ଥାନ |  | ☐ |
| `copilot.name.official` | Official | ଅଧିକାରୀ |  | ☐ |
| `copilot.name.organisation` | Organisation | ସଂଗଠନ |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | ପ୍ରସ୍ତୁତିର ଅଭାବ |  | ☐ |
| `copilot.task.incidents` | Incidents | ଘଟଣା |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | ବିକ୍ରେତା ଅନୁସରଣ |  | ☐ |
| `copilot.task.run_of_show` | Run of show | କାର୍ଯ୍ୟକ୍ରମର କ୍ରମ |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | ମିଆଦ ସରୁଥିବା ସଂଯୋଗ |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | ମିଆଦ ସରୁଥିବା ଲାଇସେନ୍ସ |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | ପଞ୍ଜୀକରଣ ବ୍ୟତିକ୍ରମ |  | ☐ |
| `copilot.task.governance_report` | Governance report | ପରିଚାଳନା ରିପୋର୍ଟ |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | ପୂରଣ |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | ମିଆଦ ସରୁଥିବା ଅଧିକାର |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | ନବୀକରଣ ପ୍ରସ୍ତୁତି |  | ☐ |
| `copilot.task.opportunities` | Opportunities | ସୁଯୋଗ |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | ଯୋଗାଣ ଦାୟିତ୍ୱ |  | ☐ |
| `copilot.task.maintenance` | Maintenance | ରକ୍ଷଣାବେକ୍ଷଣ |  | ☐ |
| `copilot.task.operations` | Venue operations | ସ୍ଥାନ କାର୍ଯ୍ୟ |  | ☐ |
| `copilot.task.my_week` | My officiating week | ମୋର ଅଧିକାରୀ ସପ୍ତାହ |  | ☐ |
| `copilot.task.attention` | What needs attention | ଧ୍ୟାନ ଦରକାର |  | ☐ |
| `copilot.task.week` | My week | ମୋର ସପ୍ତାହ |  | ☐ |
| `copilot.task.goals` | My goals | ମୋର ଲକ୍ଷ୍ୟ |  | ☐ |
| `copilot.task.training` | Explain my training | ମୋର ପ୍ରଶିକ୍ଷଣ ବୁଝାନ୍ତୁ |  | ☐ |
| `copilot.task.plan_session` | Plan a session | ସେସନ୍ ଯୋଜନା କରନ୍ତୁ |  | ☐ |
| `copilot.task.player_focus` | Player focus | ଖେଳାଳିଙ୍କ ଉପରେ ଧ୍ୟାନ |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | ବାକି ଥିବା କାର୍ଯ୍ୟ |  | ☐ |

## සිංහල (`si`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | කෝපයිලට් |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | ඔබට දැනටමත් දැකිය හැකි දේ පමණක් කියවන, මූලාශ්‍ර දක්වන සහ ඔබ වෙනුවෙන් කිසි විටෙකත් තීරණ නොගන්නා භූමිකාව අනුව සහායකයෝ. |  | ☐ |
| `copilot.pick` | Choose a copilot | කෝපයිලට් තෝරන්න |  | ☐ |
| `copilot.task` | What do you need help with? | ඔබට උදව් අවශ්‍ය කුමකටද? |  | ☐ |
| `copilot.choose` | Choose | තෝරන්න |  | ☐ |
| `copilot.run` | Prepare draft | කෙටුම්පත සකසන්න |  | ☐ |
| `copilot.draft` | AI draft | AI කෙටුම්පත |  | ☐ |
| `copilot.why` | Why | ඇයි |  | ☐ |
| `copilot.no_source` | No record backs this | මෙයට කිසිදු වාර්තාවක පදනමක් නැත |  | ☐ |
| `copilot.source_a11y` | Source: {label} | මූලාශ්‍රය: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | අනුමත කරන්න |  | ☐ |
| `copilot.reject` | Reject | ප්‍රතික්ෂේප කරන්න |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | අනුමත කරන්න: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | ප්‍රතික්ෂේප කරන්න: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | උපදෙස් පමණි. මෙය අයත් තිරයේදී ඔබම තීරණය කරන්න. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | අවසන් |  | ☐ |
| `copilot.rejected` | Rejected | ප්‍රතික්ෂේප කළා |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} විසින් පැහැදිලි කළා | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | නීති මගින් සාදන ලදී, AI ආකෘතියක් භාවිත කර නැත | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | අවධානය අවශ්‍ය කිසිවක් නැත |  | ☐ |
| `copilot.start` | Pick a copilot to begin | ආරම්භ කිරීමට කෝපයිලට් එකක් තෝරන්න |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | කෙටුම්පතක් පමණි. ඔබ අනුමත කරන තුරු කිසිවක් සිදු නොවේ. කෝපයිලට් කිසි විටෙකත් කොන්ත්‍රාත්තු ප්‍රදානය, වෛද්‍ය නිදහස් කිරීම, විනය ක්‍රියාමාර්ග, වර්ගීකරණය, අත්සන් කිරීම, මාරු අනුමත කිරීම හෝ මුදල් හුවමාරුව සිදු නොකරයි. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | ඉහළ |  | ☐ |
| `copilot.sev.medium` | Medium | මධ්‍යම |  | ☐ |
| `copilot.sev.low` | Low | පහළ |  | ☐ |
| `copilot.status.proposed` | Proposed | යෝජිත |  | ☐ |
| `copilot.status.approved` | Approved | අනුමත |  | ☐ |
| `copilot.status.rejected` | Rejected | ප්‍රතික්ෂේප |  | ☐ |
| `copilot.status.executed` | Done | අවසන් |  | ☐ |
| `copilot.status.failed` | Failed | අසාර්ථක |  | ☐ |
| `copilot.scope.event` | Event | ඉසව්ව |  | ☐ |
| `copilot.scope.body` | Federation body | සමූහාණ්ඩු ආයතනය |  | ☐ |
| `copilot.scope.venue` | Venue | ස්ථානය |  | ☐ |
| `copilot.scope.organisation` | Organisation | සංවිධානය |  | ☐ |
| `copilot.name.coach` | Coach | පුහුණුකරු |  | ☐ |
| `copilot.name.athlete` | Athlete | මලල ක්‍රීඩකයා |  | ☐ |
| `copilot.name.event` | Event | ඉසව්ව |  | ☐ |
| `copilot.name.federation` | Federation | සමූහාණ්ඩුව |  | ☐ |
| `copilot.name.sponsor` | Sponsor | අනුග්‍රාහකයා |  | ☐ |
| `copilot.name.supplier` | Supplier | සැපයුම්කරු |  | ☐ |
| `copilot.name.venue` | Venue | ස්ථානය |  | ☐ |
| `copilot.name.official` | Official | නිලධාරියා |  | ☐ |
| `copilot.name.organisation` | Organisation | සංවිධානය |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | සූදානම් වීමේ හිඩැස් |  | ☐ |
| `copilot.task.incidents` | Incidents | සිදුවීම් |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | විකුණුම්කරු පසුවිපරම |  | ☐ |
| `copilot.task.run_of_show` | Run of show | ප්‍රදර්ශන අනුපිළිවෙල |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | කල් ඉකුත් වන අනුබද්ධතා |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | කල් ඉකුත් වන බලපත්‍ර |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | ලියාපදිංචි ව්‍යතිරේක |  | ☐ |
| `copilot.task.governance_report` | Governance report | පාලන වාර්තාව |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | ඉටු කිරීම |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | කල් ඉකුත් වන අයිතීන් |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | අලුත් කිරීමේ සූදානම |  | ☐ |
| `copilot.task.opportunities` | Opportunities | අවස්ථා |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | බෙදාහැරීමේ බැඳීම් |  | ☐ |
| `copilot.task.maintenance` | Maintenance | නඩත්තුව |  | ☐ |
| `copilot.task.operations` | Venue operations | ස්ථාන මෙහෙයුම් |  | ☐ |
| `copilot.task.my_week` | My officiating week | මගේ නිලධාරි සතිය |  | ☐ |
| `copilot.task.attention` | What needs attention | අවධානය අවශ්‍ය දේ |  | ☐ |
| `copilot.task.week` | My week | මගේ සතිය |  | ☐ |
| `copilot.task.goals` | My goals | මගේ ඉලක්ක |  | ☐ |
| `copilot.task.training` | Explain my training | මගේ පුහුණුව පැහැදිලි කරන්න |  | ☐ |
| `copilot.task.plan_session` | Plan a session | සැසියක් සැලසුම් කරන්න |  | ☐ |
| `copilot.task.player_focus` | Player focus | ක්‍රීඩකයා කෙරෙහි අවධානය |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | ඉතිරි ක්‍රියාමාර්ග |  | ☐ |

## اردو (`ur`, right-to-left) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | کو پائلٹ |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | کردار پر مبنی معاون جو صرف وہی پڑھتے ہیں جو آپ پہلے سے دیکھ سکتے ہیں، ذرائع بتاتے ہیں اور آپ کی جگہ کبھی فیصلہ نہیں کرتے۔ |  | ☐ |
| `copilot.pick` | Choose a copilot | کو پائلٹ منتخب کریں |  | ☐ |
| `copilot.task` | What do you need help with? | آپ کو کس چیز میں مدد چاہیے؟ |  | ☐ |
| `copilot.choose` | Choose | منتخب کریں |  | ☐ |
| `copilot.run` | Prepare draft | مسودہ تیار کریں |  | ☐ |
| `copilot.draft` | AI draft | AI مسودہ |  | ☐ |
| `copilot.why` | Why | کیوں |  | ☐ |
| `copilot.no_source` | No record backs this | اس کی کوئی ریکارڈ بنیاد نہیں |  | ☐ |
| `copilot.source_a11y` | Source: {label} | ماخذ: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | منظور کریں |  | ☐ |
| `copilot.reject` | Reject | مسترد کریں |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | منظور کریں: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | مسترد کریں: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | صرف مشورہ۔ یہ فیصلہ اسی اسکرین میں خود کریں جو اس کی مالک ہے۔ | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | مکمل |  | ☐ |
| `copilot.rejected` | Rejected | مسترد |  | ☐ |
| `copilot.by_model` | Explained by {model} | {model} نے وضاحت کی | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | اصولوں سے بنایا گیا، کوئی AI ماڈل استعمال نہیں ہوا | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | کسی چیز پر توجہ کی ضرورت نہیں |  | ☐ |
| `copilot.start` | Pick a copilot to begin | شروع کرنے کے لیے کو پائلٹ منتخب کریں |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | صرف مسودہ۔ آپ کی منظوری تک کچھ نہیں ہوتا۔ کو پائلٹ کبھی ٹھیکہ نہیں دیتا، طبی کلیئرنس، تادیبی کارروائی، درجہ بندی، دستخط، ٹرانسفر کی منظوری یا رقم کی منتقلی نہیں کرتا۔ | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | اعلیٰ |  | ☐ |
| `copilot.sev.medium` | Medium | درمیانی |  | ☐ |
| `copilot.sev.low` | Low | کم |  | ☐ |
| `copilot.status.proposed` | Proposed | تجویز کردہ |  | ☐ |
| `copilot.status.approved` | Approved | منظور شدہ |  | ☐ |
| `copilot.status.rejected` | Rejected | مسترد |  | ☐ |
| `copilot.status.executed` | Done | مکمل |  | ☐ |
| `copilot.status.failed` | Failed | ناکام |  | ☐ |
| `copilot.scope.event` | Event | ایونٹ |  | ☐ |
| `copilot.scope.body` | Federation body | فیڈریشن کا ادارہ |  | ☐ |
| `copilot.scope.venue` | Venue | مقام |  | ☐ |
| `copilot.scope.organisation` | Organisation | تنظیم |  | ☐ |
| `copilot.name.coach` | Coach | کوچ |  | ☐ |
| `copilot.name.athlete` | Athlete | کھلاڑی |  | ☐ |
| `copilot.name.event` | Event | ایونٹ |  | ☐ |
| `copilot.name.federation` | Federation | فیڈریشن |  | ☐ |
| `copilot.name.sponsor` | Sponsor | اسپانسر |  | ☐ |
| `copilot.name.supplier` | Supplier | سپلائر |  | ☐ |
| `copilot.name.venue` | Venue | مقام |  | ☐ |
| `copilot.name.official` | Official | آفیشل |  | ☐ |
| `copilot.name.organisation` | Organisation | تنظیم |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | تیاری کی کمیاں |  | ☐ |
| `copilot.task.incidents` | Incidents | واقعات |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | وینڈر فالو اپ |  | ☐ |
| `copilot.task.run_of_show` | Run of show | پروگرام کی ترتیب |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | ختم ہوتی وابستگیاں |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | ختم ہوتے لائسنس |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | رجسٹریشن استثنائی صورتیں |  | ☐ |
| `copilot.task.governance_report` | Governance report | گورننس رپورٹ |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | تکمیل |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | ختم ہوتے حقوق |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | تجدید کی تیاری |  | ☐ |
| `copilot.task.opportunities` | Opportunities | مواقع |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | ترسیل کی ذمہ داریاں |  | ☐ |
| `copilot.task.maintenance` | Maintenance | دیکھ بھال |  | ☐ |
| `copilot.task.operations` | Venue operations | مقام کے امور |  | ☐ |
| `copilot.task.my_week` | My officiating week | میرا آفیشل ہفتہ |  | ☐ |
| `copilot.task.attention` | What needs attention | کس پر توجہ چاہیے |  | ☐ |
| `copilot.task.week` | My week | میرا ہفتہ |  | ☐ |
| `copilot.task.goals` | My goals | میرے اہداف |  | ☐ |
| `copilot.task.training` | Explain my training | میری تربیت سمجھائیں |  | ☐ |
| `copilot.task.plan_session` | Plan a session | سیشن کی منصوبہ بندی کریں |  | ☐ |
| `copilot.task.player_focus` | Player focus | کھلاڑی پر توجہ |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | باقی کام |  | ☐ |

## Bahasa Indonesia (`id`) — reviewed: false

| Key | English | Current text | Note | OK |
|---|---|---|---|---|
| `copilot.title` | Copilots | Kopilot |  | ☐ |
| `copilot.intro` | Role-based helpers that read only what you may already see, name their sources and never decide for you. | Asisten berbasis peran yang hanya membaca apa yang sudah boleh Anda lihat, menyebut sumbernya, dan tidak pernah memutuskan untuk Anda. |  | ☐ |
| `copilot.pick` | Choose a copilot | Pilih kopilot |  | ☐ |
| `copilot.task` | What do you need help with? | Apa yang perlu dibantu? |  | ☐ |
| `copilot.choose` | Choose | Pilih |  | ☐ |
| `copilot.run` | Prepare draft | Siapkan draf |  | ☐ |
| `copilot.draft` | AI draft | Draf AI |  | ☐ |
| `copilot.why` | Why | Mengapa |  | ☐ |
| `copilot.no_source` | No record backs this | Tidak ada catatan yang mendukung ini |  | ☐ |
| `copilot.source_a11y` | Source: {label} | Sumber: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.approve` | Approve | Setujui |  | ☐ |
| `copilot.reject` | Reject | Tolak |  | ☐ |
| `copilot.approve_a11y` | Approve: {label} | Setujui: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.reject_a11y` | Reject: {label} | Tolak: {label} | Screen-reader label; keep {label}. | ☐ |
| `copilot.advisory` | Advisory only. Decide this yourself in the screen that owns it. | Hanya saran. Putuskan sendiri di layar yang memilikinya. | Advisory only: the person decides in the screen that owns the decision. | ☐ |
| `copilot.done` | Done | Selesai |  | ☐ |
| `copilot.rejected` | Rejected | Ditolak |  | ☐ |
| `copilot.by_model` | Explained by {model} | Dijelaskan oleh {model} | {model} is replaced by the model name; keep the placeholder. | ☐ |
| `copilot.by_rules` | Built by rules, no AI model used | Dibuat dengan aturan, tanpa model AI | Plain statement that no AI model was used. | ☐ |
| `copilot.empty` | Nothing needs attention | Tidak ada yang perlu diperhatikan |  | ☐ |
| `copilot.start` | Pick a copilot to begin | Pilih kopilot untuk memulai |  | ☐ |
| `copilot.guardrail` | A draft only. Nothing happens until you approve. A copilot never awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | Hanya draf. Tidak ada yang terjadi sampai Anda menyetujui. Kopilot tidak pernah memberi tender, izin medis, sanksi disiplin, klasifikasi, tanda tangan, persetujuan transfer, atau memindahkan uang. | Must stay negative: a copilot NEVER awards, clears medically, disciplines, classifies, signs, approves transfers or moves money. | ☐ |
| `copilot.sev.high` | High | Tinggi |  | ☐ |
| `copilot.sev.medium` | Medium | Sedang |  | ☐ |
| `copilot.sev.low` | Low | Rendah |  | ☐ |
| `copilot.status.proposed` | Proposed | Diusulkan |  | ☐ |
| `copilot.status.approved` | Approved | Disetujui |  | ☐ |
| `copilot.status.rejected` | Rejected | Ditolak |  | ☐ |
| `copilot.status.executed` | Done | Selesai |  | ☐ |
| `copilot.status.failed` | Failed | Gagal |  | ☐ |
| `copilot.scope.event` | Event | Acara |  | ☐ |
| `copilot.scope.body` | Federation body | Badan federasi |  | ☐ |
| `copilot.scope.venue` | Venue | Tempat |  | ☐ |
| `copilot.scope.organisation` | Organisation | Organisasi |  | ☐ |
| `copilot.name.coach` | Coach | Pelatih |  | ☐ |
| `copilot.name.athlete` | Athlete | Atlet |  | ☐ |
| `copilot.name.event` | Event | Acara |  | ☐ |
| `copilot.name.federation` | Federation | Federasi |  | ☐ |
| `copilot.name.sponsor` | Sponsor | Sponsor |  | ☐ |
| `copilot.name.supplier` | Supplier | Pemasok |  | ☐ |
| `copilot.name.venue` | Venue | Tempat |  | ☐ |
| `copilot.name.official` | Official | Ofisial |  | ☐ |
| `copilot.name.organisation` | Organisation | Organisasi |  | ☐ |
| `copilot.task.readiness_gaps` | Readiness gaps | Kesenjangan kesiapan |  | ☐ |
| `copilot.task.incidents` | Incidents | Insiden |  | ☐ |
| `copilot.task.vendor_followup` | Vendor follow-up | Tindak lanjut vendor |  | ☐ |
| `copilot.task.run_of_show` | Run of show | Rundown acara |  | ☐ |
| `copilot.task.expiring_affiliations` | Expiring affiliations | Afiliasi akan berakhir |  | ☐ |
| `copilot.task.expiring_licences` | Expiring licences | Lisensi akan berakhir |  | ☐ |
| `copilot.task.registration_exceptions` | Registration exceptions | Pengecualian pendaftaran |  | ☐ |
| `copilot.task.governance_report` | Governance report | Laporan tata kelola |  | ☐ |
| `copilot.task.fulfilment` | Fulfilment | Pemenuhan |  | ☐ |
| `copilot.task.expiring_rights` | Expiring rights | Hak akan berakhir |  | ☐ |
| `copilot.task.renewal_prep` | Renewal preparation | Persiapan perpanjangan |  | ☐ |
| `copilot.task.opportunities` | Opportunities | Peluang |  | ☐ |
| `copilot.task.delivery_obligations` | Delivery obligations | Kewajiban pengiriman |  | ☐ |
| `copilot.task.maintenance` | Maintenance | Pemeliharaan |  | ☐ |
| `copilot.task.operations` | Venue operations | Operasional tempat |  | ☐ |
| `copilot.task.my_week` | My officiating week | Pekan ofisial saya |  | ☐ |
| `copilot.task.attention` | What needs attention | Yang perlu diperhatikan |  | ☐ |
| `copilot.task.week` | My week | Pekan saya |  | ☐ |
| `copilot.task.goals` | My goals | Tujuan saya |  | ☐ |
| `copilot.task.training` | Explain my training | Jelaskan latihan saya |  | ☐ |
| `copilot.task.plan_session` | Plan a session | Rencanakan sesi |  | ☐ |
| `copilot.task.player_focus` | Player focus | Fokus pemain |  | ☐ |
| `copilot.task.outstanding_actions` | Outstanding actions | Tindakan tertunda |  | ☐ |
