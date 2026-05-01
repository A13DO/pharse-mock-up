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
  async translateDocument(
    file: File,
    customPrompt: string,
    provider: Provider,
    apiKey: string,
    model = '',
  ): Promise<{ blob: Blob; filename: string; responseText: string }> {
    console.log(
      '🚀 Starting translation — provider:',
      provider,
      '— file:',
      file.name,
    );

    // Step 1: Extract plain text (supports both DOCX and MXLIFF)
    console.log('📖 Extracting text from file...');
    const extractedText = await this.extractTextFromFile(file);
    console.log('✅ Extracted', extractedText.length, 'chars');

    // Step 2: Call AI
    console.log('🤖 Calling', provider, 'API...');
    const userMessage = `INSTRUCTIONS: ${customPrompt}\n\nDOCUMENT:\n${extractedText}`;
    const translatedText = await this.callProvider(
      provider,
      apiKey,
      userMessage,
      model,
    );
    console.log('✅ Translation received:', translatedText.length, 'chars');

    // Step 3: Rebuild DOCX
    console.log('📝 Building DOCX...');
    const blob = await this.buildDocx(translatedText);
    console.log('✅ DOCX ready');

    const originalName = file.name.replace(/\.(docx|mxliff|xliff|xml)$/i, '');
    const filename = `${originalName}_translated_${provider}.docx`;
    return { blob, filename, responseText: translatedText };
  }

  /**
   * Extract text from any supported file type
   * @param file - DOCX or MXLIFF file
   * @returns Extracted plain text
   */
  async extractTextFromFile(file: File): Promise<string> {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.docx')) {
      return this.extractTextFromDocx(file);
    } else if (
      fileName.endsWith('.mxliff') ||
      fileName.endsWith('.xliff') ||
      fileName.endsWith('.xml')
    ) {
      return this.extractTextFromMxliff(file);
    } else {
      throw new Error(
        'Unsupported file type. Please upload a .docx or .mxliff file.',
      );
    }
  }

  /**
   * Extract raw text from DOCX file
   * For bilingual DOCX files, extracts text and filters out table headers/metadata
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
      // Extract HTML to get table structure
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (result.messages?.length) {
        console.warn('⚠️ mammoth warnings:', result.messages);
      }

      // Parse the HTML to extract table data
      const parser = new DOMParser();
      const htmlDoc = parser.parseFromString(result.value, 'text/html');

      // Look for tables (bilingual DOCX files use tables)
      const tables = htmlDoc.querySelectorAll('table');

      if (tables.length === 0) {
        // No tables found, fall back to raw text
        console.log('No tables found in DOCX, using raw text extraction');
        const rawResult = await mammoth.extractRawText({ arrayBuffer });
        return rawResult.value;
      }

      // Extract text from table cells and filter intelligently
      const extractedLines: string[] = [];
      const seenTexts = new Set<string>(); // Track duplicates

      tables.forEach((table) => {
        const rows = table.querySelectorAll('tr');

        rows.forEach((row, rowIndex) => {
          const cells = row.querySelectorAll('td, th');
          const cellTexts = Array.from(cells).map(
            (cell) => cell.textContent?.trim() || '',
          );

          // Skip header rows (first few rows typically contain column headers)
          if (rowIndex < 2) {
            return;
          }

          // For bilingual tables, deduplicate texts within the same row
          // (Source and Target columns may have identical text if not translated)
          const uniqueRowTexts = new Set<string>();

          cellTexts.forEach((text) => {
            if (this.isTranslatableContent(text) && !uniqueRowTexts.has(text)) {
              uniqueRowTexts.add(text);
            }
          });

          // Add unique texts from this row to the global list
          uniqueRowTexts.forEach((text) => {
            if (!seenTexts.has(text)) {
              seenTexts.add(text);
              extractedLines.push(text);
            }
          });
        });
      });

      const result_text = extractedLines.join('\n\n');
      console.log(
        `✅ Extracted ${extractedLines.length} translatable lines from DOCX (filtered from ${tables[0]?.querySelectorAll('tr').length || 0} table rows)`,
      );

      return result_text;
    } catch (err: any) {
      throw new Error(`mammoth failed to parse DOCX: ${err?.message || err}`);
    }
  }

  /**
   * Check if text content is translatable (filters out UI elements, metadata, etc.)
   */
  private isTranslatableContent(text: string): boolean {
    if (!text || text.trim().length < 3) {
      return false;
    }

    const trimmed = text.trim();

    // Exclude pure numbers
    if (/^\d+$/.test(trimmed)) {
      return false;
    }

    // Exclude UI/metadata keywords
    const uiKeywords = [
      'ID',
      'ICU',
      'Source',
      'Target',
      'Comment',
      'Memsource',
      'MT',
      'converter',
      'ace-arab',
      'ace',
      'read only',
      'locked',
      'upload',
      'grey',
      'background',
      'font',
      'segment',
      'Click here to enter',
    ];

    if (
      uiKeywords.some((keyword) =>
        trimmed.toLowerCase().includes(keyword.toLowerCase()),
      )
    ) {
      return false;
    }

    // Exclude segment ID patterns (e.g., "gnzwL54VVuaLadvq_dc9:0")
    if (/^[a-zA-Z0-9_-]+_dc\d+:\d+$/.test(trimmed)) {
      return false;
    }

    // Exclude language codes (e.g., "en", "en-US")
    if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(trimmed)) {
      return false;
    }

    // Exclude parenthetical metadata
    if (/^\([^)]+\)$/.test(trimmed)) {
      return false;
    }

    // Exclude very short abbreviations
    if (
      trimmed.length === 1 ||
      (trimmed.length === 2 && /^[A-Z#]+$/.test(trimmed))
    ) {
      return false;
    }

    return true;
  }

  /**
   * Extract translatable text from MXLIFF file
   * MXLIFF is an XML format used by translation tools
   */
  private async extractTextFromMxliff(file: File): Promise<string> {
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () =>
        reject(new Error(`FileReader failed: ${reader.error?.message}`));
      reader.readAsText(file, 'utf-8');
    });

    console.log('📄 MXLIFF file size:', text.length, 'chars');

    if (!text || text.trim().length === 0) {
      throw new Error('The MXLIFF file is empty.');
    }

    try {
      // Parse XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');

      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        throw new Error('Invalid XML format in MXLIFF file.');
      }

      // Extract text from <source> elements (original text to translate)
      // In XLIFF/MXLIFF format, <source> contains the source text
      const sourceElements = xmlDoc.querySelectorAll('source');

      if (sourceElements.length === 0) {
        throw new Error('No translatable content found in MXLIFF file.');
      }

      const extractedSegments: string[] = [];
      sourceElements.forEach((element) => {
        const content = element.textContent?.trim();
        if (content) {
          extractedSegments.push(content);
        }
      });

      if (extractedSegments.length === 0) {
        throw new Error('No text content found in MXLIFF source elements.');
      }

      console.log(
        `✅ Extracted ${extractedSegments.length} segments from MXLIFF`,
      );

      // Join segments with double newlines for readability
      return extractedSegments.join('\n\n');
    } catch (err: any) {
      throw new Error(`Failed to parse MXLIFF: ${err?.message || err}`);
    }
  }

  private async callProvider(
    provider: Provider,
    apiKey: string,
    userMessage: string,
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
      const encodedText = encodeURIComponent(userMessage);
      console.log(userMessage);

      url = `https://phrase.runasp.net/api/Glossary/extract?text=${encodedText}`;
      body = {};
      extractFn = (d) => d.result;
    } else if (provider === 'openai') {
      // Routed through local proxy to bypass OpenAI CORS restriction
      url = `${PROXY_BASE}/api/openai`;
      body = {
        apiKey,
        body: {
          model: model || 'gpt-4o',
          max_tokens: 4096,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        },
      };
      extractFn = (d) => d.choices[0].message.content;
    } else if (provider === 'gemini') {
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
      url = 'https://api.groq.com/openai/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = {
        model: model || 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      };
      extractFn = (d) => d.choices[0].message.content;
    }

    console.log('📤 POST', url);
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

    console.log('📥 Status:', response.status);

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
   * Extract segments with their Phrase segment IDs from the original DOCX
   * @returns Array of segments with ID, segment number, and source text
   */
  async extractSegmentsWithIds(): Promise<
    { id: string; segNum: number; sourceText: string }[]
  > {
    if (!this.originalDocxBuffer) {
      throw new Error('Original DOCX buffer not set');
    }

    console.log('🔍 Extracting segments with IDs from original DOCX...');

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
      const segments: { id: string; segNum: number; sourceText: string }[] = [];
      let segNum = 0;

      sdtElements.forEach((sdt) => {
        // Check if this SDT is locked (source cell or header)
        const lockElement = sdt.querySelector(
          'sdtPr lock[w\\:val="sdtContentLocked"]',
        );
        if (lockElement) {
          // Skip locked SDTs (source cells and headers)
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

        segments.push({
          id: segmentId,
          segNum: segNum++,
          sourceText: sourceText.trim(),
        });
      });

      console.log(`✅ Extracted ${segments.length} unlocked segments`);
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

    console.log('💉 Injecting translations into original DOCX...');

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
          return; // Skip locked SDTs
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
          return;
        }

        // Find the paragraph inside sdtContent
        const paragraph = sdtContent.querySelector('p');
        if (!paragraph) {
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
        textElement.setAttribute('xml:space', 'preserve');
        textElement.textContent = translation;

        newRun.appendChild(textElement);
        paragraph.appendChild(newRun);

        updatedCount++;
      });

      console.log(`✅ Injected ${updatedCount} translations`);

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

      console.log('✅ Modified DOCX ready');
      return blob;
    } catch (error: any) {
      console.error('❌ Failed to inject translations:', error);
      throw new Error(`Failed to inject translations: ${error.message}`);
    }
  }
}
