import { Injectable } from '@angular/core';
import * as mammoth from 'mammoth';
import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';

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
      const result = await mammoth.extractRawText({ arrayBuffer });
      if (result.messages?.length) {
        console.warn('⚠️ mammoth warnings:', result.messages);
      }
      return result.value;
    } catch (err: any) {
      throw new Error(`mammoth failed to parse DOCX: ${err?.message || err}`);
    }
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
      // Routed through local proxy to bypass Anthropic CORS restriction
      url = `${PROXY_BASE}/api/anthropic`;
      body = {
        apiKey,
        body: {
          model: model || 'claude-opus-4-20250514',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        },
      };
      extractFn = (d) => d.content[0].text;
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
}
