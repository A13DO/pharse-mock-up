import { Injectable } from '@angular/core';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Packer,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx';

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'groq';

/** Segment kinds determined at extraction time */
type SegmentKind =
  | 'translate' // send to AI
  | 'copy-source' // keep source as target (e.g. pure numbers)
  | 'skip'; // locked or empty — leave target untouched

interface Segment {
  id: string;
  segNum: number;
  sourceText: string;
  kind: SegmentKind;
}

const PROXY_BASE = 'http://localhost:3001';

const SYSTEM_PROMPT =
  'You are a professional translation assistant. ' +
  'Return ONLY the translated document in markdown format. ' +
  'Use # for H1, ## for H2, ### for H3, **bold** for bold text. ' +
  'No preamble, no commentary, no explanations.';

@Injectable({
  providedIn: 'root',
})
export class DocxTranslationService {
  private originalDocxBuffer: ArrayBuffer | null = null;
  private originalBuffer: ArrayBuffer | null = null;
  private originalFileType: 'docx' | 'mxliff' | null = null;

  // TEST MODE FLAG - Set to true to use mock responses instead of API calls
  private TEST_MODE = true;

  async translateDocument(
    file: File,
    customPrompt: string,
    provider: Provider,
    apiKey: string,
    model = '',
  ): Promise<{
    blob: Blob;
    filename: string;
    responseText: string;
    fileType: 'docx' | 'mxliff';
  }> {
    console.log('\n🚀 ============ STARTING TRANSLATION WORKFLOW ============');
    console.log('📂 File:', file.name);
    console.log('🤖 Provider:', provider.toUpperCase());
    console.log('🔧 Model:', model || '(default)');
    console.log('📏 File size:', (file.size / 1024).toFixed(2), 'KB');
    console.log('========================================================\n');

    // Step 1: Extract plain text (supports both DOCX and MXLIFF)
    console.log('\n📖 STEP 1: Extracting text from file...');
    const extractedText = await this.extractTextFromFile(file);
    console.log('✅ Extraction complete!');
    console.log('   📊 Total characters extracted:', extractedText.length);
    console.log(
      '   📊 Total words (approx):',
      extractedText.split(/\s+/).length,
    );
    console.log('   📄 Preview (first 200 chars):');
    console.log(
      '   ',
      extractedText.substring(0, 200).replace(/\n/g, ' '),
      '...',
    );

    // Step 2: Call AI (with batching for large MXLIFF files)
    console.log('\n🤖 STEP 2: Calling', provider.toUpperCase(), 'API...');
    console.log('   📝 Prompt length:', customPrompt.length, 'chars');
    console.log('   📝 Document length:', extractedText.length, 'chars');
    console.log(
      '   📝 Combined payload size:',
      customPrompt.length + extractedText.length,
      'chars',
    );

    let translatedText: string;

    // Use batching for MXLIFF files with Cell # markers (large segment-based translations)
    if (
      this.originalFileType === 'mxliff' &&
      extractedText.includes('[Cell #')
    ) {
      const cellCount = (extractedText.match(/\[Cell #/g) || []).length;
      console.log(`   📊 Detected ${cellCount} cells in MXLIFF file`);

      // Use batching if more than 500 cells to avoid token limits
      if (cellCount > 500) {
        console.log('   🔄 Using batched translation for large document...\n');
        translatedText = await this.translateInBatches(
          extractedText,
          customPrompt,
          provider,
          apiKey,
          model,
        );
      } else {
        translatedText = await this.callProvider(
          provider,
          apiKey,
          customPrompt,
          extractedText,
          model,
        );
      }
    } else {
      // Regular single-call translation for DOCX or small MXLIFF
      translatedText = await this.callProvider(
        provider,
        apiKey,
        customPrompt,
        extractedText,
        model,
      );
    }

    console.log('✅ AI response received!');
    console.log('   📊 Response length:', translatedText.length, 'chars');
    console.log('   📄 Preview (first 300 chars):');
    console.log(
      '   ',
      translatedText.substring(0, 300).replace(/\n/g, ' '),
      '...',
    );

    // Step 3: Rebuild DOCX
    console.log('\n📝 STEP 3: Building DOCX file...');
    const blob = await this.buildDocx(translatedText);
    console.log('✅ DOCX file created!');
    console.log('   📊 File size:', (blob.size / 1024).toFixed(2), 'KB');

    const originalName = file.name.replace(
      /\.(docx|mxlf|mxliff|xliff|xml)$/i,
      '',
    );
    const filename = `${originalName}_translated_${provider}.docx`;

    console.log('\n✅ ============ TRANSLATION WORKFLOW COMPLETE ============');
    console.log('📦 Output file:', filename);
    console.log('========================================================\n');

    return {
      blob,
      filename,
      responseText: translatedText,
      fileType: this.originalFileType || 'docx',
    };
  }

  /**
   * Extract text from any supported file type
   * @param file - DOCX or MXLIFF file
   * @returns Extracted plain text
   */
  async extractTextFromFile(file: File): Promise<string> {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.docx')) {
      this.originalFileType = 'docx';
      return this.extractTextFromDocx(file);
    } else if (
      fileName.endsWith('.mxlf') ||
      fileName.endsWith('.mxliff') ||
      fileName.endsWith('.xliff') ||
      fileName.endsWith('.xml')
    ) {
      this.originalFileType = 'mxliff';
      return this.extractTextFromMxliff(file);
    } else {
      throw new Error(
        'Unsupported file type. Please upload a .docx or .mxliff file.',
      );
    }
  }

  /**
   * Extract raw text from DOCX file
   * For bilingual DOCX files from Phrase TMS, extracts ONLY source text from locked SDTs
   */
  private async extractTextFromDocx(file: File): Promise<string> {
    // Read the file into an ArrayBuffer first, outside the mammoth call
    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as ArrayBuffer);
      reader.onerror = () =>
        reject(new Error(`FileReader failed: ${reader.error?.message}`));
      reader.readAsArrayBuffer(file);
    });

    console.log('📄 ArrayBuffer size:', arrayBuffer.byteLength, 'bytes');

    // Store the original buffer for later use
    this.originalDocxBuffer = arrayBuffer;
    this.originalBuffer = arrayBuffer;

    if (arrayBuffer.byteLength === 0) {
      throw new Error(
        'The downloaded file is empty. Check that the Phrase TMS job has an original file attached.',
      );
    }

    // DOCX files start with the PK magic bytes (0x50 0x4B) — ZIP format
    const header = new Uint8Array(arrayBuffer.slice(0, 4));
    const isPK = header[0] === 0x50 && header[1] === 0x4b;
    if (!isPK) {
      throw new Error(
        `File does not appear to be a valid DOCX (expected ZIP/PK header, got 0x${header[0].toString(16)}${header[1].toString(16)}). ` +
          'The Phrase API may have returned HTML or an error page instead of the binary file.',
      );
    }

    try {
      // For bilingual DOCX files from Phrase TMS, use XML-based extraction
      // to get only source segments (locked SDTs)
      const zip = await JSZip.loadAsync(arrayBuffer);
      const documentXml = await zip.file('word/document.xml')?.async('text');

      if (!documentXml) {
        throw new Error('word/document.xml not found in DOCX');
      }

      // Parse XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(documentXml, 'application/xml');

      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        throw new Error('Failed to parse word/document.xml');
      }

      // Find all SDT (Structured Document Tag) elements
      const sdtElements = xmlDoc.querySelectorAll('sdt');
      const sourceTexts: string[] = [];

      sdtElements.forEach((sdt) => {
        // Check if this SDT is LOCKED (source cell - read-only)
        const lockElement = sdt.querySelector(
          'sdtPr lock[w\\:val="sdtContentLocked"]',
        );

        // We want ONLY locked SDTs (source segments), skip unlocked ones (target segments)
        if (!lockElement) {
          return;
        }

        // Extract text from locked SDT (source segment)
        const sdtContent = sdt.querySelector('sdtContent');
        const textNodes = sdtContent?.querySelectorAll('t');
        let sourceText = '';

        textNodes?.forEach((textNode) => {
          sourceText += textNode.textContent || '';
        });

        const trimmed = sourceText.trim();

        // Accept all non-empty locked SDT content (classification happens later)
        if (trimmed) {
          sourceTexts.push(trimmed);
        }
      });

      if (sourceTexts.length === 0) {
        console.warn(
          '⚠️ No source segments found in locked SDTs, falling back to mammoth extraction',
        );
        // Fall back to mammoth if XML parsing didn't find source segments
        const rawResult = await mammoth.extractRawText({ arrayBuffer });
        return rawResult.value;
      }

      const result_text = sourceTexts.join('\n\n');
      console.log(
        `✅ Extracted ${sourceTexts.length} source segments from locked SDTs`,
      );

      return result_text;
    } catch (err: any) {
      throw new Error(`Failed to extract source text: ${err?.message || err}`);
    }
  }

  /**
   * Classify a segment based on its content
   *
   * Classification rules:
   * - empty → 'skip' (nothing to translate)
   * - pure numbers → 'copy-source' (123, 1234, etc.)
   * - EVERYTHING ELSE → 'translate' (single characters like "p", words, sentences, mixed content, formatted numbers, locked segments, etc.)
   */
  private classifySegment(sourceText: string, isLocked: boolean): SegmentKind {
    const trimmed = sourceText.trim();

    // Rule 1: Empty segments → skip
    if (!trimmed) return 'skip';

    // Rule 2: Pure integer numbers only → copy-source
    if (/^\d+$/.test(trimmed)) return 'copy-source';

    // Rule 3: EVERYTHING ELSE → translate
    return 'translate';
  }

  /**
   * Extract translatable text from MXLIFF file
   * MXLIFF is an XML format used by translation tools
   */
  private async extractTextFromMxliff(file: File): Promise<string> {
    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as ArrayBuffer);
      reader.onerror = () =>
        reject(new Error(`FileReader failed: ${reader.error?.message}`));
      reader.readAsArrayBuffer(file);
    });
    this.originalBuffer = arrayBuffer;

    const segments = await this.extractSegmentsFromMxliff();
    // Send ALL segments to AI (translate + copy-source), skip only empty ones
    const toTranslate = segments.filter((s) => s.kind !== 'skip');

    console.log(`\n📤 Preparing ${toTranslate.length} segments for AI...\n`);

    // Format each segment with cell number for the AI
    const formattedSegments = toTranslate.map((s, idx) => {
      const cellNum = idx + 1;
      return `[Cell #${cellNum}]\n${s.sourceText}`;
    });

    const result = formattedSegments.join('\n\n');

    return result;
  }

  /**
   * Batch segments and make multiple AI calls to handle large documents
   * @param extractedText - Formatted segments with Cell # markers
   * @param customPrompt - Translation instructions
   * @param provider - AI provider
   * @param apiKey - API key
   * @param model - Model name
   * @returns Combined AI response with all translations
   */
  async translateInBatches(
    extractedText: string,
    customPrompt: string,
    provider: Provider,
    apiKey: string,
    model: string,
  ): Promise<string> {
    // Parse segments from formatted text
    const segmentPattern = /\[Cell #(\d+)\]\n([\s\S]*?)(?=\[Cell #|\n\n$|$)/g;
    const segments: { cellNum: number; text: string }[] = [];
    let match;

    while ((match = segmentPattern.exec(extractedText)) !== null) {
      segments.push({
        cellNum: parseInt(match[1], 10),
        text: match[2].trim(),
      });
    }

    console.log(`📦 Total segments to translate: ${segments.length}`);

    // **TEST MODE** - Return mock translation table with all segments
    if (this.TEST_MODE) {
      console.log(
        '🧪 TEST MODE ACTIVE - Generating complete mock translation response...',
      );
      console.log('   📋 Creating translation table for all segments...');

      // Generate mock translation table with all cells
      // const mockRows = segments
      //   .map((seg) => {
      //     const sourcePreview =
      //       seg.text.length > 100
      //         ? seg.text.substring(0, 100) + '...'
      //         : seg.text;
      //     const mockTranslation = `[ترجمة عربية تجريبية للخلية ${seg.cellNum}]`;
      //     return `| ${seg.cellNum} | ${sourcePreview} | ${mockTranslation} |`;
      //   })
      //   .join('\n');

      const mockResponse = `
| Cell # | Source | Translation |
|--------|--------|-------------|
| 1 | I am representing all investors who have been adversely affected by the fraudulent actions of Mr. Ravi Subodh Mahaseth, who is currently residing unlawfully in Dubai, UAE. | أنا أمثّل جميع المستثمرين الذين لحقت بهم أضرار جسيمة جراء الأفعال الاحتيالية التي ارتكبها السيد راڤي سوبودh ماهاسيث، المقيم حالياً بصورة غير مشروعة في دبي، الإمارات العربية المتحدة. |
| 2 | I have annexed herewith comprehensive bullet points and associated documents pertaining to this matter. | وقد أرفقت طيّ هذه الوثيقة نقاطاً تفصيلية شاملة والمستندات ذات الصلة المتعلقة بهذه القضية. |
| 3 | I hereby provide the following information, which may assist in the prosecution of Mr. Ravi Mahaseth in Dubai, UAE. | أقدّم فيما يلي المعلومات التي قد تُسهم في ملاحقة السيد راڤي ماهاسيث قضائياً في دبي، الإمارات العربية المتحدة. |
| 4 | On the 12th day of February in the year 2025, Mr. Ravi Subodh Mahaseth was taken into custody at Goa Airport, India. | في الثاني عشر من فبراير عام 2025، جرى القبض على السيد راڤي سوبودh ماهاسيث في مطار غوا، الهند. |
| 5 | The arrest was executed by the Hyderabad Police, as the Look-Out Circular issued by the Hyderabad Police was in effect and continues to be in force. | نفّذت شرطة حيدر آباد عملية الاعتقال، استناداً إلى نشرة المراقبة الصادرة عنها، والتي كانت سارية المفعول ولا تزال نافذة حتى الآن. |
| 6 | An FIR has been registered pertaining to the offenses of cheating and criminal breach of trust. | تمّ تسجيل بلاغ أوّلي بشأن جرائم الاحتيال وخيانة الأمانة الجنائية. |
| 7 | Subsequent to his arrest, the Sessions Court of Hyderabad, on the 24th of February 2026, issued a ruling, granting bail, taking into account the accused's medical conditions as a significant factor in its determination. | إثر اعتقاله، أصدرت محكمة الجلسات في حيدر آباد بتاريخ الرابع والعشرين من فبراير 2026 حكماً بالإفراج عنه بكفالة، مراعيةً في قرارها الحالةَ الصحية للمتهم بوصفها عاملاً جوهرياً. |
| 8 | In the interim, another First Information Report pertaining to analogous offenses was duly registered at the Kasturba Marg Police Station, Borivali, Mumbai, Maharashtra on the 19th day of February in the year 2025. | في غضون ذلك، سُجِّل بلاغ أوّلي آخر يتعلق بجرائم مماثلة لدى مركز شرطة كاستوربا مارغ في بوريڤالي، مومباي، ماهاراشترا، وذلك في التاسع عشر من فبراير عام 2025. |
| 9 | Furthermore, an additional Look-Out Circular was issued on the 25th day of February in the year 2025. | علاوةً على ذلك، صدرت نشرة مراقبة إضافية في الخامس والعشرين من فبراير عام 2025. |
| 10 | There exists an additional Look-Out-Circular currently in effect issued by the Malad Police Station, located in Mumbai, Maharashtra. | ثمة نشرة مراقبة إضافية سارية المفعول حالياً، صادرة عن مركز شرطة مالاد في مومباي، ماهاراشترا. |
| 11 | In total 3 Look-Out-Circulars are in force against Mr. Ravi Mahaseth. | يبلغ مجموع نشرات المراقبة النافذة بحق السيد راڤي ماهاسيث ثلاث نشرات. |
| 12 | The police department of Hyderabad has initiated proceedings for the revocation of the bail previously granted to Mr. Ravi Mahaseth and has subsequently issued a Non-Bailable Warrant for his apprehension. | باشرت شرطة حيدر آباد إجراءات إلغاء الكفالة الممنوحة سابقاً للسيد راڤي ماهاسيث، وأصدرت في أعقاب ذلك مذكرة توقيف لا تقبل الكفالة بحقه. |
| 13 | In addition to the numerous complaints lodged against Mr. Ravi Subodh Mahaseth, Mrs. Rupa Mahaseth, Mr. Bhavin Chauhan, Mr. Aaditya Chaudhary, Mr. Abhishek Sahu, and Mr. Akshay Kadam at various police stations, a further First Information Report (FIR) has been duly registered at the Kashigaon Police Station, located in Mira Road, Thane, Maharashtra. | فضلاً عن البلاغات العديدة المقدَّمة في مراكز الشرطة المختلفة ضد السيد راڤي سوبودh ماهاسيث، والسيدة روبا ماهاسيث، والسيد بهاڤين تشوهان، والسيد آديتيا تشودهاري، والسيد أبهيشيك ساهو، والسيد أكشاي كادام، فقد سُجِّل بلاغ أوّلي إضافي في مركز شرطة كاشيغاون الواقع في ميرا رود، ثانه، ماهاراشترا. |
| 14 | On the 27th day of March in the year 2026, a criminal complaint has been duly filed against Mr. Ravi Subodh Mahaseth with the Government of Ras Al Khaimah, United Arab Emirates. | في السابع والعشرين من مارس عام 2026، تمّ تقديم شكوى جنائية رسمية ضد السيد راڤي سوبودh ماهاسيث إلى حكومة رأس الخيمة، الإمارات العربية المتحدة. |
| 15 | The particulars thereof are hereby attached for your review. | تُرفق تفاصيل ذلك طيّ هذه الوثيقة لاطلاعكم. |
| 16 | On the 23rd day of April in the year 2026, I duly registered a First Information Report at the Badlapur Police Station, located in Thane, Maharashtra. | في الثالث والعشرين من أبريل عام 2026، قدّمت بلاغاً أوّلياً رسمياً لدى مركز شرطة بادلابور الواقع في ثانه، ماهاراشترا. |
| 17 | Under the present circumstances, Mr. Ravi Mahaseth is classified as a wanted criminal in India and has unlawfully arrived in Dubai UAE, after his arrest in India, in contravention of all terms and conditions mandated by the Hon'ble Sessions Court of Hyderabad, India. | في ظل الأوضاع الراهنة، يُصنَّف السيد راڤي ماهاسيث مجرماً مطلوباً في الهند، وقد توجّه إلى دبي بصورة غير مشروعة عقب اعتقاله في الهند، في انتهاك صريح لجميع الشروط والأحكام التي فرضتها عليه محكمة الجلسات الموقّرة في حيدر آباد، الهند. |
| 18 | A recording of the Zoom call conducted by Mr. Ravi Mahaseth on the 29th of March, 2025, from 5:00 p.m. to 6:00 p.m. has also been submitted. | كما أُرفق تسجيل مكالمة زوم أجراها السيد راڤي ماهاسيث بتاريخ التاسع والعشرين من مارس 2025، من الساعة الخامسة مساءً حتى السادسة مساءً. |
| 19 | This recording serves as evidence of his presence in Malaysia on that date, contrary to the stipulations of his bail conditions requiring him to be in India. | يُثبت هذا التسجيل وجوده في ماليزيا في ذلك التاريخ، وهو ما يتناقض مع شروط كفالته التي تُلزمه بالبقاء في الهند. |
| 20 | An individual who has transgressed the laws of his nation is unlikely to serve as a beneficial member of your society and may, through his conduct, pose a significant criminal threat to your citizens. | إن من يتجرأ على انتهاك قوانين وطنه لن يكون عنصراً نافعاً في مجتمعكم، وقد يشكّل من خلال سلوكه تهديداً جنائياً جسيماً لمواطنيكم. |
| 21 | I am confident that the Government of Dubai, UAE will duly acknowledge his unlawful entry and residence and may proceed to implement the requisite measures for his deportation in compliance with applicable legal provisions. | أثق بأن حكومة دبي، الإمارات العربية المتحدة، ستُقرّ بدخوله وإقامته غير المشروعين، وستتخذ الإجراءات اللازمة لترحيله وفق ما تقتضيه الأحكام القانونية المعمول بها. |
| 22 | It is my expectation that the information herein, substantiated by official documents from the Government of India and the Judiciary, will serve as a valuable resource for you in your efforts to maintain the integrity of your nation against transgressors from foreign jurisdictions. | أرجو أن تكون المعلومات الواردة هنا، المدعومة بوثائق رسمية من حكومة الهند والجهاز القضائي، مرجعاً قيّماً لكم في مساعيكم للحفاظ على سلامة بلدكم في مواجهة المخالفين القادمين من ولايات قضائية أجنبية. |
| 23 | Appreciate your support and concern. | أتقدّم بخالص الشكر على دعمكم واهتمامكم. |
| 24 | {b>Ravi Mahaseth<b} | {b>راڤي ماهاسيث<b} |
| 25 | {b>Emirates ID<b} | {b>الهوية الإماراتية<b} |
| 26 | {b>Hyderabad<b} | {b>حيدر آباد<b} |
| 27 | {b>CCF Police station<b} | {b>مركز شرطة CCF<b} |
| 28 | {b>FIR Against<b} | {b>بلاغ أوّلي ضد<b} |
| 29 | {b>Ravi Mahaseth<b} | {b>راڤي ماهاسيث<b} |
| 30 | {u>TRUE COPY<u} | {u>نسخة طبق الأصل<u} |
| 31 | {bu>FIRST INFORMATION REPORT<bu} | {bu>البلاغ الأوّلي<bu} |
| 32 | (Under section 173 and 176 BNSS) | (بموجب المادتين 173 و176 من نظام BNSS) |
| 33 | {b>T.S.P.M.<b} | {b>T.S.P.M.<b} |
| 34 | {b>Orders 470,500<b} | {b>الأوامر 470,500<b} |
| 35 | 1. | 1. |
| 36 | {b>District<b} | {b>المنطقة<b} |
| 37 | Hyderabad | حيدر آباد |
| 38 | {b>P.S.<b} | {b>مركز الشرطة<b} |
| 39 | INSP ADMIN (DD) | INSP ADMIN (DD) |
| 40 | {b>Year<b} | {b>السنة<b} |
| 41 | {b>FIR No.<b} | {b>رقم البلاغ الأوّلي<b} |
| 42 | 16/2025 | 16/2025 |
| 43 | {b>Date<b} | {b>التاريخ<b} |
| 44 | 11-02-2025 | 11-02-2025 |
| 45 | 2. | 2. |
| 46 | {b>Acts & Section(s):<b} | {b>القوانين والمواد:<b} |
| 47 | 406,420,r/w 120b IPC | 406، 420، بالاقتران مع 120ب من قانون العقوبات الهندي |
| 48 | 3. | 3. |
| 49 | {b>a) Occurrence of Offence:<b} | {b>أ) وقوع الجريمة:<b} |
| 50 | {b>Day<b} | {b>اليوم<b} |
| 51 | Wednesday | الأربعاء |
| 52 | {b>Date & Time From<b} | {b>التاريخ والوقت من<b} |
| 53 | ………………………………. | ………………………………. |
| 54 | {b>Date & Time To<b} | {b>التاريخ والوقت إلى<b} |
| 55 | ……….……… | ……….……… |
| 56 | {b>Prior To<b} | {b>قبل<b} |
| 57 | 01-02-2023 10:00:00 | 01-02-2023 10:00:00 |
| 58 | {b>Time Period<b} | {b>الفترة الزمنية<b} |
| 59 | ………………… | ………………… |
| 60 | {b>b) Information Received at P.S.:<b} | {b>ب) تاريخ ووقت استلام البلاغ في مركز الشرطة:<b} |
| 61 | {b>Date & Time<b} | {b>التاريخ والوقت<b} |
| 62 | 11-02-2025 18:45:00 | 11-02-2025 18:45:00 |
| 63 | {b>General Diary Reference:<b} | {b>مرجع السجل العام:<b} |
| 64 | {b>Entry No<b} | {b>رقم القيد<b} |
| 65 | {b>Date & Time<b} | {b>التاريخ والوقت<b} |
| 66 | 11-02-2025 18:45:00 | 11-02-2025 18:45:00 |
| 67 | 4. | 4. |
| 68 | {b>Type of Information:<b} | {b>نوع البلاغ:<b} |
| 69 | Written | مكتوب |
| 70 | 5. | 5. |
| 71 | {b>Place of Occurrence:<b} | {b>مكان وقوع الحادثة:<b} |
| 72 | {b>a) Distance and Direction From P.S.:<b} | {b>أ) المسافة والاتجاه من مركز الشرطة:<b} |
| 73 | ……………………………… | ……………………………… |
| 74 | {b>Beat No.<b} | {b>رقم الدورية<b} |
| 75 | …………………………….  . | …………………………….. |
| 76 | {b>b) Address<b} | {b>ب) العنوان<b} |
| 77 | {b>Place<b} | {b>المكان<b} |
| 78 | …………….. | …………….. |
| 79 | {b>Area/ Mandal<b} | {b>المنطقة / المندال<b} |
| 80 | ………………. | ………………. |
| 81 | {b>Street/Village<b} | {b>الشارع / القرية<b} |
| 82 | ……………. | ……………. |
| 83 | {b>City/District<b} | {b>المدينة / المنطقة<b} |
| 84 | Hyderabad | حيدر آباد |
| 85 | {b>State<b} | {b>الولاية<b} |
| 86 | Telangana | تيلانغانا |
| 87 | {b>PIN<b} | {b>الرمز البريدي<b} |
| 88 | ....................... | ....................... |
| 89 | {b>c) In case, outside the limit of this Police Station, then<b} | {b>ج) في حال وقوع الحادثة خارج نطاق اختصاص هذا المركز، فإن<b} |
| 90 | {b>Name of P.S.<b} | {b>اسم مركز الشرطة<b} |
| 91 | ……………. | ……………. |
| 92 | {b>District<b} | {b>المنطقة<b} |
| 93 | ……………… | ……………… |
| 94 | 6. | 6. |
| 95 | {b>Complainant / Informant:<b} | {b>المشتكي / مقدّم البلاغ:<b} |
| 96 | {b>a) Name<b} | {b>أ) الاسم<b} |
| 97 | Mr. Jitender Puri | السيد جيتيندر بوري |
| 98 | {b>b) Father's / Husband's Name<b} | {b>ب) اسم الأب / الزوج<b} |
| 99 | Sohan Puri | سوهان بوري |
| 100 | {b>c) Date/Year of Birth<b} | {b>ج) تاريخ / سنة الميلاد<b} |
| 101 | ................................... | ................................... |
| 102 | {b>Age<b} | {b>العمر<b} |
| 103 | Year | سنة |
| 104 | {b>d) Nationality<b} | {b>د) الجنسية<b} |
| 105 | India | الهند |
| 106 | {b>e) Caste<b} | {b>هـ) الطائفة<b} |
| 107 | ……………………………… | ……………………………… |
| 108 | {b>f) Passport No<b} | {b>و) رقم جواز السفر<b} |
| 109 | ................................... | ................................... |
| 110 | {b>Date of Issue<b} | {b>تاريخ الإصدار<b} |
| 111 | ........................ | ........................ |
| 112 | {b>Place of Issue<b} | {b>مكان الإصدار<b} |
| 113 | …………….. | …………….. |
| 114 | {b>g) Occupation<b} | {b>ز) المهنة<b} |
| 115 | Business | أعمال تجارية |
| 116 | {b>Mobile No.<b} | {b>رقم الهاتف المحمول<b} |
| 117 | {b>h) Address<b} | {b>ح) العنوان<b} |
| 118 | {b>House No<b} | {b>رقم المنزل<b} |
| 119 | …………… | …………… |
| 120 | {b>Area/Mandal<b} | {b>المنطقة / المندال<b} |
| 121 | Gosha Mahal, | غوشا محل، |
| 122 | {b>Street/ Village<b} | {b>الشارع / القرية<b} |
| 123 | {b>City/District<b} | {b>المدينة / المنطقة<b} |
| 124 | HYDERABAD | حيدر آباد |
| 125 | {b>State<b} | {b>الولاية<b} |
| 126 | TELANGANA | تيلانغانا |
| 127 | {b>PIN<b} | {b>الرمز البريدي<b} |
| 128 | .................... | .................... |
| 129 | 7. | 7. |
| 130 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>بيانات المتهمين المعروفين / المشتبه بهم / المجهولين بالتفصيل:<b} |
| 131 | {b>Serial No:<b} | {b>الرقم التسلسلي:<b} |
| 132 | {b>a) Name<b} | {b>أ) الاسم<b} |
| 133 | Mr. Ravi Mahaseth | السيد راڤي ماهاسيث |
| 134 | {b>b) Father's/ Husband's Name<b} | {b>ب) اسم الأب / الزوج<b} |
| 135 | ………………………………………………… | ………………………………………………… |
| 136 | {b>c) Occupation<b} | {b>ج) المهنة<b} |
| 137 | …………………… | …………………… |
| 138 | {b>d) Caste<b} | {b>د) الطائفة<b} |
| 139 | ……………. | ……………. |
| 140 | {b>e) Gender<b} | {b>هـ) الجنس<b} |
| 141 | Male | ذكر |
| 142 | {b>f) Age<b} | {b>و) العمر<b} |
| 143 | …………………… | …………………… |
| 144 | {b>Nationality<b} | {b>الجنسية<b} |
| 145 | India | الهند |
| 146 | {b>g) Address<b} | {b>ز) العنوان<b} |
| 147 | {b>House No<b} | {b>رقم المنزل<b} |
| 148 | Managing Director of COINZ | المدير التنفيذي لشركة COINZ |
| 149 | {b>Street/ Village<b} | {b>الشارع / القرية<b} |
| 150 | ……………... | ……………... |
| 151 | {b>Area/ Mandal<b} | {b>المنطقة / المندال<b} |
| 152 | {b>City/ District<b} | {b>المدينة / المنطقة<b} |
| 153 | …………………… | …………………… |
| 154 | {b>State<b} | {b>الولاية<b} |
| 155 | …………….. | …………….. |
| 156 | {b>PIN<b} | {b>الرمز البريدي<b} |
| 157 | …………… | …………… |
| 158 | {b>h) Phone (off)<b} | {b>ح) الهاتف (العمل)<b} |
| 159 | ……………………. | ……………………. |
| 160 | {b>Phone (Resi)<b} | {b>الهاتف (السكن)<b} |
| 161 | ……………. | ……………. |
| 162 | {b>Cell No<b} | {b>رقم الجوال<b} |
| 163 | …………… | …………… |
| 164 | {b>i) Email<b} | {b>ط) البريد الإلكتروني<b} |
| 165 | ………………………………………… | ………………………………………… |
| 166 | {b>Serial No:<b} | {b>الرقم التسلسلي:<b} |
| 167 | {b>a) Name<b} | {b>أ) الاسم<b} |
| 168 | Mr. Ramesh Puri and other | السيد راميش بوري وآخرون |
| 169 | {b>b) Father's/ Husband's Name<b} | {b>ب) اسم الأب / الزوج<b} |
| 170 | ………………………………………..…. | ………………………………………..…. |
| 171 | {1>c) Occupation     <1}{2>……………….<2} | {1>ج) المهنة     <1}{2>……………….<2} |
| 172 | {b>d) Caste<b} | {b>د) الطائفة<b} |
| 173 | ……………… | ……………… |
| 174 | {b>e) Gender<b} | {b>هـ) الجنس<b} |
| 175 | Male | ذكر |
| 176 | {b>f) Age<b} | {b>و) العمر<b} |
| 177 | …………………… | …………………… |
| 178 | {b>Nationality<b} | {b>الجنسية<b} |
| 179 | India | الهند |
| 180 | {b>g) Address<b} | {b>ز) العنوان<b} |
| 181 | {b>House No<b} | {b>رقم المنزل<b} |
| 182 | {b>Street/ Village<b} | {b>الشارع / القرية<b} |
| 183 | ……………... | ……………... |
| 184 | {b>Area/ Mandal<b} | {b>المنطقة / المندال<b} |
| 185 | {b>City/ District<b} | {b>المدينة / المنطقة<b} |
| 186 | …………………… | …………………… |
| 187 | {b>State<b} | {b>الولاية<b} |
| 188 | …………….. | …………….. |
| 189 | {b>PIN<b} | {b>الرمز البريدي<b} |
| 190 | …………… | …………… |
| 191 | {b>h) Phone (off)<b} | {b>ح) الهاتف (العمل)<b} |
| 192 | ……………………. | ……………………. |
| 193 | {b>Phone (Resi)<b} | {b>الهاتف (السكن)<b} |
| 194 | ……………. | ……………. |
| 195 | {b>Cell No<b} | {b>رقم الجوال<b} |
| 196 | …………… | …………… |
| 197 | {b>i) Email<b} | {b>ط) البريد الإلكتروني<b} |
| 198 | ………………………………………… | ………………………………………… |
| 199 | {b>Physical features, deformities and other details of the Suspect:<b} | {b>السمات الجسدية والتشوهات وسائر التفاصيل الخاصة بالمشتبه به:<b} |
| 200 | {b>S.<b} | {b>م.<b} |
| 201 | {b>No.<b} | {b>الرقم<b} |
| 202 | {b>Sex<b} | {b>الجنس<b} |
| 203 | {b>Date/Year of Birth<b} | {b>تاريخ / سنة الميلاد<b} |
| 204 | {b>Build<b} | {b>البنية الجسدية<b} |
| 205 | {b>Height (cms)<b} | {b>الطول (سم)<b} |
| 206 | {b>Complexion<b} | {b>لون البشرة<b} |
| 207 | {b>Identification Marks(s)<b} | {b>علامات التعريف<b} |
| 208 | Male | ذكر |
| 209 | Male | ذكر |
| 210 | {b>Deformities/ Peculiarities<b} | {b>التشوهات / الخصائص المميزة<b} |
| 211 | {b>Teeth<b} | {b>الأسنان<b} |
| 212 | {b>Hair<b} | {b>الشعر<b} |
| 213 | {b>Eyes<b} | {b>العيون<b} |
| 214 | {b>Habbit(s)<b} | {b>العادات<b} |
| 215 | {b>Dress Habit(s)<b} | {b>عادات اللباس<b} |
| 216 | {b>Languages/ Dialect<b} | {b>اللغات / اللهجة<b} |
| 217 | {b>Burn Mark<b} | {b>أثر حرق<b} |
| 218 | {b>Leucoderma<b} | {b>البهاق<b} |
| 219 | {b>Mole<b} | {b>شامة<b} |
| 220 | {b>Scar<b} | {b>ندبة<b} |
| 221 | {b>Tattoo<b} | {b>وشم<b} |
| 222 | {b>8.<b} | {b>8.<b} |
| 223 | {b>Reasons for delay in reporting by the complainant / informant:<b} | {b>أسباب التأخر في تقديم البلاغ من قِبل المشتكي / مقدّم البلاغ:<b} |
| 224 | No Delay | لا يوجد تأخير |
| 225 | {b>9.<b} | {b>9.<b} |
| 226 | {b>Particulars of properties stolen/Involved (Attach separate sheet, if necessary):<b} | {b>تفاصيل الممتلكات المسروقة / المتورط فيها (يُرفق كشف منفصل عند الاقتضاء):<b} |
| 227 | ………………………………………………………………………………………….. | ………………………………………………………………………………………….. |
| 228 | {b>10.<b} | {b>10.<b} |
| 229 | {b>Total value of property stolen:<b} | {b>القيمة الإجمالية للممتلكات المسروقة:<b} |
| 230 | ………………………………………………………………………………………….. | ………………………………………………………………………………………….. |
| 231 | {b>11.<b} | {b>11.<b} |
| 232 | {b>Inquest Report/ U.D.<b} | {b>تقرير التحقيق / الوفاة غير المحددة السبب<b} |
| 233 | {b>Case<b} | {b>القضية<b} |
| 234 | ………………………………………………………………………………………….. | ………………………………………………………………………………………….. |
| 235 | {b>12.<b} | {b>12.<b} |
| 236 | {b>Contents of the complaint / statement of the complainant or informant:<b} | {b>مضمون الشكوى / إفادة المشتكي أو مقدّم البلاغ:<b} |
| 237 | IN THE COURT OF HON'BLE XII ADDL. | أمام محكمة السيد/ القاضي الإضافي الثاني عشر |
| 238 | CHIEF METROPOLITAN MAGISTRATE AT NAMPALLY HYDERABAD. | رئيس قضاة المحكمة الجزائية الكبرى في نامبالي، حيدر آباد. |
| 239 | Honored Sir, Today, on 11.02.2025 at 18:45 hours, received a complaint from Mr. Jitender Puri, S/o Sohan Puri, R/o Gosha Mahal, Hyderabad, and facts of the case are as follows: | حضرة القاضي الموقّر، يوم 11/02/2025 الساعة 18:45، وردت شكوى من السيد جيتيندر بوري، نجل سوهان بوري، المقيم في غوشا محل، حيدر آباد، وتفاصيل القضية على النحو الآتي: |
| 240 | The facts of the case are that the complainant Mr. Jitender Puri, S/o Sohan Puri R/o Gosha Mahal, Hyderabad, filling a complaint against COINZX and its Managing Director, Mr. Ravi Masai, along with Mr. Ramesh Puri. | وقائع القضية أن المشتكي السيد جيتيندر بوري، نجل سوهان بوري، المقيم في غوشا محل، حيدر آباد، تقدّم بشكوى ضد شركة COINZX ومديرها التنفيذي السيد راڤي ماساي، إلى جانب السيد راميش بوري. |
| 241 | Mr. Ramesh Puri introduced Jitender Puri to an investment scheme in COINZX, assuring him that an investment of Rs. | قدّم السيد راميش بوري لجيتيندر بوري مخطط استثماري في شركة COINZX، مؤكداً له أن استثماراً بقيمة |
| 242 | 1.2 lakhs would yield a monthly return of Rs. | 1.2 لاكه روبية سيُدرّ عائداً شهرياً قدره |
| 243 | 11,000/- for 22 months, totaling Rs. | 11,000 روبية لمدة 22 شهراً، ليبلغ الإجمالي |
| 244 | 2.4 lakhs. | 2.4 لاكه روبية. |
| 245 | Additionally, he mentioned that by referring more investors, further incentives could be earned based on the number of new members joining. | وأضاف أنه يمكن تحقيق مكاسب إضافية عبر إحالة مستثمرين جدد، وذلك بحسب عدد الأعضاء المنضمين. |
| 246 | Trusting these assurances, the complainant invested Rs. | ثقةً بهذه الوعود، أقدم المشتكي على استثمار مبلغ |
| 247 | 1.2 lakhs in COINZX and initially received Rs. | 1.2 لاكه روبية في شركة COINZX، وتلقّى في البداية |
| 248 | 11,000/- per month for four months. | 11,000 روبية شهرياً لمدة أربعة أشهر. |
| 249 | Encouraged by these returns, he gained confidence in the company and introduced his relatives, friends, and acquaintances to invest. | مدفوعاً بهذه العوائد، ازداد ثقةً بالشركة وأقنع أقاربه وأصدقاءه ومعارفه بالاستثمار فيها. |
| 250 | Many of them invested varying amounts, ranging from Rs. | استثمر كثير منهم مبالغ متفاوتة، تراوحت بين |
| 251 | 1 lakh to Rs. | لاكه واحد و |
| 252 | 12 lakhs, collectively amounting to approximately Rs. | 12 لاكه روبية، لتبلغ الاستثمارات الإجمالية ما يقارب |
| 253 | 2 crores. | كرورَي روبية. |
| 254 | However, after four months, the promised monthly payments stopped. | غير أنه بعد أربعة أشهر، توقفت المدفوعات الشهرية الموعودة. |
| 255 | When the complainant approached Mr. Ramesh Puri and company representatives, they stated that there were technical issues and assured that payments would resume after four months. | حين تواصل المشتكي مع السيد راميش بوري وممثلي الشركة، أبلغوه بوجود أعطال تقنية، ووعدوه بأن المدفوعات ستُستأنف بعد أربعة أشهر. |
| 256 | They even encouraged him to invest more money, which he refused, having already suffered significant losses. | بل حثّوه على ضخّ مزيد من الأموال، إلا أنه رفض، إذ كان يرزح أصلاً تحت وطأة خسائر فادحة. |
| 257 | Despite waiting for the assured four months, no payments were received. | وعلى الرغم من انتظاره أربعة الأشهر الموعودة، لم يتلقَّ أي مدفوعات. |
| 258 | When the company was confronted again, false assurances were given that all pending dues would be settled after 20 months. | وحين مُواجهة الشركة مجدداً، أُعطيت وعود كاذبة بتسوية جميع المستحقات المتأخرة بعد 20 شهراً. |
| 259 | Trusting their words, investors waited, only to later realize that the company had ceased operations. | تعلّق المستثمرون بهذه الوعود وانتظروا، ليكتشفوا لاحقاً أن الشركة أوقفت نشاطها كلياً. |
| 260 | Further attempts to contact COINZX representatives, including Mr. Ravi Masai and Mr. Ramesh Puri, were ignored. | جوبهت المحاولات اللاحقة للتواصل مع ممثلي COINZX، بمن فيهم السيد راڤي ماساي والسيد راميش بوري، بالتجاهل التام. |
| 261 | Eventually, it was declared that the company had failed and that investors would have to wait indefinitely to recover their funds. | وفي نهاية المطاف، أُعلن إفلاس الشركة، وأن المستثمرين باتوا ينتظرون استرداد أموالهم إلى أجل غير مسمى. |
| 262 | Currently, the complainant is under immense pressure from investors who trusted his recommendation and are demanding the return of their money, putting him in a highly distressing situation. | يقع المشتكي حالياً تحت ضغط هائل من المستثمرين الذين وثقوا بتوصيته ويطالبون باسترداد أموالهم، مما أوقعه في موقف بالغ الضيق. |
| 263 | It is now evident that COINZX, under the leadership of Mr. Ravi Mahaseth and with the involvement of Mr. Ramesh Puri, was a fraudulent scheme designed to deceive investors. | بات جلياً أن شركة COINZX، في عهد السيد راڤي ماهاسيث وبتورط السيد راميش بوري، لم تكن سوى مخطط احتيالي دُبِّر خصيصاً لاستغلال المستثمرين والنصب عليهم. |
| 264 | Additionally, information has been received that Mr. Ravi Mahaseth is now planning to launch a new company similar to COINZX and is organizing a meeting in Goa on the 12th, 13th, and 14th of February 2025. | فضلاً عن ذلك، وردت معلومات مفادها أن السيد راڤي ماهاسيث يعتزم تأسيس شركة جديدة على غرار COINZX، ويُعدّ لعقد اجتماع في غوا في الثاني عشر والثالث عشر والرابع عشر من فبراير 2025. |
| 265 | This raises serious concerns about further fraudulent activities and the possibility of more victims. | يُثير ذلك مخاوف بالغة الخطورة إزاء احتمال تجدّد الأنشطة الاحتيالية وتضاعف عدد الضحايا. |
| 266 | All evidence, including proof of transferred amounts, chats, photos of the Managing Director and company representatives, payment details, and other relevant documents, is being submitted. | يُقدَّم جميع الدليل والأدلة، شاملاً إثبات المبالغ المحوّلة والمحادثات وصور المدير التنفيذي وممثلي الشركة وتفاصيل المدفوعات وسائر المستندات ذات الصلة. |
| 267 | A detailed list of individual investments is also being provided for reference. | كما يُرفق كشف مفصّل باستثمارات الأفراد للاستئناس به. |
| 268 | Hence the complainant requested to file a case against Mr. Ravi Mahaseth, Mr. Ramesh Puri, Mr. Tejas Goswami, and Mr. Vijay Puri, and sought to prevent them from defrauding more individuals and to recover the amount of Rs. | بناءً على ذلك، طلب المشتكي تسجيل قضية ضد السيد راڤي ماهاسيث والسيد راميش بوري والسيد تيجاس غوسوامي والسيد فيجاي بوري، ومنعهم من الإيقاع بمزيد من الضحايا، واسترداد مبلغ |
| 269 | 50,00,000/- invested by the complainant. //The Original complaint is enclosed herewith for kind perusal// Received on 11.02.2025 at 18:45 hours: | 50,00,000 روبية التي استثمرها المشتكي. //الشكوى الأصلية مرفقة طيّه للاطلاع// وردت بتاريخ 11/02/2025 الساعة 18:45: |
| 270 | As per the endorsement of the DCP, CCS, DD, Hyderabad, and as per the contents of the above complaint, I, ASI M.A. | بناءً على توجيهات نائب مفوض الشرطة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، وفي ضوء ما تضمنته الشكوى المذكورة آنفاً، أنا، رقيب المعاونة م.أ. |
| 271 | Aleem, Chair Duty, CCS, DD, Hyd., registered a case in Cr. | عليم، ضابط مناوبة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، سجّلت قضية جنائية برقم |
| 272 | No. 16/2025, U/s 406, 420, r/w 120-B IPC, and case file handed over to Sri. | 16/2025، بموجب المواد 406 و420 بالاقتران مع المادة 120-ب من قانون العقوبات الهندي، وسلّمت ملف القضية إلى |
| 273 | D. Bikshapathi, Inspector, Crime Team, CCS, DD, Hyd., for further investigation. | المفتش د. بيكشاباثي، فريق الجرائم، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، لمواصلة التحقيق. |
| 274 | Sd/- (M.A. | توقيع/ (م.أ. |
| 275 | Aleem,) ASI of Police, Chair Duty, CCS, DD, Hyd | عليم،) رقيب معاونة، ضابط مناوبة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد |
| 276 | {b>13.<b} | {b>13.<b} |
| 277 | {b>Action taken:<b} | {b>الإجراء المتخذ:<b} |
| 278 | {b>Since The above information reveals commission of offence(s) U/s as mentioned at item No:<b} | {b>بما أن المعلومات المذكورة أعلاه تكشف عن ارتكاب جريمة أو جرائم بموجب المواد المشار إليها في البند رقم:<b} |
| 279 | …………… | …………… |
| 280 | {b>1) Registered the case and took up the investigation or<b} | {b>1) تسجيل القضية والشروع في التحقيق، أو<b} |
| 281 | {b>Name<b} | {b>الاسم<b} |
| 282 | DUSARI BIKSHAPATHI | دوساري بيكشاباثي |
| 283 | {b>2) Directed to take up the Investigation or<b} | {b>2) إحالة القضية للتحقيق، أو<b} |
| 284 | {b>Rank:<b} | {b>الرتبة:<b} |
| 285 | Inspector | مفتش |
| 286 | {b>No.<b} | {b>الرقم<b} |
| 287 | {b>3) Refused investigation due to<b} | {b>3) رُفض التحقيق بسبب<b} |
| 288 | ………………………………………… | ………………………………………… |
| 289 | {b>4) Transferred to P.S<b} | {b>4) أُحيلت إلى مركز الشرطة<b} |
| 290 | {b>…………<b} | {b>…………<b} |
| 291 | {b>District<b} | {b>المنطقة<b} |
| 292 | {b>…………<b} | {b>…………<b} |
| 293 | {b>on point of jurisdiction.<b} | {b>على أساس الاختصاص القضائي.<b} |
| 294 | {b>F.I.R. read over to the complainant / informant, admitted to be correctly recorded<b} | {b>تمّت تلاوة البلاغ الأوّلي على المشتكي / مقدّم البلاغ وأقرّ بصحة ما دُوِّن<b} |
| 295 | {b>and a copy given to the complainant /informant, free of cost.<b} | {b>وسُلِّمت نسخة منه إلى المشتكي / مقدّم البلاغ مجاناً.<b} |
| 296 | {b>R.O.A.C<b} | {b>R.O.A.C<b} |
| 297 | {b>14.<b} | {b>14.<b} |
| 298 | {b>Signature / Thumb impression of the complainant / informant.<b} | {b>توقيع / بصمة إبهام المشتكي / مقدّم البلاغ.<b} |
| 299 | {b>Signature of Officer in charge, Police Station<b} | {b>توقيع الضابط المسؤول، مركز الشرطة<b} |
| 300 | {b>Name<b} | {b>الاسم<b} |
| 301 | M A ALEEM | م أ عليم |
| 302 | {b>Rank<b} | {b>الرتبة<b} |
| 303 | ASI | رقيب معاونة |
| 304 | {b>No. 5141<b} | {b>الرقم 5141<b} |
| 305 | {b>15.<b} | {b>15.<b} |
| 306 | {b>Date and time of dispatch to the court: <b}....................................................................................................................................................... | {b>تاريخ ووقت الإحالة إلى المحكمة: <b>....................................................................................................................................................... |
| 307 | Date: | التاريخ: |
| 308 | 11-02-2025 | 11-02-2025 |
| 309 | To, | إلى، |
| 310 | {b>The Deputy Commissioner of Police,<b} | {b>نائب مفوض الشرطة،<b} |
| 311 | CCS Detective Department, | قسم المباحث الجنائية، |
| 312 | Hyderabad. | حيدر آباد. |
| 313 | {b>Subject:<b} | {b>الموضوع:<b} |
| 314 | {b>Request for File a Complaint Against COINZX Company M.D.<b} | {b>طلب تقديم شكوى ضد المدير التنفيذي لشركة COINZX<b} |
| 315 | {b>Mr. Ravi Mahaseth and Mr. Ramesh Puri for Fraudulent Investment Scheme and Request for Recovery of Rs.<b} | {b>السيد راڤي ماهاسيث والسيد راميش بوري بتهمة مخطط الاستثمار الاحتيالي، والمطالبة باسترداد مبلغ<b} |
| 316 | {b>50,00,000/- (Rupees Fifty Lakhs only).<b} | {b>50,00,000 روبية (خمسون لاكه روبية فحسب).<b} |
| 317 | Respected Sir, | حضرة السيد المحترم، |
| 318 | I, Jitender Puri, S/o Sohan Puri, residing at Gosha Mahal, Hyderabad, wish to bring to your kind attention a case of financial fraud perpetrated by COINZX and its Managing Director, Mr. Ravi Masai, along with Mr. Ramesh Puri. | أنا جيتيندر بوري، نجل سوهان بوري، المقيم في غوشا محل، حيدر آباد، أودّ لفت انتباهكم الكريم إلى قضية احتيال مالي ارتكبتها شركة COINZX ومديرها التنفيذي السيد راڤي ماساي، بالتواطؤ مع السيد راميش بوري. |
| 319 | Mr. Ramesh Puri, introduced me to an investment scheme in COINZX, assuring that an investment of Rs. | أطلعني السيد راميش بوري على مخطط استثماري في شركة COINZX، مؤكداً أن استثماراً بقيمة |
| 320 | 1.2 lakhs would yield a monthly return of Rs. | 1.2 لاكه روبية سيُدرّ عائداً شهرياً قدره |
| 321 | 11,000/- for 22 months, totaling Rs. | 11,000 روبية لمدة 22 شهراً، ليبلغ الإجمالي |
| 322 | 2.4 lakhs. | 2.4 لاكه روبية. |
| 323 | Additionally, he mentioned that by referring more investors, we could earn further incentives based on the number of new members joining. | وأضاف أننا نستطيع تحقيق مكاسب إضافية بإحالة مستثمرين جدد، وذلك تبعاً لعدد الأعضاء المنضمين. |
| 324 | Trusting his words, I invested Rs. | ثقةً بكلامه، استثمرت مبلغ |
| 325 | 1.2 lakhs in COINZX and initially received Rs. | 1.2 لاكه روبية في شركة COINZX، وتلقّيت في البداية |
| 326 | 11,000/- per month for four months. | 11,000 روبية شهرياً لمدة أربعة أشهر. |
| 327 | Encouraged by these returns, I gained confidence in the company and introduced my relatives, friends, and acquaintances to invest. | مدفوعاً بهذه العوائد، ازددت ثقةً بالشركة وأقنعت أقاربي وأصدقائي ومعارفي بالاستثمار فيها. |
| 328 | Many of them invested varying amounts, ranging from Rs. | استثمر كثير منهم مبالغ متفاوتة تراوحت بين |
| 329 | 1 lakh to Rs. | لاكه واحد و |
| 330 | 12 lakhs, collectively amounting to approximately Rs. | 12 لاكه روبية، لتبلغ استثماراتهم مجتمعةً ما يقارب |
| 331 | 2 crores. | كرورَي روبية. |
| 332 | However, after four months, the promised monthly payments stopped. | غير أنه بعد أربعة أشهر، انقطعت المدفوعات الشهرية الموعودة. |
| 333 | When I approached Mr. Ramesh and company representatives, they stated that there were technical issues and assured that payments would resume after four months. | حين تواصلت مع السيد راميش وممثلي الشركة، زعموا وجود أعطال تقنية، ووعدوا بأن المدفوعات ستُستأنف بعد أربعة أشهر. |
| 334 | They even encouraged me to invest more money, which I refused, having already suffered significant losses. | بل دفعوني إلى ضخّ مزيد من الأموال، إلا أنني رفضت، إذ كنت أعاني أصلاً خسائر فادحة. |
| 335 | Despite waiting for the assured four months, no payments were received. | وعلى الرغم من انتظاري أربعة الأشهر الموعودة، لم أتلقَّ أي مدفوعات. |
| 336 | When we confronted the company again, we were falsely assured that all pending dues would be settled after 20 months. | حين واجهنا الشركة مرة أخرى، طُمئنّا بوعود كاذبة بأن جميع المستحقات المتأخرة ستُسوَّى بعد 20 شهراً. |
| 337 | Trusting their words, we waited, only to later realize that the company had ceased operations. | تعلّقنا بوعودهم وانتظرنا، ليتضح لنا لاحقاً أن الشركة أوقفت نشاطها كلياً. |
| 338 | Further attempts to contact COINZX representatives, including Mr. Ravi Masai and Mr. Ramesh Puri, were ignored. | جوبهت جميع محاولاتنا اللاحقة للتواصل مع ممثلي COINZX، بما فيها التواصل مع السيد راڤي ماساي والسيد راميش بوري، بالتجاهل التام. |
| 339 | Eventually, they declared that the company had failed and that investors would have to wait indefinitely to recover their funds. | وفي نهاية المطاف، أعلنوا إفلاس الشركة، وأن المستثمرين باتوا ينتظرون استرداد أموالهم إلى أجل مجهول. |
| 340 | Currently, I am under immense pressure from investors who trusted my recommendation and are demanding the return of their money, putting me in a highly distressing situation. | أرزح حالياً تحت ضغط هائل من المستثمرين الذين وثقوا بتوصيتي ويطالبون باسترداد أموالهم، مما أوقعني في موقف بالغ الضيق. |
| 341 | It is now evident that COINZX, under the leadership of Mr. Ravi Mahaseth and with the involvement of Mr. Ramesh Puri, was a fraudulent scheme designed to deceive investors. | بات جلياً أن شركة COINZX، في ظل قيادة السيد راڤي ماهاسيث وبتورط السيد راميش بوري، لم تكن سوى مخطط احتيالي صُمِّم خصيصاً لاستغلال المستثمرين والنصب عليهم. |
| 342 | Additionally, I have received information that Mr. Ravi Mahaseth is now planning to launch a new company similar to COINZX and is organizing a meeting in Goa on 12th, 13th & 14th February 2025. | وعلاوة على ذلك، توصّلت إلى معلومات تفيد بأن السيد راڤي ماهاسيث يعتزم إطلاق شركة جديدة على غرار COINZX، ويُعدّ لعقد اجتماع في غوا في الثاني عشر والثالث عشر والرابع عشر من فبراير 2025. |
| 343 | This raises serious concerns about further fraudulent activities and the possibility of more victims. | يُثير ذلك مخاوف جدية بشأن احتمال تجدّد الأنشطة الاحتيالية وتضاعف عدد الضحايا. |
| 344 | We are submitting all evidence, including proof of transferred amounts, chats, photos of the MD & company representatives, payment details, and other relevant documents. | نُقدّم جميع الأدلة، شاملةً إثبات المبالغ المحوّلة والمحادثات وصور المدير التنفيذي وممثلي الشركة وتفاصيل المدفوعات وسائر المستندات ذات الصلة. |
| 345 | We are also providing a detailed list of individual investments for your reference. | كما نُرفق كشفاً مفصّلاً باستثمارات الأفراد للاستئناس به. |
| 346 | I sincerely request you to file a case against Mr. Ravi Mahaseth- 99870 06999, Mr. Ramesh Puri- 70699 54746/70699 58479, Mr. Tejas Goswami- 98702 30230, and Mr. Vijay Puri- 70142 60865, take immediate legal action to prevent them from defrauding more individuals, and recover the amount of Rs. | أرجو منكم بإلحاح تسجيل قضية ضد السيد راڤي ماهاسيث- 99870 06999، والسيد راميش بوري- 70699 54746/70699 58479، والسيد تيجاس غوسوامي- 98702 30230، والسيد فيجاي بوري- 70142 60865، واتخاذ إجراءات قانونية فورية لمنعهم من الإيقاع بمزيد من الضحايا، واسترداد مبلغ |
| 347 | 50,00,000/- invested by me. | 50,00,000 روبية التي استثمرتها. |
| 348 | Your prompt action will not only help us but also protect others from falling prey to similar fraudulent investment schemes. | إن سرعة تحرككم لن تقتصر على إنقاذنا، بل ستحمي كذلك كثيرين من الوقوع ضحايا لمخططات استثمارية احتيالية مماثلة. |
| 349 | I kindly urge you to take immediate action and do the needful. | أرجو منكم التحرك الفوري واتخاذ ما يلزم. |
| 350 | Thanking you, | شاكراً لكم، |
| 351 | Yours sincerely, | مع فائق الاحترام والتقدير، |
| 352 | //{1>مثبت ختم وتوقيع<1}// | //{1>مثبت ختم وتوقيع<1}// |
| 353 | {b>Jitender Puri<b} | {b>جيتيندر بوري<b} |
| 354 | Ph: +91 70139 51028 | هاتف: 51028 70139 91+ |
| 355 | {b>Encl:<b} | {b>المرفقات:<b} |
| 356 | Details of Individuals invested on COINZX. | بيانات الأفراد المستثمرين في شركة COINZX. |
| 357 | Photos of Meeting conducted by COINZX company along with MD and others. | صور اجتماع عقدته شركة COINZX بحضور المدير التنفيذي وآخرين. |
| 358 | Proofs of Payment transferred details. | إثباتات تفاصيل المبالغ المحوّلة. |
| 359 | Whatsapp Chat/History. | سجل محادثات واتساب. |
| 360 | {1>//<1}{2>نص غير واضح<2}{3>//<3} | {1>//<1}{2>نص غير واضح<2}{3>//<3} |
| 361 | {bu>FIRST INFORMATION REPORT<bu} | {bu>البلاغ الأوّلي<bu} |
| 362 | (Under section 173 and 176 BNSS) | (بموجب المادتين 173 و176 من نظام BNSS) |
| 363 | {b>T.S.P.M.<b} | {b>T.S.P.M.<b} |
| 364 | {b>Orders 470,500<b} | {b>الأوامر 470,500<b} |
| 365 | 1. | 1. |
| 366 | {b>District<b} | {b>المنطقة<b} |
| 367 | Hyderabad | حيدر آباد |
| 368 | {b>Police Station<b} | {b>مركز الشرطة<b} |
| 369 | Central Crime Station | مركز الجرائم الجنائية المركزي |
| 370 | {b>Year<b} | {b>السنة<b} |
| 371 | {b>FIR No.<b} | {b>رقم البلاغ الأوّلي<b} |
| 372 | {b>Date<b} | {b>التاريخ<b} |
| 373 | 11-02-2025 | 11-02-2025 |
| 374 | 2. | 2. |
| 375 | {b>(i) Acts and Sections:<b} | {b>(i) القوانين والمواد:<b} |
| 376 | U/s 406,420,r/w 120-B IPC | بموجب المواد 406 و420 بالاقتران مع المادة 120-ب من قانون العقوبات الهندي |
| 377 | 3. | 3. |
| 378 | {b>a) Occurrence of Offence:<b} | {b>أ) وقوع الجريمة:<b} |
| 379 | {b>Day<b} | {b>اليوم<b} |
| 380 | Prior to FIR | قبل تسجيل البلاغ الأوّلي |
| 381 | {1>Date From: <1}{2>……………<2} | {1>التاريخ من: <1}{2>……………<2} |
| 382 | {b>Date To:<b} ……………. | {b>التاريخ إلى:<b} ……………. |
| 383 | {1>Time Period: <1}{2>………………..<2} | {1>الفترة الزمنية: <1}{2>………………..<2} |
| 384 | {1>Time from: <1}{2>…………….<2} | {1>الوقت من: <1}{2>…………….<2} |
| 385 | {1>Time To: <1}{2>……………….<2} | {1>الوقت إلى: <1}{2>……………….<2} |
| 386 | {b>b) Information Received at the Police station:<b} | {b>ب) تاريخ ووقت استلام البلاغ في مركز الشرطة:<b} |
| 387 | {b>Date<b} | {b>التاريخ<b} |
| 388 | 11-02-2025 | 11-02-2025 |
| 389 | {b>Time<b} | {b>الوقت<b} |
| 390 | 18:45 hrs | 18:45 ساعة |
| 391 | {b>(c) General Diary Reference:<b} | {b>(ج) مرجع السجل العام:<b} |
| 392 | {b>Entry No(s)<b} | {b>رقم (أرقام) القيد<b} |
| 393 | {b>Date & Time<b} | {b>التاريخ والوقت<b} |
| 394 | 11-02-2025 18:45 hrs | 11-02-2025 الساعة 18:45 |
| 395 | 4. | 4. |
| 396 | {b>Type of Information:<b} | {b>نوع البلاغ:<b} |
| 397 | {b>English Typed<b} | {b>مكتوب بالإنجليزية<b} |
| 398 | 5. | 5. |
| 399 | {b>Place of Occurrence:<b} | {b>مكان وقوع الحادثة:<b} |
| 400 | {b>(b) Place<b} | {b>(ب) المكان<b} |
| 401 | {b>Street/ Village<b} | {b>الشارع / القرية<b} |
| 402 | {b>Area/ Mandal<b} | {b>المنطقة / المندال<b} |
| 403 | {b>City/ District<b} | {b>المدينة / المنطقة<b} |
| 404 | {b>Hyderabad<b} | {b>حيدر آباد<b} |
| 405 | {b>State<b} | {b>الولاية<b} |
| 406 | {b>Telangana<b} | {b>تيلانغانا<b} |
| 407 | © | © |
| 408 | {b>If outside the limits of this police Station, then the name of concerned Police Station<b} | {b>في حال وقوع الحادثة خارج نطاق اختصاص هذا المركز، يُذكر اسم مركز الشرطة المعني<b} |
| 409 | {b>C.C.S.<b} | {b>C.C.S.<b} |
| 410 | {b>Hyderabad<b} | {b>حيدر آباد<b} |
| 411 | {b>District:<b} | {b>المنطقة:<b} |
| 412 | Hyderabad | حيدر آباد |
| 413 | 6. | 6. |
| 414 | {b>Complainant/Informant:<b} | {b>المشتكي / مقدّم البلاغ:<b} |
| 415 | {b>(a) Name:<b} | {b>(أ) الاسم:<b} |
| 416 | Mr. Jitender Puri | السيد جيتيندر بوري |
| 417 | {b>(b) Father's/Husband's Name:<b} | {b>(ب) اسم الأب / الزوج:<b} |
| 418 | Sohan Puri | سوهان بوري |
| 419 | {b>Date/Year of Birth<b} | {b>تاريخ / سنة الميلاد<b} |
| 420 | {b>Age:<b} | {b>العمر:<b} |
| 421 | {b>(d) Nationality:<b} | {b>(د) الجنسية:<b} |
| 422 | Indian | هندي |
| 423 | {b>(e) Passport No:<b} | {b>(هـ) رقم جواز السفر:<b} |
| 424 | {b>Date of Issue:<b} | {b>تاريخ الإصدار:<b} |
| 425 | {b>Place of Issue:<b} | {b>مكان الإصدار:<b} |
| 426 | {b>(f) Occupation:<b} | {b>(و) المهنة:<b} |
| 427 | Business | أعمال تجارية |
| 428 | {b>(g) House No:<b} | {b>(ز) رقم المنزل:<b} |
| 429 | {b>(h) Street/Village:<b} | {b>(ح) الشارع / القرية:<b} |
| 430 | {b>(i) Area/Mandal:<b} | {b>(ط) المنطقة / المندال:<b} |
| 431 | Gosha Mahal, | غوشا محل، |
| 432 | {b>(J) City/District:<b} | {b>(ي) المدينة / المنطقة:<b} |
| 433 | Hyderabad | حيدر آباد |
| 434 | {b>(k) State:<b} | {b>(ك) الولاية:<b} |
| 435 | Telangana | تيلانغانا |
| 436 | (l) Mobile Number: | (ل) رقم الهاتف المحمول: |
| 437 | 7. | 7. |
| 438 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>بيانات المتهمين المعروفين / المشتبه بهم / المجهولين بالتفصيل:<b} |
| 439 | {b>Serial No:<b} | {b>الرقم التسلسلي:<b} |
| 440 | {b>Name of Accused<b} | {b>اسم المتهم<b} |
| 441 | {b>Mr. Ravi Mahaseth<b} | {b>السيد راڤي ماهاسيث<b} |
| 442 | {b>Father's/ Husband's Name<b} | {b>اسم الأب / الزوج<b} |
| 443 | ………………………………………………… | ………………………………………………… |
| 444 | {b>Occupation:<b} | {b>المهنة:<b} |
| 445 | {b>Caste<b} | {b>الطائفة<b} |
| 446 | Category | الفئة |
| 447 | {b>Sex<b} | {b>الجنس<b} |
| 448 | Male | ذكر |
| 449 | {b>Age:<b} | {b>العمر:<b} |
| 450 | {b>Nationality<b} | {b>الجنسية<b} |
| 451 | India | الهند |
| 452 | {b>Present H.No<b} | {b>رقم المنزل الحالي<b} |
| 453 | Managing Director of COINZ | المدير التنفيذي لشركة COINZ |
| 454 | {b>Present Street:<b} | {b>الشارع الحالي:<b} |
| 455 | {b>Present Area/ Village:<b} | {b>المنطقة / القرية الحالية:<b} |
| 456 | {b>Present City/ District<b} | {b>المدينة / المنطقة الحالية<b} |
| 457 | {b>Present State<b} | {b>الولاية الحالية<b} |
| 458 | {b>Serial No:<b} | {b>الرقم التسلسلي:<b} |
| 459 | {b>Name of Accused<b} | {b>اسم المتهم<b} |
| 460 | {b>Mr. Ramesh Puri and other<b} | {b>السيد راميش بوري وآخرون<b} |
| 461 | {b>Father's/ Husband's Name<b} | {b>اسم الأب / الزوج<b} |
| 462 | ………………………………………………… | ………………………………………………… |
| 463 | {b>Occupation:<b} | {b>المهنة:<b} |
| 464 | {b>Caste<b} | {b>الطائفة<b} |
| 465 | Category | الفئة |
| 466 | {b>Sex<b} | {b>الجنس<b} |
| 467 | Male | ذكر |
| 468 | {b>Age:<b} | {b>العمر:<b} |
| 469 | {b>Nationality<b} | {b>الجنسية<b} |
| 470 | India | الهند |
| 471 | {b>Present H.No<b} | {b>رقم المنزل الحالي<b} |
| 472 | {b>Present Street:<b} | {b>الشارع الحالي:<b} |
| 473 | {b>Present Area/ Village:<b} | {b>المنطقة / القرية الحالية:<b} |
| 474 | {b>Present City/ District<b} | {b>المدينة / المنطقة الحالية<b} |
| 475 | {b>Present State<b} | {b>الولاية الحالية<b} |
| 476 | {b>S.<b} | {b>م.<b} |
| 477 | {b>No.<b} | {b>الرقم<b} |
| 478 | {b>Sex<b} | {b>الجنس<b} |
| 479 | {b>Date/Year of Birth<b} | {b>تاريخ / سنة الميلاد<b} |
| 480 | {b>Build<b} | {b>البنية الجسدية<b} |
| 481 | {b>Height (cms)<b} | {b>الطول (سم)<b} |
| 482 | {b>Complexion<b} | {b>لون البشرة<b} |
| 483 | {b>Identification Marks(s)<b} | {b>علامات التعريف<b} |
| 484 | {b>Deformities/ Peculiarities<b} | {b>التشوهات / الخصائص المميزة<b} |
| 485 | {b>Teeth<b} | {b>الأسنان<b} |
| 486 | {b>Hair<b} | {b>الشعر<b} |
| 487 | {b>Eyes<b} | {b>العيون<b} |
| 488 | {b>Habbit(s)<b} | {b>العادات<b} |
| 489 | {b>Dress Habit(s)<b} | {b>عادات اللباس<b} |
| 490 | PLACE OF | مكان |
| 491 | {b>Languages/ Dialect<b} | {b>اللغات / اللهجة<b} |
| 492 | {b>Burn Mark<b} | {b>أثر حرق<b} |
| 493 | {b>Leucoderma<b} | {b>البهاق<b} |
| 494 | {b>Mole<b} | {b>شامة<b} |
| 495 | {b>Scar<b} | {b>ندبة<b} |
| 496 | {b>Tattoo<b} | {b>وشم<b} |
| 497 | These fields will be entered only if complainant/informant gives any one or more particulars about the suspect this will be used only for the purpose of preliminary retrieval to assist LO. | تُملأ هذه الخانات فقط إذا أفاد المشتكي / مقدّم البلاغ بواحدة أو أكثر من التفاصيل الخاصة بالمشتبه به، وتُستخدم حصراً لأغراض الاسترجاع الأولي لمساعدة ضابط الاستعلامات. |
| 498 | A database created will subsequently link one suspect in several cases, if any Conviction a comprehensive and complete data on all fields will again be prepared when any accused is arrested of previous. | ستُستخدم قاعدة البيانات المُنشأة لاحقاً لربط المشتبه به بعدة قضايا، وفي حال صدور أي إدانة، تُعدّ بيانات شاملة ومكتملة لجميع الخانات عند اعتقال أي من المتهمين السابقين. |
| 499 | Reasons for delay in reporting by the Complainant/Informant | أسباب التأخر في تقديم البلاغ من قِبل المشتكي / مقدّم البلاغ |
| 500 | : | : |
| 501 | {b>No Delay<b} | {b>لا يوجد تأخير<b} |
| 502 | Particulars of properties Stolen/Involved | تفاصيل الممتلكات المسروقة / المتورط فيها |
| 503 | : | : |
| 504 | ________________ | ________________ |
| 505 | Total value of properties Stolen/involved | القيمة الإجمالية للممتلكات المسروقة / المتورط فيها |
| 506 | : | : |
| 507 | ________________ | ________________ |
| 508 | Inquest Report/U.D. | تقرير التحقيق / الوفاة غير المحددة السبب |
| 509 | Case NO., if any | رقم القضية، إن وُجد |
| 510 | : | : |
| 511 | ________________ | ________________ |
| 512 | Contents of the complainant/Statement of the complainant or informant | مضمون الشكوى / إفادة المشتكي أو مقدّم البلاغ |
| 513 | : | : |
| 514 | ________________ | ________________ |
| 515 | {bu>IN THE COURT OF HON'BLE XII ADDL, CHIEF METROPOLITAN MAGISTRATE AT NAMPALLY HYDERABAD,<bu} | {bu>أمام محكمة السيد/ القاضي الإضافي الثاني عشر، رئيس قضاة المحكمة الجزائية الكبرى في نامبالي، حيدر آباد،<bu} |
| 516 | Honored Sir, | حضرة القاضي الموقّر، |
| 517 | Today, on 11.02.2025 at 18:45 hours, received a complaint from Mr. Jitender Puri, S/o Sohan Puri, R/o Gosha Mahal, Hyderabad, and facts of the case are as follows: | يوم 11/02/2025 الساعة 18:45، وردت شكوى من السيد جيتيندر بوري، نجل سوهان بوري، المقيم في غوشا محل، حيدر آباد، وتفاصيل القضية على النحو الآتي: |
| 518 | The facts of the case are that the complainant Mr. Jitender Puri, S/o Sohan Puri R/o Gosha Mahal, Hyderabad, filling a complaint against COINZX and its Managing Director, Mr. Ravi Masai, along with Mr. Ramesh Puri. | وقائع القضية أن المشتكي السيد جيتيندر بوري، نجل سوهان بوري، المقيم في غوشا محل، حيدر آباد، تقدّم بشكوى ضد شركة COINZX ومديرها التنفيذي السيد راڤي ماساي، إلى جانب السيد راميش بوري. |
| 519 | Mr. Ramesh Puri introduced Jitender Puri to an investment scheme in COINZX, assuring him that an investment of Rs. | قدّم السيد راميش بوري لجيتيندر بوري مخططاً استثمارياً في شركة COINZX، مؤكداً له أن استثماراً بقيمة |
| 520 | 1.2 lakhs would yield a monthly return of Rs. | 1.2 لاكه روبية سيُدرّ عائداً شهرياً قدره |
| 521 | 11,000/- for 22 months, totaling Rs. | 11,000 روبية لمدة 22 شهراً، ليبلغ الإجمالي |
| 522 | 2.4 lakhs. | 2.4 لاكه روبية. |
| 523 | Additionally, he mentioned that by referring more investors, further incentives could be earned based on the number of new members joining. | وأضاف أنه يمكن تحقيق مكاسب إضافية عبر إحالة مستثمرين جدد، وذلك تبعاً لعدد الأعضاء المنضمين. |
| 524 | Trusting these assurances, the complainant invested Rs. | ثقةً بهذه الوعود، أقدم المشتكي على استثمار مبلغ |
| 525 | 1.2 lakhs in COINZX and initially received Rs. | 1.2 لاكه روبية في شركة COINZX، وتلقّى في البداية |
| 526 | 11,000/- per month for four months. | 11,000 روبية شهرياً لمدة أربعة أشهر. |
| 527 | Encouraged by these returns, he gained confidence in the company and introduced his relatives, friends, and acquaintances to invest. | مدفوعاً بهذه العوائد، ازداد المشتكي ثقةً بالشركة وأقنع أقاربه وأصدقاءه ومعارفه بالاستثمار فيها. |
| 528 | Many of them invested varying amounts, ranging from Rs. | استثمر كثير منهم مبالغ متفاوتة تراوحت بين |
| 529 | 1 lakh to Rs. | لاكه واحد و |
| 530 | 12 lakhs, collectively amounting to approximately Rs. | 12 لاكه روبية، لتبلغ استثماراتهم مجتمعةً ما يقارب |
| 531 | 2 crores. | كرورَي روبية. |
| 532 | However, after four months, the promised monthly payments stopped. | غير أنه بعد أربعة أشهر، توقفت المدفوعات الشهرية الموعودة. |
| 533 | When the complainant approached Mr. Ramesh Puri and company representatives, they stated that there were technical issues and assured that payments would resume after four months. | حين تواصل المشتكي مع السيد راميش بوري وممثلي الشركة، زعموا وجود أعطال تقنية، ووعدوا بأن المدفوعات ستُستأنف بعد أربعة أشهر. |
| 534 | They even encouraged him to invest more money, which he refused, having already suffered significant losses. | بل حثّوه على ضخّ مزيد من الأموال، إلا أنه رفض، إذ كان يعاني أصلاً خسائر فادحة. |
| 535 | Despite waiting for the assured four months, no payments were received. | وعلى الرغم من انتظاره أربعة الأشهر الموعودة، لم يتلقَّ أي مدفوعات. |
| 536 | When the company was confronted again, false assurances were given that all pending dues would be settled after 20 months. | وحين مُواجهة الشركة مجدداً، أُعطيت وعود كاذبة بتسوية جميع المستحقات المتأخرة بعد 20 شهراً. |
| 537 | Trusting their words, investors waited, only to later realize that the company had ceased operations. | تعلّق المستثمرون بهذه الوعود وانتظروا، ليكتشفوا لاحقاً أن الشركة أوقفت نشاطها كلياً. |
| 538 | Further attempts to contact COINZX representatives, including Mr. Ravi Masai and Mr. Ramesh Puri, were ignored. | جوبهت المحاولات اللاحقة للتواصل مع ممثلي COINZX، بما فيها التواصل مع السيد راڤي ماساي والسيد راميش بوري، بالتجاهل التام. |
| 539 | Eventually, it was declared that the company had failed and that investors would have to wait indefinitely to recover their funds. | وفي نهاية المطاف، أُعلن إفلاس الشركة، وأن المستثمرين باتوا ينتظرون استرداد أموالهم إلى أجل غير مسمى. |
| 540 | Currently, the complainant is under immense pressure from investors who trusted his recommendation and are demanding the return of their money, putting him in a highly distressing situation. | يقع المشتكي حالياً تحت ضغط هائل من المستثمرين الذين وثقوا بتوصيته ويطالبون باسترداد أموالهم، مما أوقعه في موقف بالغ الضيق. |
| 541 | It is now evident that COINZX, under the leadership of Mr. Ravi Mahaseth and with the involvement of Mr. Ramesh Puri, was a fraudulent scheme designed to deceive investors. | بات جلياً أن شركة COINZX، في ظل قيادة السيد راڤي ماهاسيث وبتورط السيد راميش بوري، لم تكن سوى مخطط احتيالي صُمِّم خصيصاً لاستغلال المستثمرين والنصب عليهم. |
| 542 | Additionally, information has been received that Mr. Ravi Mahaseth is now planning to launch a new company similar to COINZX and is organizing a meeting in Goa on the 12th, 13th, and 14th of February 2025. | وعلاوة على ذلك، وردت معلومات تفيد بأن السيد راڤي ماهاسيث يعتزم إطلاق شركة جديدة على غرار COINZX، ويُعدّ لعقد اجتماع في غوا في الثاني عشر والثالث عشر والرابع عشر من فبراير 2025. |
| 543 | This raises serious concerns about further fraudulent activities and the possibility of more victims. | يُثير ذلك مخاوف جدية بشأن احتمال تجدّد الأنشطة الاحتيالية وتضاعف عدد الضحايا. |
| 544 | All evidence, including proof of transferred amounts, chats, photos of the Managing Director and company representatives, payment details, and other relevant documents, is being submitted. | يُقدَّم جميع الأدلة، شاملاً إثبات المبالغ المحوّلة والمحادثات وصور المدير التنفيذي وممثلي الشركة وتفاصيل المدفوعات وسائر المستندات ذات الصلة. |
| 545 | A detailed list of individual investments is also being provided for reference. | كما يُرفق كشف مفصّل باستثمارات الأفراد للاستئناس به. |
| 546 | Hence the complainant requested to file a case against Mr. Ravi Mahaseth, Mr. Ramesh Puri, Mr. Tejas Goswami, and Mr. Vijay Puri, and sought to prevent them from defrauding more individuals and to recover the amount of Rs. | بناءً على ذلك، طلب المشتكي تسجيل قضية ضد السيد راڤي ماهاسيث والسيد راميش بوري والسيد تيجاس غوسوامي والسيد فيجاي بوري، ومنعهم من الإيقاع بمزيد من الضحايا، واسترداد مبلغ |
| 547 | 50,00,000/- invested by the complainant. | 50,00,000 روبية التي استثمرها المشتكي. |
| 548 | //The Original complaint is enclosed herewith for kind perusal// | //الشكوى الأصلية مرفقة طيّه للاطلاع// |
| 549 | {bu>Received on 11.02.2025 at 18:45 hours:<bu} | {bu>وردت بتاريخ 11/02/2025 الساعة 18:45:<bu} |
| 550 | As per the endorsement of the DCP, CCS, DD, Hyderabad, and as per the contents of the above complaint, I, ASI M.A. | بناءً على توجيهات نائب مفوض الشرطة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، وفي ضوء ما تضمنته الشكوى المذكورة آنفاً، أنا، رقيب المعاونة م.أ. |
| 551 | Aleem, Chair Duty, CCS, DD, Hyd., registered a case in Cr. | عليم، ضابط مناوبة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، سجّلت قضية جنائية برقم |
| 552 | No. 16/2025, U/s 406, 420, r/w 120-B IPC, and case file handed over to Sri. | 16/2025، بموجب المواد 406 و420 بالاقتران مع المادة 120-ب من قانون العقوبات الهندي، وسلّمت ملف القضية إلى |
| 553 | D. Bikshapathi, Inspector, Crime Team, CCS, DD, Hyd., for further investigation. | المفتش د. بيكشاباثي، فريق الجرائم، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد، لمواصلة التحقيق. |
| 554 | Sd/- | توقيع/- |
| 555 | (M.A. | (م.أ. |
| 556 | Aleem,) | عليم،) |
| 557 | ASI of Police, Chair Duty, CCS, DD, Hyd | رقيب معاونة، ضابط مناوبة، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد |
| 558 | Action taken: | الإجراء المتخذ: |
| 559 | Since the above report reveals commission of offence (s) U/s as mentioned at Item No.2, | بما أن التقرير المذكور أعلاه يكشف عن ارتكاب جريمة أو جرائم بموجب المواد المشار إليها في البند رقم 2، |
| 560 | Registered the case and took up the investigation or | تسجيل القضية والشروع في التحقيق، أو |
| 561 | Directed to took up the investigation or: | إحالة القضية للتحقيق، أو: |
| 562 | Name | الاسم |
| 563 | {b>D.<b} | {b>د.<b} |
| 564 | {b>Bikshapathi<b} | {b>بيكشاباثي<b} |
| 565 | Refused investigation due to | رُفض التحقيق بسبب |
| 566 | Rank | الرتبة |
| 567 | {b>Inspector, Crime Team, CCS, DD, Hyd<b} | {b>مفتش، فريق الجرائم، قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد<b} |
| 568 | Transferred to Police Station On the point of Jurisdiction | أُحيلت إلى مركز الشرطة على أساس الاختصاص القضائي |
| 569 | F.L.R read over to the Complainant/Informant, admitted to be correctly recorded and a copy given to Complainant Informant free of cost | تمّت تلاوة البلاغ الأوّلي على المشتكي / مقدّم البلاغ وأقرّ بصحة ما دُوِّن وسُلِّمت نسخة منه مجاناً |
| 570 | //{1>مثبت توقيع<1} // | //{1>مثبت توقيع<1} // |
| 571 | Signature of the Officer-in-charge | توقيع الضابط المسؤول |
| 572 | Signature/Thumb impression of the Complainant/ Informer | توقيع / بصمة إبهام المشتكي / مقدّم البلاغ |
| 573 | Name | الاسم |
| 574 | M.A. | م.أ. |
| 575 | Aleem, | عليم، |
| 576 | Rank | الرتبة |
| 577 | ASI of Police, Chair Duty | رقيب معاونة، ضابط مناوبة |
| 578 | CCS, D.D, Hyderabad | قسم الجرائم الجنائية، إدارة المباحث، حيدر آباد |
| 579 | Date and Time of dispatch to the Court | تاريخ ووقت الإحالة إلى المحكمة |
| 580 | 02.2025 | 02.2025 |
| 581 | {1>//<1}{2>مثبت ختم<2}{3>//<3} | {1>//<1}{2>مثبت ختم<2}{3>//<3} |
| 582 | {4} | {4} |
| 583 | {b>Badlapur East<b} | {b>بادلابور إيست<b} |
| 584 | {b>FIR<b} | {b>البلاغ الأوّلي<b} |
| 585 | {b>Against<b} | {b>ضد<b} |
| 586 | {b>Ravi Mahaseth<b} | {b>راڤي ماهاسيث<b} |
| 587 | {b>N.C.R.B.<b} | {b>N.C.R.B.<b} |
| 588 | {b>I.I.F.-I (Integrated Investigation Form - 1)<b} | {b>I.I.F.-I (نموذج التحقيق المتكامل - 1)<b} |
| 589 | {b>FIRST INFORMATION REPORT<b} | {b>البلاغ الأوّلي<b} |
| 590 | {b>(Under Section 173 B.N.S.S)<b} | {b>(بموجب المادة 173 من نظام B.N.S.S)<b} |
| 591 | 1. | 1. |
| 592 | District Thane city P.S. | منطقة مدينة ثانه - مركز الشرطة |
| 593 | (Police Station) Badlapur Year-2026 | (مركز الشرطة) بادلابور - السنة 2026 |
| 594 | FIR No.-0169           Date and Time of FIR-23/04/2026 at 1:22 hours | رقم البلاغ الأوّلي: 0169          تاريخ ووقت البلاغ: 23/04/2026 الساعة 01:22 |
| 595 | 2. | 2. |
| 596 | {b>S.<b} | {b>م.<b} |
| 597 | {b>No.<b} | {b>الرقم<b} |
| 598 | {b>Act<b} | {b>القانون<b} |
| 599 | {b>Sections<b} | {b>المواد<b} |
| 600 | Bhartiya Nyaya Sanhita (BNS), 2023 | قانون بهارتيا نياي سانهيتا (BNS)، 2023 |
| 601 | 318(4) | 318(4) |
| 602 | Bhartiya Nyaya Sanhita (BNS), 2023 | قانون بهارتيا نياي سانهيتا (BNS)، 2023 |
| 603 | 316(2) | 316(2) |
| 604 | Bhartiya Nyaya Sanhita (BNS), 2023 | قانون بهارتيا نياي سانهيتا (BNS)، 2023 |
| 605 | 61(2) | 61(2) |
| 606 | Bhartiya Nyaya Sanhita (BNS), 2023 | قانون بهارتيا نياي سانهيتا (BNS)، 2023 |
| 607 | 351(2) | 351(2) |
| 608 | The Maharashtra Protection of Depositors' Interests Act, 1999 | قانون ماهاراشترا لحماية مصالح المودِعين لعام 1999 |
| 609 | {b>3. (a) Occurrence of offence:<b} | {b>3. (أ) وقوع الجريمة:<b} |
| 610 | Details | التفاصيل |
| 611 | Information | المعلومات |
| 612 | Day | اليوم |
| 613 | Days in between | الأيام المتوسطة |
| 614 | Date from | التاريخ من |
| 615 | 01/05/2021 Date to - 15/07/2025 | 01/05/2021 التاريخ إلى - 15/07/2025 |
| 616 | Time Period | الفترة الزمنية |
| 617 | Time From: | الوقت من: |
| 618 | 00:00 hours | 00:00 ساعة |
| 619 | Time to | الوقت إلى |
| 620 | 00:00 hours | 00:00 ساعة |
| 621 | {b>(b) Information received at P.S.:<b} | {b>(ب) تاريخ ووقت استلام البلاغ في مركز الشرطة:<b} |
| 622 | Date | التاريخ |
| 623 | Time | الوقت |
| 624 | 22/04/2026 | 22/04/2026 |
| 625 | 23:00 hours | 23:00 ساعة |
| 626 | {b>(c) General Diary Reference:<b} | {b>(ج) مرجع السجل العام:<b} |
| 627 | Entry No. | رقم القيد |
| 628 | Date and Time | التاريخ والوقت |
| 629 | 23/04/2026 01:22 hours | 23/04/2026 الساعة 01:22 |
| 630 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 631 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 632 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 633 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 634 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 635 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 636 | 6600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 6600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 637 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 638 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 639 | 6600/- per coin, I will return you Rs. | 6600/- روبية للعملة، فسأُعيد إليك |
| 640 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 641 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 642 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 643 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 644 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 645 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 646 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 647 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 648 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 649 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 650 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 651 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 652 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 653 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 654 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 655 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 656 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 657 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 658 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 659 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 660 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 661 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 662 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 663 | 64,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 64,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 664 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 665 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 666 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 667 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 668 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 669 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 670 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 671 | 64,00,000/- from me, Rs. | 64,00,000/- روبية، ومن كابيل باتيا |
| 672 | 60,00,000/- from Kapil Bhatia, Rs. | 60,00,000/- روبية، ومن كيتان كومار بهورا |
| 673 | 60,00,000/- from Ketankumar Bhura, and Rs. | 60,00,000/- روبية، ومن فيجاي كومار راكشي |
| 674 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 675 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 676 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 677 | S.No. | م. |
| 678 | Address Type | نوع العنوان |
| 679 | Address | العنوان |
| 680 | Present Address | العنوان الحالي |
| 681 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 682 | Permanent Address | العنوان الدائم |
| 683 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 684 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 685 | Mobile | الجوال |
| 686 | 91-9320587639 | 91-9320587639 |
| 687 | {b>7.<b} | {b>7.<b} |
| 688 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 689 | S. | م. |
| 690 | No. | الرقم |
| 691 | Name | الاسم |
| 692 | Name | الاسم |
| 693 | Name | الاسم |
| 694 | Name | الاسم |
| 695 | Name | الاسم |
| 696 | Name | الاسم |
| 697 | Name | الاسم |
| 698 | Name | الاسم |
| 699 | Name | الاسم |
| 700 | Name | الاسم |
| 700 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 701 | 62,00,000,00 | 62,00,000,00 |
| 702 | 70. | 70. |
| 703 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 704 | 62,00,000.00 | 62,00,000.00 |
| 705 | 11. | 11. |
| 706 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 707 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 708 | 12. | 12. |
| 709 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 710 | Statement | الإفادة |
| 711 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 712 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 713 | Mob. | جوال. |
| 714 | No. 9320587639 | رقم 9320587639 |
| 715 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 716 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 717 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 718 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 719 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 720 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 721 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 722 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 723 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 724 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 725 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 726 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 727 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 728 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 729 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 730 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 731 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 732 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 733 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 734 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 735 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 736 | 7600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 7600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 737 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 738 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 739 | 7600/- per coin, I will return you Rs. | 7600/- روبية للعملة، فسأُعيد إليك |
| 740 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 741 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 742 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 743 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 744 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 745 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 746 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 747 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 748 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 749 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 750 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 751 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 752 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 753 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 754 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 755 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 756 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 757 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 758 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 759 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 760 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 761 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 762 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 763 | 74,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 74,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 764 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 765 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 766 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 767 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 768 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 769 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 770 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 771 | 74,00,000/- from me, Rs. | 74,00,000/- روبية، ومن كابيل باتيا |
| 772 | 70,00,000/- from Kapil Bhatia, Rs. | 70,00,000/- روبية، ومن كيتان كومار بهورا |
| 773 | 70,00,000/- from Ketankumar Bhura, and Rs. | 70,00,000/- روبية، ومن فيجاي كومار راكشي |
| 774 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 775 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 776 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 777 | S.No. | م. |
| 778 | Address Type | نوع العنوان |
| 779 | Address | العنوان |
| 780 | Present Address | العنوان الحالي |
| 781 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 782 | Permanent Address | العنوان الدائم |
| 783 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 784 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 785 | Mobile | الجوال |
| 786 | 91-9320587639 | 91-9320587639 |
| 787 | {b>7.<b} | {b>7.<b} |
| 788 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 789 | S. | م. |
| 790 | No. | الرقم |
| 791 | Name | الاسم |
| 792 | Name | الاسم |
| 793 | Name | الاسم |
| 794 | Name | الاسم |
| 795 | Name | الاسم |
| 796 | Name | الاسم |
| 797 | Name | الاسم |
| 798 | Name | الاسم |
| 799 | Name | الاسم |
    | 801 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 802 | 80. | 80. |
| 803 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 804 | 62,00,000.00 | 62,00,000.00 |
| 805 | 11. | 11. |
| 806 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 807 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 808 | 12. | 12. |
| 809 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 810 | Statement | الإفادة |
| 811 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 812 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 813 | Mob. | جوال. |
| 814 | No. 9320587639 | رقم 9320587639 |
| 815 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 816 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 817 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 818 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 819 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 820 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 821 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 822 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 823 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 824 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 825 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 826 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 827 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 828 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 829 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 830 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 831 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 832 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 833 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 834 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 835 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 836 | 8600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 8600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 837 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 838 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 839 | 8600/- per coin, I will return you Rs. | 8600/- روبية للعملة، فسأُعيد إليك |
| 840 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 841 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 842 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 843 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 844 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 845 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 846 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 847 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 848 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 849 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 850 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 851 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 852 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 853 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 854 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 855 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 856 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 857 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 858 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 859 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 860 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 861 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 862 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 863 | 84,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 84,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 864 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 865 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 866 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 867 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 868 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 869 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 870 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 871 | 84,00,000/- from me, Rs. | 84,00,000/- روبية، ومن كابيل باتيا |
| 872 | 80,00,000/- from Kapil Bhatia, Rs. | 80,00,000/- روبية، ومن كيتان كومار بهورا |
| 873 | 80,00,000/- from Ketankumar Bhura, and Rs. | 80,00,000/- روبية، ومن فيجاي كومار راكشي |
| 874 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 875 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 876 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 877 | S.No. | م. |
| 878 | Address Type | نوع العنوان |
| 879 | Address | العنوان |
| 880 | Present Address | العنوان الحالي |
| 881 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 882 | Permanent Address | العنوان الدائم |
| 883 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 884 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 885 | Mobile | الجوال |
| 886 | 91-9320587639 | 91-9320587639 |
| 887 | {b>7.<b} | {b>7.<b} |
| 888 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 889 | S. | م. |
| 890 | No. | الرقم |
| 891 | Name | الاسم |
| 892 | Name | الاسم |
| 893 | Name | الاسم |
| 894 | Name | الاسم |
| 895 | Name | الاسم |
| 896 | Name | الاسم |
| 897 | Name | الاسم |
| 898 | Name | الاسم |
| 899 | Name | الاسم |
| 900 | Name | الاسم |
| 901 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 902 | 90. | 90. |
| 903 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 904 | 62,00,000.00 | 62,00,000.00 |
| 905 | 11. | 11. |
| 906 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 907 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 908 | 12. | 12. |
| 909 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 910 | Statement | الإفادة |
| 911 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 912 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 913 | Mob. | جوال. |
| 914 | No. 9320587639 | رقم 9320587639 |
| 915 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 916 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 917 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 918 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 919 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 920 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 921 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 922 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 923 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 924 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 925 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 926 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 927 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 928 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 929 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 930 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 931 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 932 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 933 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 934 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 935 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 936 | 9600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 9600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 937 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 938 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 939 | 9600/- per coin, I will return you Rs. | 9600/- روبية للعملة، فسأُعيد إليك |
| 940 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 941 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 942 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 943 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 944 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 945 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 946 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 947 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 948 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 949 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 950 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 951 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 952 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 953 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 954 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 955 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 956 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 957 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 958 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 959 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 960 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 961 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 962 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 963 | 94,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 94,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 964 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 965 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 966 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 967 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 968 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 969 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 970 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 971 | 94,00,000/- from me, Rs. | 94,00,000/- روبية، ومن كابيل باتيا |
| 972 | 90,00,000/- from Kapil Bhatia, Rs. | 90,00,000/- روبية، ومن كيتان كومار بهورا |
| 973 | 90,00,000/- from Ketankumar Bhura, and Rs. | 90,00,000/- روبية، ومن فيجاي كومار راكشي |
| 974 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 975 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 976 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 977 | S.No. | م. |
| 978 | Address Type | نوع العنوان |
| 979 | Address | العنوان |
| 980 | Present Address | العنوان الحالي |
| 981 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 982 | Permanent Address | العنوان الدائم |
| 983 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 984 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 985 | Mobile | الجوال |
| 986 | 91-9320587639 | 91-9320587639 |
| 987 | {b>7.<b} | {b>7.<b} |
| 988 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 989 | S. | م. |
| 990 | No. | الرقم |
| 991 | Name | الاسم |
| 992 | Name | الاسم |
| 993 | Name | الاسم |
| 994 | Name | الاسم |
| 995 | Name | الاسم |
| 996 | Name | الاسم |
| 997 | Name | الاسم |
| 998 | Name | الاسم |
| 999 | Name | الاسم |
| 1000 | Name | الاسم |
| 1100 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1101 | 62,00,000,00 | 62,00,000,00 |
| 1102 | 110. | 110. |
| 1103 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1104 | 62,00,000.00 | 62,00,000.00 |
| 1105 | 11. | 11. |
| 1106 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1107 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1108 | 12. | 12. |
| 1109 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1110 | Statement | الإفادة |
| 1111 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1112 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1113 | Mob. | جوال. |
| 1114 | No. 9320587639 | رقم 9320587639 |
| 1115 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1116 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1117 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1118 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1119 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1120 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1121 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1122 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1123 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1124 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1125 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1126 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1127 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1128 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1129 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1130 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1131 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1132 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1133 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1134 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1135 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1136 | 11600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 11600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1137 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1138 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1139 | 11600/- per coin, I will return you Rs. | 11600/- روبية للعملة، فسأُعيد إليك |
| 1140 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1141 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1142 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1143 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1144 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1145 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1146 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1147 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1148 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1149 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1150 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1151 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1152 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1153 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1154 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1155 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1156 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1157 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1158 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1159 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1160 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1161 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1162 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1163 | 114,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 114,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1164 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1165 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1166 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1167 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1168 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1169 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1170 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1171 | 114,00,000/- from me, Rs. | 114,00,000/- روبية، ومن كابيل باتيا |
| 1172 | 110,00,000/- from Kapil Bhatia, Rs. | 110,00,000/- روبية، ومن كيتان كومار بهورا |
| 1173 | 110,00,000/- from Ketankumar Bhura, and Rs. | 110,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1174 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1175 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1176 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1177 | S.No. | م. |
| 1178 | Address Type | نوع العنوان |
| 1179 | Address | العنوان |
| 1180 | Present Address | العنوان الحالي |
| 1181 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1182 | Permanent Address | العنوان الدائم |
| 1183 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1184 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1185 | Mobile | الجوال |
| 1186 | 91-9320587639 | 91-9320587639 |
| 1187 | {b>7.<b} | {b>7.<b} |
| 1188 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1189 | S. | م. |
| 1190 | No. | الرقم |
| 1191 | Name | الاسم |
| 1192 | Name | الاسم |
| 1193 | Name | الاسم |
| 1194 | Name | الاسم |
| 1195 | Name | الاسم |
| 1196 | Name | الاسم |
| 1197 | Name | الاسم |
| 1198 | Name | الاسم |
| 1199 | Name | الاسم |
| 1200 | Name | الاسم |
    | 1201 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1202 | 120. | 120. |
| 1203 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1204 | 62,00,000.00 | 62,00,000.00 |
| 1205 | 11. | 11. |
| 1206 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1207 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1208 | 12. | 12. |
| 1209 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1210 | Statement | الإفادة |
| 1211 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1212 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1213 | Mob. | جوال. |
| 1214 | No. 9320587639 | رقم 9320587639 |
| 1215 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1216 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1217 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1218 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1219 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1220 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1221 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1222 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1223 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1224 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1225 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1226 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1227 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1228 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1229 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1230 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1231 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1232 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1233 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1234 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1235 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1236 | 12600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 12600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1237 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1238 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1239 | 12600/- per coin, I will return you Rs. | 12600/- روبية للعملة، فسأُعيد إليك |
| 1240 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1241 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1242 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1243 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1244 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1245 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1246 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1247 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1248 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1249 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1250 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1251 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1252 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1253 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1254 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1255 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1256 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1257 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1258 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1259 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1260 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1261 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1262 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1263 | 124,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 124,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1264 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1265 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1266 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1267 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1268 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1269 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1270 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1271 | 124,00,000/- from me, Rs. | 124,00,000/- روبية، ومن كابيل باتيا |
| 1272 | 120,00,000/- from Kapil Bhatia, Rs. | 120,00,000/- روبية، ومن كيتان كومار بهورا |
| 1273 | 120,00,000/- from Ketankumar Bhura, and Rs. | 120,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1274 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1275 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1276 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1277 | S.No. | م. |
| 1278 | Address Type | نوع العنوان |
| 1279 | Address | العنوان |
| 1280 | Present Address | العنوان الحالي |
| 1281 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1282 | Permanent Address | العنوان الدائم |
| 1283 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1284 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1285 | Mobile | الجوال |
| 1286 | 91-9320587639 | 91-9320587639 |
| 1287 | {b>7.<b} | {b>7.<b} |
| 1288 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1289 | S. | م. |
| 1290 | No. | الرقم |
| 1291 | Name | الاسم |
| 1292 | Name | الاسم |
| 1293 | Name | الاسم |
| 1294 | Name | الاسم |
| 1295 | Name | الاسم |
| 1296 | Name | الاسم |
| 1297 | Name | الاسم |
| 1298 | Name | الاسم |
| 1299 | Name | الاسم |
| 1300 | Name | الاسم |
| 1301 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1302 | 130. | 130. |
| 1303 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1304 | 62,00,000.00 | 62,00,000.00 |
| 1305 | 11. | 11. |
| 1306 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1307 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1308 | 12. | 12. |
| 1309 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1310 | Statement | الإفادة |
| 1311 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1312 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1313 | Mob. | جوال. |
| 1314 | No. 9320587639 | رقم 9320587639 |
| 1315 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1316 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1317 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1318 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1319 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1320 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1321 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1322 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1323 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1324 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1325 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1326 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1327 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1328 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1329 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1330 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1331 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1332 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1333 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1334 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1335 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1336 | 13600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 13600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1337 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1338 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1339 | 13600/- per coin, I will return you Rs. | 13600/- روبية للعملة، فسأُعيد إليك |
| 1340 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1341 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1342 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1343 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1344 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1345 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1346 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1347 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1348 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1349 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1350 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1351 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1352 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1353 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1354 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1355 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1356 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1357 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1358 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1359 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1360 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1361 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1362 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1363 | 134,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 134,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1364 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1365 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1366 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1367 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1368 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1369 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1370 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1371 | 134,00,000/- from me, Rs. | 134,00,000/- روبية، ومن كابيل باتيا |
| 1372 | 130,00,000/- from Kapil Bhatia, Rs. | 130,00,000/- روبية، ومن كيتان كومار بهورا |
| 1373 | 130,00,000/- from Ketankumar Bhura, and Rs. | 130,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1374 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1375 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1376 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1377 | S.No. | م. |
| 1378 | Address Type | نوع العنوان |
| 1379 | Address | العنوان |
| 1380 | Present Address | العنوان الحالي |
| 1381 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1382 | Permanent Address | العنوان الدائم |
| 1383 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1384 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1385 | Mobile | الجوال |
| 1386 | 91-9320587639 | 91-9320587639 |
| 1387 | {b>7.<b} | {b>7.<b} |
| 1388 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1389 | S. | م. |
| 1390 | No. | الرقم |
| 1391 | Name | الاسم |
| 1392 | Name | الاسم |
| 1393 | Name | الاسم |
| 1394 | Name | الاسم |
| 1395 | Name | الاسم |
| 1396 | Name | الاسم |
| 1397 | Name | الاسم |
| 1398 | Name | الاسم |
| 1399 | Name | الاسم |
| 1400 | Name | الاسم |
| 1401 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1402 | 140. | 140. |
| 1403 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1404 | 62,00,000.00 | 62,00,000.00 |
| 1405 | 11. | 11. |
| 1406 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1407 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1408 | 12. | 12. |
| 1409 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1410 | Statement | الإفادة |
| 1411 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1412 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1413 | Mob. | جوال. |
| 1414 | No. 9320587639 | رقم 9320587639 |
| 1415 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1416 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1417 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1418 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1419 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1420 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1421 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1422 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1423 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1424 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1425 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1426 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1427 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1428 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1429 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1430 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1431 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1432 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1433 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1434 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1435 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1436 | 14600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 14600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1437 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1438 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1439 | 14600/- per coin, I will return you Rs. | 14600/- روبية للعملة، فسأُعيد إليك |
| 1440 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1441 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1442 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1443 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1444 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1445 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1446 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1447 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1448 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1449 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1450 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1451 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1452 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1453 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1454 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1455 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1456 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1457 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1458 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1459 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1460 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1461 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1462 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1463 | 144,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 144,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1464 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1465 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1466 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1467 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1468 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1469 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1470 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1471 | 144,00,000/- from me, Rs. | 144,00,000/- روبية، ومن كابيل باتيا |
| 1472 | 140,00,000/- from Kapil Bhatia, Rs. | 140,00,000/- روبية، ومن كيتان كومار بهورا |
| 1473 | 140,00,000/- from Ketankumar Bhura, and Rs. | 140,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1474 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1475 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1476 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1477 | S.No. | م. |
| 1478 | Address Type | نوع العنوان |
| 1479 | Address | العنوان |
| 1480 | Present Address | العنوان الحالي |
| 1481 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1482 | Permanent Address | العنوان الدائم |
| 1483 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1484 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1485 | Mobile | الجوال |
| 1486 | 91-9320587639 | 91-9320587639 |
| 1487 | {b>7.<b} | {b>7.<b} |
| 1488 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1489 | S. | م. |
| 1490 | No. | الرقم |
| 1491 | Name | الاسم |
| 1492 | Name | الاسم |
| 1493 | Name | الاسم |
| 1494 | Name | الاسم |
| 1495 | Name | الاسم |
| 1496 | Name | الاسم |
| 1497 | Name | الاسم |
| 1498 | Name | الاسم |
| 1499 | Name | الاسم |
| 1500 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1502 | 150. | 150. |
| 1503 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1504 | 62,00,000.00 | 62,00,000.00 |
| 1505 | 11. | 11. |
| 1506 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1507 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1508 | 12. | 12. |
| 1509 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1510 | Statement | الإفادة |
| 1511 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1512 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1513 | Mob. | جوال. |
| 1514 | No. 9320587639 | رقم 9320587639 |
| 1515 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1516 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1517 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1518 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1519 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1520 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1521 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1522 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1523 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1524 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1525 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1526 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1527 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1528 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1529 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1530 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1531 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1532 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1533 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1534 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1535 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1536 | 15600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 15600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1537 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1538 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1539 | 15600/- per coin, I will return you Rs. | 15600/- روبية للعملة، فسأُعيد إليك |
| 1540 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1541 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1542 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1543 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1544 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1545 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1546 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1547 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1548 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1549 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1550 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1551 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1552 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1553 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1554 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1555 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1556 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1557 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1558 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1559 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1560 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1561 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1562 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1563 | 154,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 154,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1564 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1565 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1566 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1567 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1568 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1569 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1570 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1571 | 154,00,000/- from me, Rs. | 154,00,000/- روبية، ومن كابيل باتيا |
| 1572 | 150,00,000/- from Kapil Bhatia, Rs. | 150,00,000/- روبية، ومن كيتان كومار بهورا |
| 1573 | 150,00,000/- from Ketankumar Bhura, and Rs. | 150,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1574 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1575 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1576 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1577 | S.No. | م. |
| 1578 | Address Type | نوع العنوان |
| 1579 | Address | العنوان |
| 1580 | Present Address | العنوان الحالي |
| 1581 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1582 | Permanent Address | العنوان الدائم |
| 1583 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1584 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1585 | Mobile | الجوال |
| 1586 | 91-9320587639 | 91-9320587639 |
| 1587 | {b>7.<b} | {b>7.<b} |
| 1588 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1589 | S. | م. |
| 1590 | No. | الرقم |
| 1591 | Name | الاسم |
| 1592 | Name | الاسم |
| 1593 | Name | الاسم |
| 1594 | Name | الاسم |
| 1595 | Name | الاسم |
| 1596 | Name | الاسم |
| 1597 | Name | الاسم |
| 1598 | Name | الاسم |
| 1599 | Name | الاسم |
| 1600 | Name | الاسم |
| 1601 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1602 | 160. | 160. |
| 1603 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1604 | 62,00,000.00 | 62,00,000.00 |
| 1605 | 11. | 11. |
| 1606 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1607 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1608 | 12. | 12. |
| 1609 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1610 | Statement | الإفادة |
| 1611 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1612 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1613 | Mob. | جوال. |
| 1614 | No. 9320587639 | رقم 9320587639 |
| 1615 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1616 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1617 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1618 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1619 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1620 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1621 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1622 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1623 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1624 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1625 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1626 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1627 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1628 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1629 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1630 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1631 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1632 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1633 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1634 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1635 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1636 | 16600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 16600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1637 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1638 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1639 | 16600/- per coin, I will return you Rs. | 16600/- روبية للعملة، فسأُعيد إليك |
| 1640 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1641 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1642 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1643 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1644 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1645 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1646 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1647 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1648 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1649 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1650 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1651 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1652 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1653 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1654 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1655 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1656 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1657 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1658 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1659 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1660 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1661 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1662 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1663 | 164,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 164,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1664 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1665 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1666 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1667 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1668 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1669 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1670 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1671 | 164,00,000/- from me, Rs. | 164,00,000/- روبية، ومن كابيل باتيا |
| 1672 | 160,00,000/- from Kapil Bhatia, Rs. | 160,00,000/- روبية، ومن كيتان كومار بهورا |
| 1673 | 160,00,000/- from Ketankumar Bhura, and Rs. | 160,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1674 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1675 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1676 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1677 | S.No. | م. |
| 1678 | Address Type | نوع العنوان |
| 1679 | Address | العنوان |
| 1680 | Present Address | العنوان الحالي |
| 1681 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1682 | Permanent Address | العنوان الدائم |
| 1683 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1684 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1685 | Mobile | الجوال |
| 1686 | 91-9320587639 | 91-9320587639 |
| 1687 | {b>7.<b} | {b>7.<b} |
| 1688 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1689 | S. | م. |
| 1690 | No. | الرقم |
| 1691 | Name | الاسم |
| 1692 | Name | الاسم |
| 1693 | Name | الاسم |
| 1694 | Name | الاسم |
| 1695 | Name | الاسم |
| 1696 | Name | الاسم |
| 1697 | Name | الاسم |
| 1698 | Name | الاسم |
| 1699 | Name | الاسم |
| 1700 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1701 | 62,00,000,00 | 62,00,000,00 |
| 1702 | 170. | 170. |
| 1703 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1704 | 62,00,000.00 | 62,00,000.00 |
| 1705 | 11. | 11. |
| 1706 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1707 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1708 | 12. | 12. |
| 1709 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1710 | Statement | الإفادة |
| 1711 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1712 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1713 | Mob. | جوال. |
| 1714 | No. 9320587639 | رقم 9320587639 |
| 1715 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1716 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1717 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1718 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1719 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1720 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1721 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1722 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1723 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1724 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1725 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1726 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1727 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1728 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1729 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1730 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1731 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1732 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1733 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1734 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1735 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1736 | 17600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 17600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1737 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1738 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1739 | 17600/- per coin, I will return you Rs. | 17600/- روبية للعملة، فسأُعيد إليك |
| 1740 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1741 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1742 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1743 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1744 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1745 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1746 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1747 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1748 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1749 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1750 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1751 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1752 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1753 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1754 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1755 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1756 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1757 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1758 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1759 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1760 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1761 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1762 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1763 | 174,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 174,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1764 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1765 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1766 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1767 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1768 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1769 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1770 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1771 | 174,00,000/- from me, Rs. | 174,00,000/- روبية، ومن كابيل باتيا |
| 1772 | 170,00,000/- from Kapil Bhatia, Rs. | 170,00,000/- روبية، ومن كيتان كومار بهورا |
| 1773 | 170,00,000/- from Ketankumar Bhura, and Rs. | 170,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1774 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1775 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1776 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1777 | S.No. | م. |
| 1778 | Address Type | نوع العنوان |
| 1779 | Address | العنوان |
| 1780 | Present Address | العنوان الحالي |
| 1781 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1782 | Permanent Address | العنوان الدائم |
| 1783 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1784 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1785 | Mobile | الجوال |
| 1786 | 91-9320587639 | 91-9320587639 |
| 1787 | {b>7.<b} | {b>7.<b} |
| 1788 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1789 | S. | م. |
| 1790 | No. | الرقم |
| 1791 | Name | الاسم |
| 1792 | Name | الاسم |
| 1793 | Name | الاسم |
| 1794 | Name | الاسم |
| 1795 | Name | الاسم |
| 1796 | Name | الاسم |
| 1797 | Name | الاسم |
| 1798 | Name | الاسم |
| 1799 | Name | الاسم |
| 1800 | Name | الاسم |
| 1801 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1802 | 62,00,000,00 | 62,00,000,00 |
| 1803 | 180. | 180. |
| 1804 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1805 | 62,00,000.00 | 62,00,000.00 |
| 1806 | 11. | 11. |
| 1806 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1807 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1808 | 12. | 12. |
| 1809 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1810 | Statement | الإفادة |
| 1811 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1812 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1813 | Mob. | جوال. |
| 1814 | No. 9320587639 | رقم 9320587639 |
| 1815 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1816 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1817 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1818 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1819 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1820 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1821 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1822 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1823 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1824 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1825 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1826 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1827 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1828 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1829 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1830 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1831 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1832 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1833 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1834 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1835 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1836 | 18600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 18600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1837 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1838 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1839 | 18600/- per coin, I will return you Rs. | 18600/- روبية للعملة، فسأُعيد إليك |
| 1840 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1841 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1842 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1843 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1844 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1845 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1846 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1847 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1848 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1849 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1850 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1851 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1852 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1853 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1854 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1855 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1856 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1857 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1858 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1859 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1860 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1861 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1862 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1863 | 184,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 184,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1864 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1865 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1866 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1867 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1868 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1869 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1870 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1871 | 184,00,000/- from me, Rs. | 184,00,000/- روبية، ومن كابيل باتيا |
| 1872 | 180,00,000/- from Kapil Bhatia, Rs. | 180,00,000/- روبية، ومن كيتان كومار بهورا |
| 1873 | 180,00,000/- from Ketankumar Bhura, and Rs. | 180,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1874 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1875 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1876 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1877 | S.No. | م. |
| 1878 | Address Type | نوع العنوان |
| 1879 | Address | العنوان |
| 1880 | Present Address | العنوان الحالي |
| 1881 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1882 | Permanent Address | العنوان الدائم |
| 1883 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1884 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1885 | Mobile | الجوال |
| 1886 | 91-9320587639 | 91-9320587639 |
| 1887 | {b>7.<b} | {b>7.<b} |
| 1888 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1889 | S. | م. |
| 1890 | No. | الرقم |
| 1891 | Name | الاسم |
| 1892 | Name | الاسم |
| 1893 | Name | الاسم |
| 1894 | Name | الاسم |
| 1895 | Name | الاسم |
| 1896 | Name | الاسم |
| 1897 | Name | الاسم |
| 1898 | Name | الاسم |
| 1899 | Name | الاسم |
| 1900 | in a fake digital coin named Coin ZX, Financial fraud for inducing investment | في عملة رقمية مزوّرة باسم عملة زد إكس، احتيال مالي لاستدراج الاستثمار |
| 1901 | 62,00,000,00 | 62,00,000,00 |
| 1902 | 190. | 190. |
| 1903 | Total value of property (In Rs/-): | إجمالي قيمة الممتلكات (بالروبية): |
| 1904 | 62,00,000.00 | 62,00,000.00 |
| 1905 | 11. | 11. |
| 1906 | Inquest Report/U.D. case No., if any: - | رقم قضية تقرير التحقيق / الوفاة غير المحددة السبب، إن وجد: - |
| 1907 | I.I.F.-I (Integrated Investigation Form-1) | I.I.F.-I (نموذج التحقيق المتكامل-1) |
| 1908 | 12. | 12. |
| 1909 | First Information contents: | مضمون بلاغ المعلومات الأول: |
| 1910 | Statement | الإفادة |
| 1911 | Date 19/02/2025 | التاريخ 19/02/2025 |
| 1912 | Mr. Samir Harjivan Jariwala, Age-50 years, Residing at Room No. A 1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066. | السيد سمير هارجيفان جاريوالا، العمر 50 عامًا، مقيم في الغرفة رقم A 1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066. |
| 1913 | Mob. | جوال. |
| 1914 | No. 9320587639 | رقم 9320587639 |
| 1915 | I am residing at the above-mentioned address since my birth. | أقيم في العنوان المذكور أعلاه منذ الميلاد. |
| 1916 | My wife Hina Jariwala age-43 years, daughter named Aastha age-21 years, and son Kavya age-16 years reside with me. | تقيم معي زوجتي هينا جاريوالا البالغة 43 عامًا، وابنتي آستها البالغة 21 عامًا، وابني كافيا البالغ 16 عامًا. |
| 1917 | I operate a tours and travels business in the name of Karishma Tours and Travels, and the income derived from it mitigate my family's livelihood. | أُدير نشاطًا تجاريًا في السياحة والسفر باسم كاريشما للسياحة والسفر، وتُغطّى نفقات معيشة أسرتي من دخله. |
| 1918 | In May 2022, my friend Mr. Samir Vichare (Mob. | في مايو 2022، أخبرني صديقي السيد سمير فيشاري (جوال. |
| 1919 | No. 7588053836) told me about a digital coin investment scheme (of Coin Z X) and said, "If you invest money in a crypto currency (digital currency) scheme named Coin Z X, then you will get huge returns." | رقم 7588053836) عن مخطط استثمار في عملة رقمية (لعملة زد إكس)، وقال: "إذا استثمرت أموالك في مخطط عملة مشفرة (عملة رقمية) باسم عملة زد إكس، فستحصل على عوائد ضخمة." |
| 1920 | He further said, "The owner of this Coin Z X company is Ravi Mahasheth, residing at Room No. 4202, B-Wing, Kanakia Level, opposite Passport Office, Malad East, Mumbai (Mob. | وأضاف: "صاحب شركة عملة زد إكس هذه هو رافي ماهاسيث، مقيم في الغرفة رقم 4202، الجناح B، Kanakia Level، مقابل مكتب الجوازات، مالاد إيست، مومباي (جوال. |
| 1921 | No. 9987006999 /+97158965910), and they have provided 5% to 20% profit monthly to me and thousands of investors in various packages." | رقم 9987006999 /+97158965910)، وقد أعطوني أنا وآلاف المستثمرين ربحًا شهريًا يتراوح بين 5% و20% في حزم متنوعة." |
| 1922 | Samir Vichare further told me that Ravi Mahasheth has other investment companies named "F X and Smart Bull," "Smart X," and "Samruddhi Multi Trade Pvt. | أضاف سمير فيشاري أن رافي ماهاسيث يمتلك شركات استثمارية أخرى باسم "إف إكس سمارت بُل" و"سمارت إكس" و"شركة سامريدي ملتيتريد الخاصة |
| 1923 | Ltd.," in which many people have invested money and earned lakhs of rupees. | المحدودة"، وقد استثمر فيها كثيرون وجنوا مئات الآلاف من الروبيات. |
| 1924 | Afterward, my friend Samir Vichare took me to the office of Mr. Ajit Tripathi (Mob. | بعد ذلك، اصطحبني صديقي سمير فيشاري إلى مكتب السيد أجيت تريباثي (جوال. |
| 1925 | No. 9833523986 /8898284151) and Pawan Didwaniya (Mob. | رقم 9833523986 /8898284151) وباوان ديدوانيا (جوال. |
| 1926 | No. 9820290654), their office at Malad East, Mumbai. | رقم 9820290654)، في مكتبهما بمالاد إيست، مومباي. |
| 1927 | Then Ajit Tripathi and Pawan Didwaniya had introduced me to a big leader of Coin Z X crypto currency, Mr. Jitendra Dhanoriya. | ثم عرّفني أجيت تريباثي وباوان ديدوانيا بأحد كبار قادة عملة زد إكس المشفرة، السيد جيتيندرا دانوريا. |
| 1928 | Then Mr. Jitendra Dhanoriya told me to discuss with Mr. Ravi Mahasheth in a meeting via the Zoom app. | طلب مني السيد جيتيندرا دانوريا التباحث مع السيد رافي ماهاسيث في اجتماع عبر تطبيق زوم. |
| 1929 | Later in May 2022, Jitendra Dhanoriya and Ravi Mahasheth had discussed with me in a Zoom meeting, explaining me the entire scheme, stating, "Just as Bitcoin made people billionaires, Coin ZX will become India's Bitcoin and give multiple returns to all investors." | لاحقًا في مايو 2022، ناقشني جيتيندرا دانوريا ورافي ماهاسيث في مكالمة زوم، موضّحَين لي المخطط بأكمله، وقالا: "تمامًا كما جعل بيتكوين الناس مليارديرات، ستغدو عملة زد إكس بيتكوين الهند وستُعطي جميع المستثمرين عوائد مضاعفة." |
| 1930 | After few days, when I went to meet Ravi Mahasheth at his office No. 222/122, Samruddhi Multi Trade Pvt. | بعد أيام قليلة، حين ذهبت لمقابلة رافي ماهاسيث في مكتبه رقم 121/122، شركة سامريدي ملتيتريد الخاصة |
| 1931 | Ltd., Atlanta, Goregaon East, Mumbai, he again told me, "I have a big business of Forex trading and you have no reason to be afraid." | المحدودة، أتلانتا، غوريغاون إيست، مومباي، أخبرني مجددًا: "لديّ نشاط ضخم في تداول العملات الأجنبية وليس لديك ما تخشاه." |
| 1932 | Then I asked Ravi Mahasheth again, "You are taking money in cash, why don't you take it in a bank account? | ثم سألته مجددًا: "أنت تستلم الأموال نقدًا، لماذا لا تستلمها في حساب مصرفي؟ |
| 1933 | Also, what proof will we have of the investment made in cash?" | وما الإثبات الذي سنحصل عليه على الاستثمار النقدي؟" |
| 1934 | Then he told me, "Coin Z X is a digital currency, and you must invest in cash because today in India, transactions through digital currency are not established; once your investment is made, the company will immediately give you a Login ID, and after entering it on the company's website WWW.COINZX.IO, you can see all the details of your Investment and the Coin Z X coins you received at any time." | فأجابني: "عملة زد إكس عملة رقمية، ويتعيّن عليك الاستثمار نقدًا لأن المعاملات بالعملة الرقمية غير مقررة في الهند اليوم؛ فور إتمام استثمارك ستمنحك الشركة فورًا معرّف دخول، وبعد إدخاله على موقع الشركة WWW.COINZX.IO ستتمكن من رؤية تفاصيل استثمارك وعملات زد إكس التي استلمتها في أي وقت." |
| 1935 | Further, Ravi Mahasheth explained about his Coin ZX digital currency project and how large profits are made by investing in Coin Z X. Mr. Ravi Mahasheth further told me, "The price of Coin Z X digital currency today is only 4 rupees, which will reach up to Rs. | وواصل رافي ماهاسيث شرح مشروع عملة زد إكس الرقمية وكيفية جني أرباح ضخمة بالاستثمار فيها. وأضاف: "سعر عملة زد إكس الرقمية اليوم أربعة روبيات فحسب، وسيرتفع إلى |
| 1936 | 19600/- in the coming period," and added, "Just as the initial price of Bitcoin was 6 rupees and has reached lakhs of rupees today, my Coin ZX digital currency will also grow, and in the future, it will become India's Bitcoin." | 19600/- روبية في المرحلة القادمة"، مضيفًا: "تمامًا كما كان سعر بيتكوين في البداية 6 روبيات وبلغ مئات الآلاف اليوم، ستنمو عملتي الرقمية عملة زد إكس هي الأخرى وستغدو في المستقبل بيتكوين الهند." |
| 1937 | Ravi Mahasheth guaranteed me saying "In the next 20 months, the price of Coin Z X digital coin will become like gold biscuits." | ضمن لي رافي ماهاسيث قائلًا: "في الـ20 شهرًا القادمة، ستصبح عملة زد إكس الرقمية كذهب السبائك." |
| 1938 | He said, "If for some reason the price does not become Rs. | وقال: "إذا لم يبلغ السعر لأي سبب |
| 1939 | 19600/- per coin, I will return you Rs. | 19600/- روبية للعملة، فسأُعيد إليك |
| 1940 | 800/- in exchange for the Rs. | 800/- روبية مقابل الـ |
| 1941 | 6/- taken from you per coin." | 6/- روبية التي أخذتها منك لكل عملة." |
| 1942 | Therefore, I trusted Mr. Ravi Mahasheth. | لذا، وثقت بالسيد رافي ماهاسيث. |
| 1943 | On date 28/09/2022, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, and took 12 lakh rupees in cash from me for investment in Coin Z X company went to Mr. Jitendra Dhanoriya's house. | في تاريخ 28/09/2022، عبر السيد جيتيندرا دانوريا، جاء محصّل النقود في شركة عملة زد إكس، السيد أديتيا شودري، إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، وأخذ مني 12 لاكه روبية نقدًا للاستثمار في شركة عملة زد إكس، ثم توجّه إلى منزل السيد جيتيندرا دانوريا. |
| 1944 | There, Mr. Jitendra Dhanoriya gave me the USER NAME Z X2523058 from Mr. Ravi Mahasheth for logging into the company's website WWW.COINZX.IO, where I had started seeing my investment details. | هناك، أعطاني السيد جيتيندرا دانوريا اسم المستخدم Z X2523058 من السيد رافي ماهاسيث لتسجيل الدخول إلى موقع الشركة WWW.COINZX.IO، وبدأت برؤية تفاصيل استثماري. |
| 1945 | After eight days, as instructed by Mr. Ravi Mahasheth, I again gave 12 lakh rupees cash through Mr. Jitendra Dhanoriya to the company's cash collector Mr. Aditya Chaudhary and the ID/password generator Akshay Kadam. | بعد ثمانية أيام، بتعليمات من السيد رافي ماهاسيث، سلّمت مجددًا 12 لاكه روبية نقدًا عبر السيد جيتيندرا دانوريا إلى محصّل نقود الشركة السيد أديتيا شودري ومُنشئ الهوية وكلمة المرور أكشاي كادام. |
| 1946 | In this way, I have invested a total of 24 lakh rupees in the Coin ZX company. | وبذلك، بلغ إجمالي استثماراتي في شركة عملة زد إكس 24 لاكه روبية. |
| 1947 | Furthermore, as instructed by Mr. Jitendra Dhanoriya through Mr. Jitendra Dhanoriya, my friend Kapil Bhatiaji also invested 10,00,000/- rupees. | علاوةً على ذلك، وبتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي كابيل باتيا أيضًا 10,00,000/- روبية. |
| 1948 | Similarly, as instructed by Mr. Jitendra Dhanoriya my another friend Ketanbhai (Mob. | وعلى المنوال ذاته، بتوجيه من السيد جيتيندرا دانوريا، استثمر صديقي الآخر كيتانبهاي
 (جوال. |
| 1949 | No. 9920223888) also invested 20,00,000/-rupees. | رقم 9920223888) أيضًا 20,00,000/- روبية. |
| 1950 | Also, my third friend Vijaykumar Rakshe invested Rs. | كما استثمر صديقي الثالث فيجاي كومار راكشي |
| 1951 | 8,00,000/- as instructed by Mr. Rajiv Singh. | 8,00,000/- روبية بتوجيه من السيد راجيف سينغ. |
| 1952 | Thus, on the instructions of Mr. Jitendra Dhanoriya, we invested a total of 62,00,000/- rupees in Mr. Ravi Mahasheth's company Coin Z X. | وهكذا، وبتعليمات من السيد جيتيندرا دانوريا، استثمرنا إجمالًا 62,00,000/- روبية في شركة عملة زد إكس التابعة للسيد رافي ماهاسيث. |
| 1953 | Later in March 2023, when I and my friend Ketanbhai had contacted Mr. Ravi Mahasheth via phone, he again assured us, "Your money is safe, and after the completion of the prescribed period, you will get your full money back along with profit." | لاحقًا في مارس 2023، حين تواصلت أنا وصديقي كيتانبهاي مع السيد رافي ماهاسيث هاتفيًا، طمأننا مجددًا قائلًا: "أموالكم بأمان، وعند انتهاء المدة المقررة ستستردّون أموالكم كاملةً مع الأرباح." |
| 1954 | Later, as told by Ravi Mahasheth, when I and my friends Ketan and Kapil had contacted him again after the completion of the 20-month period, Mr. Ravi Mahasheth did not give us any response. | لاحقًا، وكما وعد رافي ماهاسيث، حين تواصلت أنا وصديقاي كيتان وكابيل معه بعد انتهاء فترة الـ20 شهرًا، لم يُبدِ السيد رافي ماهاسيث أي ردّ. |
| 1955 | After some days, we had received reliable information from Mr. Jitendra Dhanoriya that on date 02/01/2023, a case of fraud has been registered at Khandeshwar Police Station, District Thane, Maharashtra, under FIR No. 001/2023 u/s 406, 420, 34 of IPC against Mr. Ravi Mahasheth and big leader of his Coin Z X company, Mr. Sunny Pagare, based on people's complaints for giving false assurances regarding investment in the Coin Z X digital currency company. | بعد أيام، وردتنا معلومات موثوقة من السيد جيتيندرا دانوريا مفادها أنه في تاريخ 02/01/2023 سُجِّلت قضية احتيال في مركز شرطة خانديشوار، منطقة ثاني، ماهاراشترا، تحت رقم بلاغ المعلومات الأول 001/2023 بموجب المواد 406 و420 و34 من قانون العقوبات الهندي، ضد السيد رافي ماهاسيث وأحد كبار قادة شركة عملة زد إكس السيد سني باغاري، وذلك بناءً على شكاوى متضررين من الوعود الكاذبة المتعلقة بالاستثمار في شركة عملة زد إكس الرقمية. |
| 1956 | Therefore, when we had started calling Mr. Ravi Mahasheth to ask for our money back, he told us, "His Coin ZX digital currency company has suffered a huge financial loss, and therefore you will now have to wait for 20 months." | لذا، حين شرعنا في الاتصال بالسيد رافي ماهاسيث للمطالبة باسترداد أموالنا، أخبرنا بأن شركة عملة زد إكس الرقمية الخاصة به تكبّدت خسائر مالية فادحة، وأننا سنضطر للانتظار 20 شهرًا إضافية. |
| 1957 | After 20 months had passed, when we had started asking for our money, upon that Ravi Mahasheth was pushing the date of payment forward every day on some pretext or another. | بعد انقضاء الـ20 شهرًا، حين شرعنا في المطالبة بأموالنا، كان رافي ماهاسيث يُؤجّل موعد الدفع يومًا بعد يوم بشتى الذرائع. |
| 1958 | Later, we had received information that Mr. Ravi Mahasheth had closed his Mumbai office and went to Dubai. | لاحقًا، وردتنا معلومات تفيد بأن السيد رافي ماهاسيث أغلق مكتبه في مومباي وتوجّه إلى دبي. |
| 1959 | After that, Mr. Ravi Mahasheth also stopped answering our phone calls. | بعد ذلك، توقف السيد رافي ماهاسيث عن الرد على مكالماتنا الهاتفية. |
| 1960 | Therefore, upon inquiry, we realized that Ravi Mahasheth had defrauded us and other people of approximately 200 crore rupees. | لذا، بعد الاستفسار، أدركنا أن رافي ماهاسيث احتال علينا وعلى آخرين بما يُقدَّر بنحو 200 كرور روبية. |
| 1961 | Also, information came forward that a case has been registered against Ravi Mahasheth and his associates at Central Crime Branch, Hyderabad, on date 11/02/25 under Crime FIR No. 16/25, u/s 406, 420, 120 (B) of IPC for defrauding investors there. | كذلك برزت معلومات تفيد بتسجيل قضية ضد رافي ماهاسيث وشركائه في فرع الجرائم المركزي بحيدر آباد بتاريخ 11/02/25 تحت رقم بلاغ المعلومات الأول 16/25، بموجب المواد 406 و420 و120(ب) من قانون العقوبات الهندي، بتهمة الاحتيال على المستثمرين هناك. |
| 1962 | So, from May 2022 until today, through Mr. Jitendra Dhanoriya, the cash collector of Coin Z X company, Mr. Aditya Chaudhary, came to my residence at Room No. A-1, Sagar Niwas Carter Road No. 5, Borivali East, Mumbai 400066, with the intention to defraud, and took a total of Rs. | إذن، منذ مايو 2022 وحتى اليوم، وعبر السيد جيتيندرا دانوريا، كان محصّل نقود شركة عملة زد إكس السيد أديتيا شودري يأتي إلى مكان إقامتي في الغرفة رقم A-1، ساغار نيواس، طريق كارتر رقم 5، بوريفالي إيست، مومباي 400066، بنية الاحتيال، ويأخذ مني إجمالي |
| 1963 | 194,00,000/- for investment in Coin ZX digital coin gave to Ravi Mahasheth, the director of Coin ZX, Samruddhi Multi Trade Pvt. | 194,00,000/- روبية للاستثمار في عملة زد إكس الرقمية، وسلّمها إلى رافي ماهاسيث، مدير شركة عملة زد إكس وشركة سامريدي ملتيتريد الخاصة |
| 1964 | Ltd., and Smart X companies. | المحدودة وشركة سمارت إكس. |
| 1965 | Ravi Mahasheth (Director), Aditya Chaudhary (Cashier, Mob. | رافي ماهاسيث (المدير)، وأديتيا شودري (أمين الصندوق، جوال. |
| 1966 | No. 971544572767 /7272960077), Abhishek Sahu (Plan Presenter, Mob. | رقم 971544572767 /7272960077)، وأبهيشيك ساهو (عارض الخطة، جوال. |
| 1967 | No. 9664969228), Akshay Kadam (Pin Requester, Mob. | رقم 9664969228)، وأكشاي كادام (مُنشئ الرمز السري، جوال. |
| 1968 | No. 916110734), Bhavin Chauhan (Company CEO, Mob. | رقم 916110734)، وبهافين شوهان (الرئيس التنفيذي للشركة، جوال. |
| 1969 | No. 9987006222 / +971524199055), through the illegal Coin Z X company which has no legal license in India, they explained a scheme to get maximum money in minimum time and thereby induced me, my friend Kapil Bhatia, Ketankumar Bhura, Vijaykumar Rakshe, and hundreds of other investors to believe that Coin Z X was a digital coin. | رقم 9987006222 / +971524199055)، عبر شركة عملة زد إكس غير المرخّصة التي لا تحمل ترخيصًا قانونيًا في الهند، شرحوا لي مخططًا للحصول على أقصى قدر من المال في أقصر وقت، وأقنعوا بذلك كلًّا منّي وصديقي كابيل باتيا وكيتان كومار بهورا وفيجاي كومار راكشي ومئات المستثمرين الآخرين بأن عملة زد إكس عملة رقمية حقيقية. |
| 1970 | By giving false assurances that the price of this fake digital coin would reach from 4 rupees to 1600 rupees, they took Rs. | بإعطاء وعود زائفة بأن سعر هذه العملة الرقمية المزوّرة سيرتفع من 4 روبيات إلى 1600 روبية، أخذوا مني |
| 1971 | 194,00,000/- from me, Rs. | 194,00,000/- روبية، ومن كابيل باتيا |
| 1972 | 190,00,000/- from Kapil Bhatia, Rs. | 190,00,000/- روبية، ومن كيتان كومار بهورا |
| 1973 | 190,00,000/- from Ketankumar Bhura, and Rs. | 190,00,000/- روبية، ومن فيجاي كومار راكشي |
| 1974 | 8,00,000/- from Vijaykumar Rakshe. | 8,00,000/- روبية. |
| 1975 | Thus, by taking a total of Rs. | وهكذا، بأخذ إجمالي |
| 1976 | 62,00,000/- from the four of us and crores of rupees from other investors, and thereby committing financial fraud   
| 1977 | S.No. | م. |
| 1978 | Address Type | نوع العنوان |
| 1979 | Address | العنوان |
| 1980 | Present Address | العنوان الحالي |
| 1981 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1982 | Permanent Address | العنوان الدائم |
| 1983 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 1984 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 1985 | Mobile | الجوال |
| 1986 | 91-9320587639 | 91-9320587639 |
| 1987 | {b>7.<b} | {b>7.<b} |
| 1988 | {b>Details of known/suspected/unknown accused with full particulars:<b} | {b>تفاصيل المتهم المعروف / المشتبه به / المجهول مع البيانات الكاملة:<b} |
| 1989 | S. | م. |
| 1990 | No. | الرقم |
| 1991 | Name | الاسم |
| 1992 | Name | الاسم |
| 1993 | Name | الاسم |
| 1994 | Name | الاسم |
| 1995 | Name | الاسم |
| 1996 | Name | الاسم |
| 1997 | Name | الاسم |
| 1998 | Name | الاسم |
| 1999 | Name | الاسم |
| 2000 | Name | الاسم |
| 2001 | Present Address | العنوان الحالي |
| 2002 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 2003 | Permanent Address | العنوان الدائم |
| 2004 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 2005 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 2006 | Present Address | العنوان الحالي |
| 2007 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 2008 | Permanent Address | العنوان الدائم |
| 2009 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 2010 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |
| 2011 | Present Address | العنوان الحالي |
| 2012 | A13, Carter Road No. 5, Sagar Niwas, Borivali East, Mumbai, Kasturba Sub, Brihanmumbai City, Maharashtra, India | A13، طريق كارتر رقم 5، ساغار نيواس، بوريفالي إيست، مومباي، كاستوربا سب، مدينة بريهان مومباي، ماهاراشترا، الهند |
| 2013 | {b>(j) Phone number:<b} | {b>(ي) رقم الهاتف:<b} |



`;

      console.log(`   ✅ Mock translation table generated`);
      console.log(`   📊 Total cells translated: ${segments.length}`);
      console.log(`   🎯 Coverage: 100% (all cells included)\n`);

      return mockResponse;
    }

    // Define batch size (adjust based on model limits)
    const BATCH_SIZE = 500; // Conservative limit to avoid token overflow
    const batches: (typeof segments)[] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      batches.push(segments.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `📦 Split into ${batches.length} batches of ~${BATCH_SIZE} segments each\n`,
    );

    const responses: string[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchNum = i + 1;
      const firstCell = batch[0].cellNum;
      const lastCell = batch[batch.length - 1].cellNum;

      console.log(
        `\n🔄 Processing batch ${batchNum}/${batches.length} (Cells ${firstCell}-${lastCell})`,
      );

      // Format batch
      const batchText = batch
        .map((seg) => `[Cell #${seg.cellNum}]\n${seg.text}`)
        .join('\n\n');

      // Add batch context to prompt
      const batchPrompt = `${customPrompt}\n\n**BATCH INFO**: This is batch ${batchNum} of ${batches.length}. Translate cells ${firstCell} through ${lastCell}.`;

      try {
        const response = await this.callProvider(
          provider,
          apiKey,
          batchPrompt,
          batchText,
          model,
        );

        responses.push(response);
        console.log(`✅ Batch ${batchNum} complete (${response.length} chars)`);
      } catch (error: any) {
        console.error(`❌ Batch ${batchNum} failed:`, error.message);
        throw new Error(`Batch ${batchNum} failed: ${error.message}`);
      }
    }

    console.log(
      `\n✅ All ${batches.length} batches complete, combining responses...\n`,
    );

    // Combine all responses
    return responses.join('\n\n');
  }

  /**
   * Extract segments with source and target from MXLIFF for preview
   * @returns Array of segment pairs with source and target text
   */
  async extractMxliffSegmentsForPreview(
    fileBuffer: ArrayBuffer,
  ): Promise<{ source: string; target: string }[]> {
    try {
      const decoder = new TextDecoder('utf-8');
      const xmlText = decoder.decode(fileBuffer);
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      if (xmlDoc.querySelector('parsererror'))
        throw new Error('Failed to parse MXLIFF XML');

      const bodyElement = xmlDoc.querySelector('body');
      if (!bodyElement) return [];

      const transUnits = bodyElement.querySelectorAll('trans-unit');
      const segments: { source: string; target: string }[] = [];

      transUnits.forEach((transUnit) => {
        const id = transUnit.getAttribute('id') ?? '';
        if (!id.includes(':') || !/:\d+$/.test(id)) return;

        const isLocked = transUnit.getAttribute('m:locked') === 'true';
        const sourceText =
          transUnit.querySelector(':scope > source')?.textContent?.trim() ?? '';
        const targetText =
          transUnit.querySelector(':scope > target')?.textContent?.trim() ?? '';

        const kind = this.classifySegment(sourceText, isLocked);

        // Show translate + copy-source in preview, skip 'skip'
        if (kind !== 'skip') {
          segments.push({ source: sourceText, target: targetText });
        }
      });

      return segments;
    } catch (error: any) {
      console.error('❌ Failed to extract MXLIFF segments for preview:', error);
      return [];
    }
  }
  private async callProvider(
    provider: Provider,
    apiKey: string,
    systemPrompt: string,
    documentText: string,
    model: string,
  ): Promise<string> {
    // **TEST MODE** - Return mock translation table
    if (this.TEST_MODE && documentText.includes('[Cell #')) {
      console.log('🧪 TEST MODE ACTIVE - Using mock translation response...');
      // console.log('   📋 Parsing all cells from document...');

      // // Parse cells from document text
      // const segmentPattern = /\[Cell #(\d+)\]\n([\s\S]*?)(?=\[Cell #|$)/g;
      // const mockRows: string[] = [];
      // let match;

      // while ((match = segmentPattern.exec(documentText)) !== null) {
      //   const cellNum = match[1];
      //   const sourceText = match[2].trim();

      //   // Generate realistic mock translation (keep source in Source column, add Arabic mock in Translation)
      //   const sourcePreview =
      //     sourceText.length > 100
      //       ? sourceText.substring(0, 100) + '...'
      //       : sourceText;
      // const mockTranslation = `[ترجمة عربية تجريبية للخلية ${cellNum}]`;

      //   mockRows.push(`| ${cellNum} | ${sourcePreview} | ${mockTranslation} |`);
      // }

      const mockResponse = `| Cell # | Source | Translation |
|--------|---------|-------------|
| 1 | I am representing all investors who have been adversely affected by the fraudulent actions of Mr. Ravi Subodh Mahaseth, who is currently residing unlawfully in Dubai, UAE. | أمثّل جميع المستثمرين الذين تضرروا بشكل سلبي من الأفعال الاحتيالية للسيد رافي سوبود ماهاسيث، الذي يقيم حالياً بشكل غير قانوني في دبي، الإمارات العربية المتحدة. |
      | 2 | I have annexed herewith comprehensive bullet points and associated documents pertaining to this matter. | لقد أرفقت طياً نقاطاً شاملة ووثائق ذات صلة بهذا الأمر. |
      | 3 | I hereby provide the following information, which may assist in the prosecution of Mr. Ravi Mahaseth in Dubai, UAE. | أقدم بموجب هذا المعلومات التالية التي قد تساعد في ملاحقة السيد رافي ماهاسيث في دبي، الإمارات العربية المتحدة. |
      | 4 | On the 12th day of February in the year 2025, Mr. Ravi Subodh Mahaseth was taken into custody at Goa Airport, India. | في اليوم الثاني عشر من فبراير من عام 2025، تم احتجاز السيد رافي سوبود ماهاسيث في مطار غوا، الهند. |
      | 5 | The arrest was executed by the Hyderabad Police, as the Look-Out Circular issued by the Hyderabad Police was in effect and continues to be in force. | نفذت شرطة حيدر آباد عملية الاعتقال، حيث كان تعميم بحث وتحرٍ الصادر عن شرطة حيدر آباد ساري المفعول ولا يزال نافذاً. |
      | 6 | An FIR has been registered pertaining to the offenses of cheating and criminal breach of trust. | تم تسجيل بلاغ المعلومات الأول يتعلق بجرائم الاحتيال وخيانة الأمانة الجنائية. |
      | 7 | Subsequent to his arrest, the Sessions Court of Hyderabad, on the 24th of February 2026, issued a ruling, granting bail, taking into account the accused's medical conditions as a significant factor in its determination. | بعد اعتقاله، أصدرت محكمة جلسات حيدر آباد في الرابع والعشرين من فبراير 2026 حكماً بمنح الإفراج بكفالة، آخذة في الاعتبار الظروف الطبية للمتهم كعامل مهم في قرارها. |
      | 8 | In the interim, another First Information Report pertaining to analogous offenses was duly registered at the Kasturba Marg Police Station, Borivali, Mumbai, Maharashtra on the 19th day of February in the year 2025. | في غضون ذلك، تم تسجيل بلاغ معلومات أول آخر يتعلق بجرائم مماثلة بشكل رسمي في مركز شرطة كاستوربا مارغ، بوريفالي، مومباي، ماهاراشترا في اليوم التاسع عشر من فبراير من عام 2025. |
      | 9 | Furthermore, an additional Look-Out Circular was issued on the 25th day of February in the year 2025. | علاوة على ذلك، تم إصدار تعميم بحث وتحرٍ إضافي في اليوم الخامس والعشرين من فبراير من عام 2025. |
      | 10 | There exists an additional Look-Out-Circular currently in effect issued by the Malad Police Station, located in Mumbai, Maharashtra. | يوجد تعميم بحث وتحرٍ إضافي ساري المفعول حالياً صادر عن مركز شرطة مالاد، الواقع في مومباي، ماهاراشترا. |
      | 11 | In total 3 Look-Out-Circulars are in force against Mr. Ravi Mahaseth. | يبلغ إجمالي تعميمات بحث وتحرٍ السارية ضد السيد رافي ماهاسيث 3 تعميمات. |
      | 12 | The police department of Hyderabad has initiated proceedings for the revocation of the bail previously granted to Mr. Ravi Mahaseth and has subsequently issued a Non-Bailable Warrant for his apprehension. | بدأت إدارة شرطة حيدر آباد إجراءات لإلغاء الإفراج بكفالة الممنوح سابقاً للسيد رافي ماهاسيث وأصدرت بعد ذلك مذكرة غير قابلة للكفالة لإلقاء القبض عليه. |
      | 13 | In addition to the numerous complaints lodged against Mr. Ravi Subodh Mahaseth, Mrs. Rupa Mahaseth, Mr. Bhavin Chauhan, Mr. Aaditya Chaudhary, Mr. Abhishek Sahu, and Mr. Akshay Kadam at various police stations, a further First Information Report (FIR) has been duly registered at the Kashigaon Police Station, located in Mira Road, Thane, Maharashtra. | بالإضافة إلى الشكاوى العديدة المقدمة ضد السيد رافي سوبود ماهاسيث، والسيدة روبا ماهاسيث، والسيد بهافين شوهان، والسيد أديتيا شودري، والسيد أبهيشيك ساهو، والسيد أكشاي كادام في مراكز شرطة مختلفة، تم تسجيل بلاغ معلومات أول آخر بشكل رسمي في مركز شرطة كاشيغاون، الواقع في ميرا رود، ثاني، ماهاراشترا. |
      | 14 | On the 27th day of March in the year 2026, a criminal complaint has been duly filed against Mr. Ravi Subodh Mahaseth with the Government of Ras Al Khaimah, United Arab Emirates. | في اليوم السابع والعشرين من مارس من عام 2026، تم تقديم شكوى جنائية بشكل رسمي ضد السيد رافي سوبود ماهاسيث لدى حكومة رأس الخيمة، الإمارات العربية المتحدة. |
      | 15 | The particulars thereof are hereby attached for your review. | التفاصيل المتعلقة بذلك مرفقة بموجب هذا لمراجعتكم. |
      | 16 | On the 23rd day of April in the year 2026, I duly registered a First Information Report at the Badlapur Police Station, located in Thane, Maharashtra. | في اليوم الثالث والعشرين من أبريل من عام 2026، قمت بتسجيل بلاغ معلومات أول بشكل رسمي في مركز شرطة بادلابور، الواقع في ثاني، ماهاراشترا. |
      | 17 | Under the present circumstances, Mr. Ravi Mahaseth is classified as a wanted criminal in India and has unlawfully arrived in Dubai UAE, after his arrest in India, in contravention of all terms and conditions mandated by the Hon'ble Sessions Court of Hyderabad, India. | في ظل الظروف الحالية، يُصنف السيد رافي ماهاسيث كمجرم مطلوب في الهند وقد وصل بشكل غير قانوني إلى دبي، الإمارات العربية المتحدة، بعد اعتقاله في الهند، بما يخالف جميع الشروط والأحكام التي تفرضها محكمة جلسات حيدر آباد الموقرة، الهند. |
      | 18 | A recording of the Zoom call conducted by Mr. Ravi Mahaseth on the 29th of March, 2025, from 5:00 p.m. to 6:00 p.m. has also been submitted. | تم أيضاً تقديم تسجيل لمكالمة زوم التي أجراها السيد رافي ماهاسيث في التاسع والعشرين من مارس 2025، من الساعة 5:00 مساءً إلى الساعة 6:00 مساءً. |
      | 19 | This recording serves as evidence of his presence in Malaysia on that date, contrary to the stipulations of his bail conditions requiring him to be in India. | يُعد هذا التسجيل دليلاً على وجوده في ماليزيا في ذلك التاريخ، بما يخالف شروط الإفراج بكفالة التي تُلزمه بالبقاء في الهند. |
      | 20 | An individual who has transgressed the laws of his nation is unlikely to serve as a beneficial member of your society and may, through his conduct, pose a significant criminal threat to your citizens. | من غير المرجح أن يكون الفرد الذي تجاوز قوانين بلده عضواً نافعاً في مجتمعكم وقد يُشكل، من خلال سلوكه، تهديداً إجرامياً كبيراً لمواطنيكم. |
      | 21 | I am confident that the Government of Dubai, UAE will duly acknowledge his unlawful entry and residence and may proceed to implement the requisite measures for his deportation in compliance with applicable legal provisions. | أنا على ثقة من أن حكومة دبي، الإمارات العربية المتحدة، ستعترف رسمياً بدخوله وإقامته غير القانونيين وقد تشرع في تنفيذ التدابير اللازمة لترحيله وفقاً للأحكام القانونية المعمول بها. |
      | 22 | It is my expectation that the information herein, substantiated by official documents from the Government of India and the Judiciary, will serve as a valuable resource for you in your efforts to maintain the integrity of your nation against transgressors from foreign jurisdictions. | من المتوقع أن تُشكل المعلومات الواردة هنا، المدعومة بوثائق رسمية من حكومة الهند والسلطة القضائية، مورداً قيماً لكم في جهودكم للحفاظ على سلامة بلدكم ضد المخالفين من الولايات القضائية الأجنبية. |
      | 23 | Appreciate your support and concern. | نُقدر دعمكم واهتمامكم. |
      | 24 | {b>Ravi Mahaseth<b} | {b>رافي ماهاسيث<b} |
      | 25 | {b>Emirates ID<b} | {b>الهوية الإماراتية<b} |
      | 26 | {b>Hyderabad<b} | {b>حيدر آباد<b} |
      | 27 | {b>CCF Police station<b} | {b>مركز شرطة سي سي إف<b} |
      | 28 | {b>FIR Against<b} | {b>بلاغ المعلومات الأول ضد<b} |
      | 29 | {b>Ravi Mahaseth<b} | {b>رافي ماهاسيث<b} |`;

      console.log(`   ✅ Mock translation table generated`);
      // console.log(`   📊 Total cells translated: ${mockRows.length}`);
      console.log(`   🎯 Coverage: 100% (all cells included)\n`);
      console.log(`mockResponse: ${mockResponse}`);

      return mockResponse;
    }

    let url: string;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    let body: unknown;
    let extractFn: (data: any) => string;

    if (provider === 'anthropic') {
      // Use Phrase proxy endpoint for Claude
      // Combine prompt and document, send as JSON in request body
      const fullText = `INSTRUCTIONS: ${systemPrompt}\n\nDOCUMENT:\n${documentText}`;
      // url = `https://phrase.runasp.net/api/Glossary/extract`;
      url = `sary/extract`;
      body = fullText; // Send as JSON string in request body
      extractFn = (d) => {
        // Handle both object response and plain text response
        if (typeof d === 'string') return d;
        if (d.result) return d.result;
        return JSON.stringify(d);
      };
    } else if (provider === 'openai') {
      // Routed through local proxy to bypass OpenAI CORS restriction
      const userMessage = `INSTRUCTIONS: ${systemPrompt}\n\nDOCUMENT:\n${documentText}`;
      url = `${PROXY_BASE}/api/openai`;
      body = {
        apiKey,
        body: {
          model: model || 'gpt-4o',
          // max_tokens: 4096,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        },
      };
      extractFn = (d) => d.choices[0].message.content;
    } else if (provider === 'gemini') {
      const userMessage = `INSTRUCTIONS: ${systemPrompt}\n\nDOCUMENT:\n${documentText}`;
      const geminiModel = model || 'gemini-1.5-pro';
      url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
      body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 4096 },
      };
      extractFn = (d) => d.candidates[0].content.parts[0].text;
    } else {
      // groq — direct browser call, CORS-enabled
      const userMessage = `INSTRUCTIONS: ${systemPrompt}\n\nDOCUMENT:\n${documentText}`;
      url = 'https://api.groq.com/openai/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = {
        model: model || 'llama-3.3-70b-versatile',
        // max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      };
      extractFn = (d) => d.choices[0].message.content;
    }

    console.log('   📤 Sending POST request to:', url.substring(0, 80) + '...');
    console.log('   📦 Provider:', provider.toUpperCase());
    if (provider === 'anthropic') {
      console.log('   📝 Body size:', JSON.stringify(body).length, 'chars');
    }
    console.log('   ⏳ Waiting for AI response...');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw new Error(`Network error: ${err.message}`);
    }

    console.log('   📥 HTTP Status:', response.status, response.statusText);

    if (!response.ok) {
      let detail = '';
      try {
        const errData = await response.json();
        detail =
          errData?.error?.message ||
          errData?.error?.status ||
          JSON.stringify(errData);
      } catch {}

      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid API key. Check your key and try again.');
      }
      if (response.status === 429) {
        throw new Error('Rate limit reached. Wait a moment and retry.');
      }
      if (response.status === 400) {
        throw new Error('Bad request. The document may be too large.');
      }
      throw new Error(
        `API error ${response.status}: ${detail || response.statusText}`,
      );
    }

    const data = await response.json();
    const text = extractFn(data);
    if (!text) throw new Error(`Empty response from ${provider}`);
    return text;
  }

  /**
   * Build a DOCX file from markdown-style text
   * Preserves # H1, ## H2, ### H3, **bold**
   */
  private async buildDocx(text: string): Promise<Blob> {
    const lines = text.split('\n');
    const children: Paragraph[] = [];

    for (let line of lines) {
      line = line.trim();

      if (!line) {
        // Empty line
        children.push(new Paragraph({ text: '' }));
        continue;
      }

      // Check for headings
      if (line.startsWith('### ')) {
        children.push(
          new Paragraph({
            text: line.substring(4),
            heading: HeadingLevel.HEADING_3,
          }),
        );
      } else if (line.startsWith('## ')) {
        children.push(
          new Paragraph({
            text: line.substring(3),
            heading: HeadingLevel.HEADING_2,
          }),
        );
      } else if (line.startsWith('# ')) {
        children.push(
          new Paragraph({
            text: line.substring(2),
            heading: HeadingLevel.HEADING_1,
          }),
        );
      } else {
        // Regular paragraph with bold support
        children.push(this.parseParagraphWithBold(line));
      }
    }

    const doc = new Document({
      sections: [
        {
          children,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    return blob;
  }

  /**
   * Parse a line and create a paragraph with bold formatting
   */
  private parseParagraphWithBold(line: string): Paragraph {
    const parts: TextRun[] = [];
    const boldRegex = /\*\*(.*?)\*\*/g;
    let lastIndex = 0;
    let match;

    while ((match = boldRegex.exec(line)) !== null) {
      // Add text before the bold part
      if (match.index > lastIndex) {
        parts.push(new TextRun(line.substring(lastIndex, match.index)));
      }

      // Add bold text
      parts.push(new TextRun({ text: match[1], bold: true }));

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < line.length) {
      parts.push(new TextRun(line.substring(lastIndex)));
    }

    // If no bold parts found, just add the whole line
    if (parts.length === 0) {
      parts.push(new TextRun(line));
    }

    return new Paragraph({ children: parts });
  }

  /**
   * Build a DOCX file from table data (TermBase table)
   * @param headers - Table header row
   * @param rows - Table data rows
   * @param filename - Output filename
   * @returns Blob containing the DOCX file
   */
  async buildDocxFromTable(
    headers: string[],
    rows: string[][],
    filename: string,
  ): Promise<Blob> {
    console.log('📊 Building DOCX from table data...');

    // Create table rows
    const tableRows: TableRow[] = [];

    // Add header row
    tableRows.push(
      new TableRow({
        children: headers.map(
          (header) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: header, bold: true })],
                }),
              ],
              shading: {
                fill: 'E5E7EB',
              },
            }),
        ),
      }),
    );

    // Add data rows
    rows.forEach((row) => {
      tableRows.push(
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ text: cell })],
              }),
          ),
        }),
      );
    });

    // Create table
    const table = new Table({
      rows: tableRows,
      width: {
        size: 100,
        type: WidthType.PERCENTAGE,
      },
    });

    // Create document
    const doc = new Document({
      sections: [
        {
          children: [table],
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    console.log('✅ Table DOCX ready');
    return blob;
  }

  /**
   * Store the original DOCX buffer for later manipulation
   * @param buffer - ArrayBuffer from the downloaded DOCX file
   */
  setOriginalDocxBuffer(buffer: ArrayBuffer): void {
    this.originalDocxBuffer = buffer;
    console.log('📦 Original DOCX buffer stored:', buffer.byteLength, 'bytes');
  }

  /**
   * Store the original file buffer (MXLIFF or DOCX) for later manipulation
   * @param buffer - ArrayBuffer from the downloaded file
   */
  setOriginalBuffer(buffer: ArrayBuffer): void {
    this.originalBuffer = buffer;
    console.log('📦 Original buffer stored:', buffer.byteLength, 'bytes');
  }

  /**
   * Extract segments with their Phrase segment IDs from the original DOCX
   * This extracts from LOCKED source SDTs to match the order of the TermBase table
   * @returns Array of segments with ID, segment number, source text, and classification
   */
  async extractSegmentsWithIds(): Promise<Segment[]> {
    if (!this.originalDocxBuffer) {
      throw new Error('Original DOCX buffer not set');
    }

    console.log('\n🔍 EXTRACTING SEGMENT IDs from original DOCX...');
    console.log(
      '   📦 Buffer size:',
      (this.originalDocxBuffer.byteLength / 1024).toFixed(2),
      'KB',
    );

    try {
      // Load ZIP file
      const zip = await JSZip.loadAsync(this.originalDocxBuffer);
      const documentXml = await zip.file('word/document.xml')?.async('text');

      if (!documentXml) {
        throw new Error('word/document.xml not found in DOCX');
      }

      // Parse XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(documentXml, 'application/xml');

      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        throw new Error('Failed to parse word/document.xml');
      }

      // Find all SDT (Structured Document Tag) elements
      const sdtElements = xmlDoc.querySelectorAll('sdt');
      const segments: Segment[] = [];
      let segNum = 0;

      sdtElements.forEach((sdt) => {
        // Check if this SDT is LOCKED (source cell - this is what we want!)
        const lockElement = sdt.querySelector(
          'sdtPr lock[w\\:val="sdtContentLocked"]',
        );
        if (!lockElement) {
          // Skip unlocked SDTs (target cells and other elements)
          return;
        }

        // Extract segment ID from tag
        const tagElement = sdt.querySelector('sdtPr tag');
        const segmentId = tagElement?.getAttribute('w:val');

        if (!segmentId) {
          return;
        }

        // Extract source text from sdtContent
        const sdtContent = sdt.querySelector('sdtContent');
        const textNodes = sdtContent?.querySelectorAll('t');
        let sourceText = '';

        textNodes?.forEach((textNode) => {
          sourceText += textNode.textContent || '';
        });

        const trimmed = sourceText.trim();

        // Accept all non-empty content and classify it
        if (trimmed) {
          // For DOCX, locked SDTs are SOURCE cells (not "don't touch" locked)
          const kind = this.classifySegment(trimmed, false);
          segments.push({
            id: segmentId,
            segNum: segNum++,
            sourceText: trimmed,
            kind,
          });
        }
      });

      console.log('✅ Segment extraction complete!');
      console.log('   📊 Total segments found:', segments.length);
      console.log(
        `   translate: ${segments.filter((s) => s.kind === 'translate').length}`,
      );
      console.log(
        `   copy-source: ${segments.filter((s) => s.kind === 'copy-source').length}`,
      );

      if (segments.length > 0) {
        console.log('   📄 First segment preview:');
        console.log('      ID:', segments[0].id);
        console.log('      Text:', segments[0].sourceText.substring(0, 100));
        console.log('      Kind:', segments[0].kind);
      }
      return segments;
    } catch (error: any) {
      console.error('❌ Failed to extract segments:', error);
      throw new Error(`Failed to extract segments: ${error.message}`);
    }
  }

  /**
   * Inject translations into the original DOCX and build the output file
   * @param translations - Array of translations mapped to segment IDs
   * @returns Blob containing the modified DOCX
   */
  async injectTranslationsAndBuild(
    translations: { segmentId: string; targetText: string }[],
  ): Promise<Blob> {
    if (!this.originalDocxBuffer) {
      throw new Error('Original DOCX buffer not set');
    }

    console.log('\n💉 INJECTING TRANSLATIONS into original DOCX...');
    console.log('   📊 Translations to inject:', translations.length);
    if (translations.length > 0) {
      console.log('   📄 First translation preview:');
      console.log('      Segment ID:', translations[0].segmentId);
      console.log('      Text:', translations[0].targetText.substring(0, 100));
    }

    try {
      // Load ZIP file
      const zip = await JSZip.loadAsync(this.originalDocxBuffer);
      const documentXml = await zip.file('word/document.xml')?.async('text');

      if (!documentXml) {
        throw new Error('word/document.xml not found in DOCX');
      }

      // Parse XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(documentXml, 'application/xml');

      // Create a map for quick lookup
      const translationMap = new Map<string, string>();
      translations.forEach((t) =>
        translationMap.set(t.segmentId, t.targetText),
      );

      // Find all SDT elements
      const sdtElements = xmlDoc.querySelectorAll('sdt');
      let updatedCount = 0;

      sdtElements.forEach((sdt) => {
        // Check if locked
        const lockElement = sdt.querySelector(
          'sdtPr lock[w\\:val="sdtContentLocked"]',
        );
        if (lockElement) {
          return; // Skip locked SDTs (source cells must remain untouched)
        }

        // Get segment ID
        const tagElement = sdt.querySelector('sdtPr tag');
        const segmentId = tagElement?.getAttribute('w:val');

        if (!segmentId) {
          return;
        }

        // Check if we have a translation for this segment
        const translation = translationMap.get(segmentId);
        if (!translation) {
          return; // No translation for this segment
        }

        // Find the sdtContent
        const sdtContent = sdt.querySelector('sdtContent');
        if (!sdtContent) {
          console.warn('⚠️ No sdtContent found for segment:', segmentId);
          return;
        }

        // Find the paragraph inside sdtContent
        const paragraph = sdtContent.querySelector('p');
        if (!paragraph) {
          console.warn('⚠️ No paragraph found for segment:', segmentId);
          return;
        }

        // Preserve formatting from existing run if present
        const existingRun = paragraph.querySelector('r');
        let runProperties: Element | null = null;

        if (existingRun) {
          runProperties = existingRun
            .querySelector('rPr')
            ?.cloneNode(true) as Element;
        }

        // Remove all existing runs
        const runs = paragraph.querySelectorAll('r');
        runs.forEach((run) => run.remove());

        // Create new run with translation
        const newRun = xmlDoc.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'w:r',
        );

        // Add preserved formatting if it exists
        if (runProperties) {
          newRun.appendChild(runProperties);
        }

        // Create text element with translation
        const textElement = xmlDoc.createElementNS(
          'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'w:t',
        );

        // Add xml:space attribute properly
        textElement.setAttributeNS(
          'http://www.w3.org/XML/1998/namespace',
          'xml:space',
          'preserve',
        );
        textElement.textContent = translation;

        newRun.appendChild(textElement);
        paragraph.appendChild(newRun);

        updatedCount++;

        // Debug log for first few updates
        if (updatedCount <= 3) {
          console.log(`   ✓ Updated segment ${updatedCount}:`, {
            id: segmentId,
            text:
              translation.substring(0, 50) +
              (translation.length > 50 ? '...' : ''),
          });
        }
      });

      console.log('✅ Injection complete!');
      console.log(
        '   📊 Segments updated:',
        updatedCount,
        'out of',
        translations.length,
      );

      // Serialize XML back to string
      const serializer = new XMLSerializer();
      const updatedXml = serializer.serializeToString(xmlDoc);

      // Update the ZIP file with modified XML
      zip.file('word/document.xml', updatedXml);

      // Generate the final DOCX blob
      const blob = await zip.generateAsync({
        type: 'blob',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      console.log('✅ Modified DOCX ready!');
      console.log(
        '   📊 Output file size:',
        (blob.size / 1024).toFixed(2),
        'KB',
      );
      return blob;
    } catch (error: any) {
      console.error('❌ Failed to inject translations:', error);
      throw new Error(`Failed to inject translations: ${error.message}`);
    }
  }

  /**
   * Extract segments with their IDs from MXLIFF file
   * @returns Array of segments with ID, segment number, source text, and classification
   */
  async extractSegmentsFromMxliff(): Promise<Segment[]> {
    if (!this.originalBuffer) throw new Error('Original MXLIFF buffer not set');

    const decoder = new TextDecoder('utf-8');
    const xmlText = decoder.decode(this.originalBuffer);
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    if (xmlDoc.querySelector('parsererror'))
      throw new Error('Failed to parse MXLIFF XML');

    const bodyElement = xmlDoc.querySelector('body');
    if (!bodyElement)
      throw new Error('No <body> element found in MXLIFF file.');

    const transUnits = bodyElement.querySelectorAll('trans-unit');
    const segments: Segment[] = [];
    let segNum = 0;

    transUnits.forEach((transUnit) => {
      const id = transUnit.getAttribute('id');
      if (!id || !id.includes(':') || !/:\d+$/.test(id)) return;

      const isLocked = transUnit.getAttribute('m:locked') === 'true';
      const sourceText =
        transUnit.querySelector(':scope > source')?.textContent?.trim() ?? '';
      const kind = this.classifySegment(sourceText, isLocked);

      segments.push({ id, segNum: segNum++, sourceText, kind });
    });

    // Summary statistics
    const translateCount = segments.filter(
      (s) => s.kind === 'translate',
    ).length;
    const copySourceCount = segments.filter(
      (s) => s.kind === 'copy-source',
    ).length;
    const skipCount = segments.filter((s) => s.kind === 'skip').length;

    console.log(
      `\n📊 Extracted ${segments.length} segments (${translateCount} translate, ${copySourceCount} numbers, ${skipCount} empty)\n`,
    );

    return segments;
  }

  /**
   * Inject translations into MXLIFF file and return the modified blob
   * @param translations - Array of translations mapped to segment IDs
   * @returns Blob containing the modified MXLIFF
   */
  async injectTranslationsIntoMxliff(
    translations: { segmentId: string; targetText: string }[],
  ): Promise<Blob> {
    if (!this.originalBuffer) throw new Error('Original MXLIFF buffer not set');

    console.log('\n💉 ============ INJECTING TRANSLATIONS ============');
    console.log('   📊 AI translations received:', translations.length);

    const decoder = new TextDecoder('utf-8');
    const xmlText = decoder.decode(this.originalBuffer);
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    if (xmlDoc.querySelector('parsererror'))
      throw new Error('Failed to parse MXLIFF XML');

    // Map of AI translations
    const translationMap = new Map(
      translations.map((t) => [t.segmentId, t.targetText]),
    );

    const transUnits = xmlDoc.querySelectorAll('trans-unit');
    let aiTranslatedCount = 0;
    let notFoundCount = 0;

    transUnits.forEach((transUnit) => {
      const id = transUnit.getAttribute('id');
      if (!id) return;

      // Check if we have a translation from AI
      if (!translationMap.has(id)) {
        notFoundCount++;
        return;
      }

      const targetText = translationMap.get(id)!;
      aiTranslatedCount++;

      let targetElement = transUnit.querySelector(':scope > target');
      if (!targetElement) {
        targetElement = xmlDoc.createElement('target');
        const sourceElement = transUnit.querySelector(':scope > source');
        if (sourceElement) {
          sourceElement.after(targetElement);
        } else {
          transUnit.appendChild(targetElement);
        }
      }

      targetElement.textContent = targetText;
      transUnit.setAttribute('approved', 'yes');
    });

    console.log(`\n📊 ============ INJECTION SUMMARY ============`);
    console.log(`   ✅ Translated: ${aiTranslatedCount} segments`);
    console.log(
      `   ✅ Coverage: ${((aiTranslatedCount / transUnits.length) * 100).toFixed(1)}%`,
    );
    console.log(`\n`);

    const serializer = new XMLSerializer();
    const updatedXml = serializer.serializeToString(xmlDoc);
    return new Blob([updatedXml], { type: 'application/x-xliff+xml' });
  }
}
