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
  | 'copy-source'; // keep source as target (e.g. pure numbers, empty segments)

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
    // Step 1: Extract plain text (supports both DOCX and MXLIFF)
    const extractedText = await this.extractTextFromFile(file);

    // Step 2: Call AI
    const translatedText = await this.callProvider(
      provider,
      apiKey,
      customPrompt,
      extractedText,
      model,
    );
   

    // Step 3: Rebuild DOCX
    const blob = await this.buildDocx(translatedText);

    const originalName = file.name.replace(
      /\.(docx|mxlf|mxliff|xliff|xml)$/i,
      '',
    );
    const filename = `${originalName}_translated_${provider}.docx`;


    return {
      blob,
      filename,
      responseText: translatedText,
      fileType: this.originalFileType || 'docx',
    };
  }

  /**
   * Translate pre-formatted text segments directly (for retry/missing segments)
   * @param formattedText - Text already formatted with [Cell #N] markers
   * @param customPrompt - Translation prompt
   * @param provider - AI provider
   * @param apiKey - API key
   * @param model - Model ID
   * @returns AI response text (table format)
   */
  async translateFormattedText(
    formattedText: string,
    customPrompt: string,
    provider: Provider,
    apiKey: string,
    model = '',
  ): Promise<string> {

    // Call AI directly with formatted text
    const translatedText = await this.callProvider(
      provider,
      apiKey,
      customPrompt,
      formattedText,
      model,
    );


    return translatedText;
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
        // Fall back to mammoth if XML parsing didn't find source segments
        const rawResult = await mammoth.extractRawText({ arrayBuffer });
        return rawResult.value;
      }

      const result_text = sourceTexts.join('\n\n');
      return result_text;
    } catch (err: any) {
      throw new Error(`Failed to extract source text: ${err?.message || err}`);
    }
  }

  /**
   * Classify a segment based on its content (lock status is IGNORED)
   *
   * Classification rules:
   * - empty → 'copy-source' (copy empty string)
   * - pure numbers → 'copy-source' (123, 1234, etc.)
   * - EVERYTHING ELSE → 'translate' (single characters like "p", words, sentences, mixed content, formatted numbers, locked segments, etc.)
   *
   * NOTE: Locked segments are NO LONGER SKIPPED - they will be retranslated
   */
  private classifySegment(sourceText: string, isLocked: boolean): SegmentKind {
    const trimmed = sourceText.trim();

    // Rule 1: Empty segments → copy-source (will copy empty to empty)
    if (!trimmed) {
      return 'copy-source';
    }

    // Rule 2: Pure integer numbers only → copy-source
    // Examples that match: "123", "0", "999999"
    // Examples that DON'T match and WILL be translated: "1.5", "1,234", "50%", "Item 123", "{1}", "p", "A"
    if (/^\d+$/.test(trimmed)) {
      // console.log(`   🔢 COPY-SOURCE (pure number): "${trimmed}"`);
      return 'copy-source';
    }

    // Rule 3: EVERYTHING ELSE → translate
    // This includes: locked segments, single characters ("p", "A"), words, sentences, mixed content, formatted numbers, decimals, etc.
    const lockedNote = isLocked ? ' (locked - will retranslate)' : '';
    const lengthNote =
      trimmed.length === 1
        ? ' (single character)'
        : trimmed.length <= 3
          ? ' (short)'
          : '';
    // console.log(
    //   `   ✅ TRANSLATE${lockedNote}${lengthNote}: "${trimmed.substring(0, 50)}${trimmed.length > 50 ? '...' : ''}"`,
    // );
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
    const toTranslate = segments.filter((s) => s.kind === 'translate');

    // Format each segment with cell number for the AI
    const formattedSegments = toTranslate.map((s, idx) => {
      const cellNum = idx + 1;
      return `[Cell #${cellNum}]\n${s.sourceText}`;
    });

    const result = formattedSegments.join('\n\n');
    return result;
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

        // Show all segments (no skip category exists)
        segments.push({ source: sourceText, target: targetText });
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
      url = `https://phrase.runasp.net/api/Glossary/extract`;
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
        // generationConfig: { maxOutputTokens: 4096 },
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
    return blob;
  }

  /**
   * Store the original DOCX buffer for later manipulation
   * @param buffer - ArrayBuffer from the downloaded DOCX file
   */
  setOriginalDocxBuffer(buffer: ArrayBuffer): void {
    this.originalDocxBuffer = buffer;
  }

  /**
   * Store the original file buffer (MXLIFF or DOCX) for later manipulation
   * @param buffer - ArrayBuffer from the downloaded file
   */
  setOriginalBuffer(buffer: ArrayBuffer): void {
    this.originalBuffer = buffer;
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
      });

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

    // Map of copy-source segments (pure numbers → keep as-is)
    const allSegments = await this.extractSegmentsFromMxliff();
    const copySourceMap = new Map(
      allSegments
        .filter((s) => s.kind === 'copy-source')
        .map((s) => [s.id, s.sourceText]),
    );

    const transUnits = xmlDoc.querySelectorAll('trans-unit');
    let aiTranslatedCount = 0;
    let copiedCount = 0;

    transUnits.forEach((transUnit) => {
      const id = transUnit.getAttribute('id');
      if (!id) return;

      let targetText: string | undefined;
      let action: 'AI' | 'COPY' = 'AI';

      if (translationMap.has(id)) {
        targetText = translationMap.get(id)!;
        action = 'AI';
        aiTranslatedCount++;
      } else if (copySourceMap.has(id)) {
        targetText = copySourceMap.get(id)!;
        action = 'COPY';
        copiedCount++;
      } else {
        // This shouldn't happen if classification is correct
        return;
      }

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

    const serializer = new XMLSerializer();
    const updatedXml = serializer.serializeToString(xmlDoc);
    return new Blob([updatedXml], { type: 'application/x-xliff+xml' });
  }
}
